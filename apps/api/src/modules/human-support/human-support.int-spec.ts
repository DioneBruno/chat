import { createHarness } from '../../database/test-harness';

type Harness = Awaited<ReturnType<typeof createHarness>>;

describe('ciclo humano: bot → Chatwoot → bot (PostgreSQL real, provedores falsos)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.destroy());
  let base = 1000;
  /** Id da n-ésima conversa criada no teste corrente. */
  const c = (n: number) => String(base + n);
  beforeEach(() => {
    base += 100;
    h.humanProvider.nextId = base;
    h.botProvider.starts = [];
    h.botProvider.continues = [];
    h.botProvider.sessionCounter = 0;
    h.botProvider.onStart = undefined;
    h.botProvider.continueErrors = [];
    h.humanProvider.conversations = [];
    h.humanProvider.sent = [];
    h.humanProvider.createFailures = 0;
    h.humanProvider.sendFailures = 0;
  });

  const started = async (settings?: Parameters<Harness['newBotTenant']>[0]) => {
    const t = await h.newBotTenant(settings);
    const o = await h.open(t.tenant.id, t.app.id);
    await h.drain();
    const claims = h.tokens.verify(
      h.botProvider.starts.at(-1)!.variables.botToken,
    );
    return { tenantId: t.tenant.id, id: o.attendance.id, claims, app: t.app };
  };
  const say = (a: { tenantId: string; id: string }, text: string) =>
    h.messages.append({
      tenantId: a.tenantId,
      attendanceId: a.id,
      sender: 'consumer',
      content: { type: 'text', text },
    });
  const phase = async (a: { tenantId: string; id: string }) =>
    (await h.attendances.get(a.tenantId, a.id)).phase;
  const texts = async (a: { tenantId: string; id: string }) =>
    (await h.messages.list({ tenantId: a.tenantId, attendanceId: a.id })).map(
      (m) =>
        `${m.sender}:${m.content.type === 'text' ? m.content.text : m.content.type}`,
    );
  const humanSessions = async (id: string) =>
    (
      await h.db.query<{
        status: string;
        external_conversation_id: string | null;
        end_reason: string | null;
      }>(
        'SELECT status, external_conversation_id, end_reason FROM human_sessions WHERE attendance_id = $1 ORDER BY started_at',
        [id],
      )
    ).rows;
  const webhook = (payload: object) => h.human.receiveWebhook(payload as never);
  const toHuman = async (a: Awaited<ReturnType<typeof started>>) => {
    await h.orchestrator.requestHandoff(a.claims);
    await h.drain();
  };
  const agentSays = (conversation: string, id: number, content: string) =>
    webhook({
      event: 'message_created',
      id,
      message_type: 'outgoing',
      private: false,
      content,
      conversation: { id: Number(conversation) },
    });
  const resolve = (conversation: string) =>
    webhook({
      event: 'conversation_status_changed',
      id: Number(conversation),
      status: 'resolved',
    });

  describe('handoff', () => {
    it('pedido do bot vira handoff_pending, e o worker confirma o humano com o contexto', async () => {
      const a = await started();
      await say(a, 'preciso de ajuda com minha conta');
      await h.drain();
      await h.orchestrator.requestHandoff(a.claims);
      expect(await phase(a)).toBe('handoff_pending');
      expect(await humanSessions(a.id)).toMatchObject([{ status: 'pending' }]);

      await h.drain();
      expect(await phase(a)).toBe('human');
      expect(await humanSessions(a.id)).toMatchObject([
        { status: 'active', external_conversation_id: c(0) },
      ]);
      expect(h.humanProvider.sent).toHaveLength(1);
      expect(h.humanProvider.sent[0]).toMatchObject({
        private: true,
        conversationId: c(0),
      });
      expect(h.humanProvider.sent[0].content).toContain(
        'Consumidor: preciso de ajuda com minha conta',
      );
      expect(await texts(a)).toContain(
        'system:Transferindo para um atendente…',
      );
    });

    it('pedido repetido é idempotente: uma conversa, uma sessão humana', async () => {
      const a = await started();
      await Promise.all([
        h.orchestrator.requestHandoff(a.claims),
        h.orchestrator.requestHandoff(a.claims),
      ]);
      await h.orchestrator.requestHandoff(a.claims);
      await h.drain();
      expect(await humanSessions(a.id)).toHaveLength(1);
      expect(h.humanProvider.conversations).toHaveLength(1);
    });

    it('mensagens durante handoff_pending são guardadas e encaminhadas uma vez, em ordem', async () => {
      const a = await started();
      await h.orchestrator.requestHandoff(a.claims);
      await say(a, 'alguém aí?');
      await say(a, 'é urgente');
      await h.drain(); // roteia (guarda) e estabelece a conversa
      expect(await phase(a)).toBe('human');
      const forwarded = h.humanProvider.sent
        .filter((m) => !m.private)
        .map((m) => m.content);
      expect(forwarded).toEqual(['alguém aí?', 'é urgente']);
      // Reprocessar não reenvia.
      await h.human.relayMessage(
        a.tenantId,
        a.id,
        (
          await h.messages.list({ tenantId: a.tenantId, attendanceId: a.id })
        ).find((m) => m.sender === 'consumer')!.id,
      );
      expect(h.humanProvider.sent.filter((m) => !m.private)).toHaveLength(2);
    });

    it('mensagem na fase humana vai ao Chatwoot; o bot não é acionado', async () => {
      const a = await started();
      await toHuman(a);
      const continuesBefore = h.botProvider.continues.length;
      await say(a, 'olá atendente');
      await h.drain();
      expect(h.humanProvider.sent.at(-1)).toMatchObject({
        content: 'olá atendente',
        private: false,
      });
      expect(h.botProvider.continues).toHaveLength(continuesBefore);
    });

    it('Chatwoot indisponível: fica em handoff_pending, recupera sozinho, sem duplicar', async () => {
      const a = await started();
      h.humanProvider.createFailures = 2;
      await h.orchestrator.requestHandoff(a.claims);
      await say(a, 'ainda estou aqui');
      await h.drain();
      expect(await phase(a)).toBe('handoff_pending');
      expect(h.humanProvider.conversations).toHaveLength(0);
      for (let i = 0; i < 3 && (await phase(a)) !== 'human'; i++) {
        await h.makeDue();
        await h.drain();
      }
      expect(await phase(a)).toBe('human');
      expect(h.humanProvider.conversations).toHaveLength(1);
      expect(
        h.humanProvider.sent.filter((m) => !m.private).map((m) => m.content),
      ).toEqual(['ainda estou aqui']);
      // O aviso de nova tentativa aparece uma única vez.
      expect(
        (await texts(a)).filter((t) => t.includes('tentaremos novamente')),
      ).toHaveLength(1);
    });

    it('falha ao enviar a nota de contexto retoma de onde parou (sem criar outra conversa)', async () => {
      const a = await started();
      h.humanProvider.sendFailures = 1;
      await h.orchestrator.requestHandoff(a.claims);
      await h.drain();
      expect(await phase(a)).toBe('handoff_pending');
      await h.makeDue();
      await h.drain();
      expect(await phase(a)).toBe('human');
      expect(h.humanProvider.conversations).toHaveLength(1);
      expect(h.humanProvider.sent.filter((m) => m.private)).toHaveLength(1);
    });
  });

  describe('webhook do Chatwoot', () => {
    it('mensagem do atendente vira mensagem `agent`; entrega duplicada e eco são ignorados', async () => {
      const a = await started();
      await toHuman(a);
      expect(await agentSays(c(0), 7, 'Olá, sou a Ana')).toMatchObject({
        duplicate: false,
      });
      expect(await agentSays(c(0), 7, 'Olá, sou a Ana')).toMatchObject({
        duplicate: true,
      });
      // Eco do que enviamos (incoming) e nota privada: nunca viram mensagem (sem loop).
      await webhook({
        event: 'message_created',
        id: 8,
        message_type: 'incoming',
        content: 'eco',
        conversation: { id: Number(c(0)) },
      });
      await webhook({
        event: 'message_created',
        id: 9,
        message_type: 'outgoing',
        private: true,
        content: 'nota',
        conversation: { id: Number(c(0)) },
      });
      await h.drain();
      const agent = (await texts(a)).filter((t) => t.startsWith('agent:'));
      expect(agent).toEqual(['agent:Olá, sou a Ana']);
      // Nada do atendente é reenviado ao Chatwoot.
      expect(
        h.humanProvider.sent.filter((m) => m.content.includes('Ana')),
      ).toHaveLength(0);
    });

    it('conversa desconhecida é ignorada e registrada no inbox', async () => {
      await webhook({
        event: 'message_created',
        id: 50,
        message_type: 'outgoing',
        content: 'x',
        conversation: { id: 99999 },
      });
      await h.drain();
      const { rows } = await h.db.query<{ status: string; detail: string }>(
        "SELECT status, detail FROM integration_inbox WHERE idempotency_key = 'message:50'",
      );
      expect(rows[0]).toEqual({
        status: 'ignored',
        detail: 'unknown_conversation',
      });
    });

    it('mensagem de atendente fora da fase humana não é persistida', async () => {
      const a = await started();
      await toHuman(a);
      await resolve(c(0));
      await h.drain();
      await agentSays(c(0), 70, 'atrasada');
      await h.drain();
      expect((await texts(a)).some((t) => t.includes('atrasada'))).toBe(false);
    });
  });

  describe('retorno ao bot (pós-atendimento)', () => {
    const postServiceFlow = () => {
      h.botProvider.startTurn = (input) =>
        input.flow.externalFlowId === 'flow-post_service'
          ? {
              messages: [
                { type: 'text', text: 'Posso ajudar com mais alguma coisa?' },
              ],
              input: {
                type: 'options',
                options: [
                  { id: 'yes', label: 'Sim' },
                  { id: 'no', label: 'Não' },
                ],
              },
            }
          : {
              messages: [{ type: 'text', text: 'Olá!' }],
              input: { type: 'input', inputType: 'text input' },
            };
    };
    afterEach(() => {
      h.botProvider.startTurn = () => ({
        messages: [{ type: 'text', text: 'Olá! Como posso ajudar?' }],
        input: {
          type: 'options',
          options: [
            { id: 'opt-a', label: 'Consultar solicitações' },
            { id: 'opt-h', label: 'Falar com atendente' },
          ],
        },
      });
    });

    it('resolver no Chatwoot NÃO fecha o protocolo: nova sessão Typebot e prazo de 60 min', async () => {
      postServiceFlow();
      const a = await started();
      await toHuman(a);
      const t0 = new Date();
      h.attendances.clock = () => t0;
      try {
        await resolve(c(0));
        await h.drain();
      } finally {
        h.attendances.clock = () => new Date();
      }
      const att = await h.attendances.get(a.tenantId, a.id);
      expect(att).toMatchObject({ status: 'open', phase: 'post_service' });
      expect(att.inactivityDeadlineAt!.getTime()).toBe(
        t0.getTime() + 60 * 60_000,
      );

      const sessions = (
        await h.db.query<{
          kind: string;
          status: string;
          provider_session_id: string;
        }>(
          'SELECT kind, status, provider_session_id FROM bot_sessions WHERE attendance_id = $1 ORDER BY created_at',
          [a.id],
        )
      ).rows;
      expect(sessions.map((s) => s.kind)).toEqual(['initial', 'post_service']);
      expect(sessions[1]).toMatchObject({
        status: 'active',
        provider_session_id: 'ps-2',
      }); // NOVA sessão
      expect(sessions[0].status).not.toBe('active');
      expect(h.botProvider.starts.at(-1)!.flow.externalFlowId).toBe(
        'flow-post_service',
      );
      expect(await texts(a)).toContain(
        'bot:Posso ajudar com mais alguma coisa?',
      );
      expect((await humanSessions(a.id))[0]).toMatchObject({
        status: 'ended',
        end_reason: 'resolved',
      });
    });

    it('webhook de resolução repetido não cria segunda sessão de pós-atendimento', async () => {
      postServiceFlow();
      const a = await started();
      await toHuman(a);
      await resolve(c(0));
      await resolve(c(0));
      await webhook({
        event: 'conversation_status_changed',
        id: Number(c(0)),
        status: 'resolved',
        conversation: { id: Number(c(0)), status: 'resolved' },
      });
      await h.drain();
      const { rows } = await h.db.query(
        "SELECT 1 FROM bot_sessions WHERE attendance_id = $1 AND kind = 'post_service'",
        [a.id],
      );
      expect(rows).toHaveLength(1);
    });

    it('silêncio por 60 min encerra com post_service_inactivity (autor system)', async () => {
      postServiceFlow();
      const a = await started();
      await toHuman(a);
      await resolve(c(0));
      await h.drain();
      expect(
        (await h.attendances.expireDue()).filter((e) => e.id === a.id),
      ).toHaveLength(0); // ainda no prazo
      h.attendances.clock = () => new Date(Date.now() + 61 * 60_000);
      try {
        const expired = (await h.attendances.expireDue()).find(
          (e) => e.id === a.id,
        );
        expect(expired).toMatchObject({
          id: a.id,
          status: 'expired',
          closedReason: 'post_service_inactivity',
          closedBy: 'system',
        });
      } finally {
        h.attendances.clock = () => new Date();
      }
    });

    it('resposta do consumidor cancela o prazo e continua o fluxo do pós-atendimento', async () => {
      postServiceFlow();
      const a = await started();
      await toHuman(a);
      await resolve(c(0));
      await h.drain();
      await h.messages.append({
        tenantId: a.tenantId,
        attendanceId: a.id,
        sender: 'consumer',
        content: { type: 'text', text: 'Não', optionId: 'no' },
      });
      await h.drain();
      expect(h.botProvider.continues.at(-1)).toMatchObject({
        providerSessionId: 'ps-2',
        text: 'Não',
      });
      expect(
        (await h.attendances.get(a.tenantId, a.id)).inactivityDeadlineAt,
      ).toBeNull();
    });

    it('bot encerra após o "não": protocolo fechado, somente leitura', async () => {
      postServiceFlow();
      const a = await started();
      await toHuman(a);
      await resolve(c(0));
      await h.drain();
      const claims = h.tokens.verify(
        h.botProvider.starts.at(-1)!.variables.botToken,
      );
      await h.orchestrator.closeByBot(claims, 'consumer_declined_more_help');
      const att = await h.attendances.get(a.tenantId, a.id);
      expect(att).toMatchObject({
        status: 'closed',
        closedBy: 'bot',
        closedReason: 'consumer_declined_more_help',
      });
    });

    it('"sim" volta ao humano no mesmo protocolo, com nova conversa e o mesmo contato', async () => {
      postServiceFlow();
      const a = await started();
      await toHuman(a);
      await resolve(c(0));
      await h.drain();
      const claims = h.tokens.verify(
        h.botProvider.starts.at(-1)!.variables.botToken,
      );
      await h.orchestrator.requestHandoff(claims);
      await h.drain();
      expect(await phase(a)).toBe('human');
      expect(h.humanProvider.conversations).toHaveLength(2);
      expect(h.humanProvider.conversations[1]).toMatchObject({
        externalConversationId: c(1),
        existingContact: {
          externalContactId: 'contact-1',
          externalSourceId: 'source-1',
        },
      });
      expect((await humanSessions(a.id)).map((s) => s.status)).toEqual([
        'ended',
        'active',
      ]);
      // Só o novo ciclo recebe as mensagens e eventos.
      await agentSays(c(0), 80, 'ciclo antigo');
      await agentSays(c(1), 81, 'ciclo novo');
      await h.drain();
      const agent = (await texts(a)).filter((t) => t.startsWith('agent:'));
      expect(agent).toEqual(['agent:ciclo novo']);
    });

    it('falha ao iniciar o pós-atendimento: fica em returning_to_bot e recupera pelo outbox', async () => {
      postServiceFlow();
      const a = await started();
      await toHuman(a);
      h.botProvider.startError = new Error('Typebot indisponível');
      await resolve(c(0));
      await h.drain();
      expect(await phase(a)).toBe('returning_to_bot');
      h.botProvider.startError = undefined;
      await h.makeDue();
      await h.drain();
      expect(await phase(a)).toBe('post_service');
      expect(await texts(a)).toContain(
        'bot:Posso ajudar com mais alguma coisa?',
      );
    });
  });

  describe('isolamento e encerramento', () => {
    it('protocolo encerrado durante o handoff encerra a sessão humana e descarta o resto', async () => {
      const a = await started();
      await h.orchestrator.requestHandoff(a.claims);
      await h.attendances.close({
        tenantId: a.tenantId,
        id: a.id,
        reason: 'x',
        by: 'system',
      });
      await h.drain();
      expect(h.humanProvider.conversations).toHaveLength(0);
      expect(await humanSessions(a.id)).toMatchObject([{ status: 'ended' }]);
    });

    it('conversa do Chatwoot de um tenant não afeta atendimento de outro', async () => {
      const a = await started();
      const b = await started();
      await toHuman(a);
      await toHuman(b);
      await agentSays(c(0), 90, 'para A');
      await agentSays(c(1), 91, 'para B');
      await h.drain();
      expect((await texts(a)).filter((t) => t.startsWith('agent:'))).toEqual([
        'agent:para A',
      ]);
      expect((await texts(b)).filter((t) => t.startsWith('agent:'))).toEqual([
        'agent:para B',
      ]);
    });

    it('FKs compostas impedem sessão de bot com fluxo de outro tenant', async () => {
      const a = await started();
      const b = await started();
      const flowB = (
        await h.db.query<{ id: string }>(
          'SELECT id FROM bot_flows WHERE tenant_id = $1 LIMIT 1',
          [b.tenantId],
        )
      ).rows[0].id;
      await expect(
        h.db.query(
          `INSERT INTO bot_sessions (tenant_id, attendance_id, bot_flow_id, kind, status) VALUES ($1, $2, $3, 'auxiliary', 'completed')`,
          [a.tenantId, a.id, flowB],
        ),
      ).rejects.toThrow(/foreign key/);
    });
  });
});
