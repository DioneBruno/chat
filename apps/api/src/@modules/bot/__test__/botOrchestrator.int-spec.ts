/* eslint-disable @typescript-eslint/require-await -- fakes implementam contratos assíncronos */
import {
  ConflitoError,
  NaoAutorizadoError,
} from '@modules/shared/error/erroAplicacao';
import { createHarness } from '@modules/shared/database/testHarness';
import { TypebotApiError } from '@modules/bot/typebot/typebot.client';

type Harness = Awaited<ReturnType<typeof createHarness>>;

describe('orquestrador do bot (PostgreSQL real, Typebot falso)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.destroy());
  beforeEach(() => {
    h.botProvider.starts = [];
    h.botProvider.sessionCounter = 0;
    h.botProvider.continues = [];
    h.botProvider.onStart = undefined;
    h.botProvider.startError = undefined;
    h.botProvider.continueErrors = [];
  });

  const outboxOnly = async () => {
    for (let i = 0; i < 30; i++) if (!(await h.outboxWorker.runOnce())) return;
  };
  const sessions = async (attendanceId: string) =>
    (
      await h.db.query<{
        id: string;
        kind: string;
        status: string;
        provider_session_id: string | null;
        state_version: number;
      }>(
        'SELECT id, kind, status, provider_session_id, state_version FROM bot_sessions WHERE attendance_id = $1 ORDER BY created_at',
        [attendanceId],
      )
    ).rows;
  const texts = async (tenantId: string, attendanceId: string) =>
    (await h.messages.list({ tenantId, attendanceId })).map(
      (m) =>
        `${m.sender}:${m.content.type === 'text' ? m.content.text : m.content.type}`,
    );
  const consumerSays = (
    tenantId: string,
    attendanceId: string,
    text: string,
    optionId?: string,
    idempotencyKey?: string,
  ) =>
    h.messages.append({
      tenantId,
      attendanceId,
      sender: 'consumer',
      content: { type: 'text', text, ...(optionId ? { optionId } : {}) },
      idempotencyKey,
    });
  /** Atendimento novo com a sessão inicial do bot já ativa. */
  const started = async () => {
    const t = await h.newBotTenant();
    const o = await h.open(t.tenant.id, t.app.id);
    await h.drain();
    return {
      ...t,
      attendance: o.attendance,
      tenantId: t.tenant.id,
      id: o.attendance.id,
    };
  };

  describe('sessão inicial', () => {
    it('todo atendimento começa no Typebot: fluxo resolvido pelo servidor, mensagens persistidas', async () => {
      const a = await started();
      expect(h.botProvider.starts).toHaveLength(1);
      expect(h.botProvider.starts[0].flow).toMatchObject({
        externalFlowId: 'flow-initial',
        endpoint: 'http://typebot.test/api',
      });
      const [s] = await sessions(a.id);
      expect(s).toMatchObject({
        kind: 'initial',
        status: 'active',
        provider_session_id: 'ps-1',
      });
      expect(await texts(a.tenantId, a.id)).toEqual([
        'bot:Olá! Como posso ajudar?',
        'bot:options',
      ]);
      // A credencial de execução vai ao fluxo e amarra tenant, protocolo e sessão.
      const claims = h.tokens.verify(
        h.botProvider.starts[0].variables.botToken,
      );
      expect(claims).toMatchObject({
        tenantId: a.tenantId,
        attendanceId: a.id,
        botSessionId: s.id,
      });
      expect(await h.attendances.chatState(a.tenantId, a.id)).toEqual({
        pendingOperation: null,
        expecting: 'options',
      });
    });

    it('evento repetido não cria segunda sessão nem repete mensagens', async () => {
      const a = await started();
      await h.outbox.enqueue(h.db, {
        tenantId: a.tenantId,
        attendanceId: a.id,
        type: 'attendance.created',
        dedupeKey: 'reenvio-manual',
      });
      await h.drain();
      expect(h.botProvider.starts).toHaveLength(1);
      expect(await sessions(a.id)).toHaveLength(1);
      expect(await texts(a.tenantId, a.id)).toHaveLength(2);
    });

    it('falha ao iniciar: o outbox repete e a sessão que falhou fica registrada', async () => {
      const t = await h.newBotTenant();
      h.botProvider.startError = new Error('Typebot fora do ar');
      const o = await h.open(t.tenant.id, t.app.id);
      await outboxOnly();
      expect((await sessions(o.attendance.id)).map((s) => s.status)).toEqual([
        'failed',
      ]);
      h.botProvider.startError = undefined;
      await h.makeDue();
      await h.drain();
      expect((await sessions(o.attendance.id)).map((s) => s.status)).toEqual([
        'failed',
        'active',
      ]);
      expect(await texts(t.tenant.id, o.attendance.id)).toHaveLength(2);
    });

    it('variáveis pré-preenchidas vêm do cadastro do fluxo e nunca sobrescrevem a credencial', async () => {
      const t = await h.newBotTenant();
      await h.botConfig.registerFlow({
        tenantId: t.tenant.id,
        workspaceId: t.workspaceId,
        kind: 'initial',
        externalFlowId: 'flow-com-variaveis',
        prefilledVariables: {
          acao: 'test.read',
          chatId: 'forjado',
          botToken: 'forjado',
        },
      });
      const o = await h.open(t.tenant.id, t.app.id);
      await h.drain();
      const vars = h.botProvider.starts.at(-1)!.variables;
      expect(vars.acao).toBe('test.read');
      expect(vars.chatId).toBe(vars.botToken);
      expect(h.tokens.verify(vars.chatId).attendanceId).toBe(o.attendance.id);
    });

    it('sem fluxo habilitado não há sessão (nada é inventado)', async () => {
      const t = await h.newTenant(); // sem bot_flows
      const o = await h.open(t.tenant.id, t.app.id);
      await outboxOnly();
      expect(await sessions(o.attendance.id)).toHaveLength(0);
    });

    it('fluxo específico da aplicação vem antes do padrão da empresa', async () => {
      const t = await h.newBotTenant();
      await h.botConfig.registerFlow({
        tenantId: t.tenant.id,
        workspaceId: t.workspaceId,
        applicationId: t.app.id,
        kind: 'initial',
        externalFlowId: 'flow-app-especifico',
      });
      const flow = await h.resolver.resolve(t.tenant.id, t.app.id, 'initial');
      expect(flow.externalFlowId).toBe('flow-app-especifico');
      const outra = await h.tenants.createApplication(t.tenant.id, {
        slug: 'outra',
        name: 'Outra',
        channel: 'public_link',
      });
      expect(
        (await h.resolver.resolve(t.tenant.id, outra.id, 'initial'))
          .externalFlowId,
      ).toBe('flow-initial');
    });
  });

  describe('mensagens do consumidor', () => {
    it('roteia ao bot uma única vez, mesmo com evento duplicado', async () => {
      const a = await started();
      const { message } = await consumerSays(a.tenantId, a.id, 'quero ajuda');
      await h.drain();
      expect(h.botProvider.continues).toHaveLength(1);
      expect(h.botProvider.continues[0]).toMatchObject({
        providerSessionId: 'ps-1',
        text: 'quero ajuda',
      });
      // Reentrega do mesmo evento (outra chave de deduplicação): o marcador da sessão barra.
      await h.outbox.enqueue(h.db, {
        tenantId: a.tenantId,
        attendanceId: a.id,
        type: 'message.received',
        payload: { messageId: message.id, seq: message.seq },
        dedupeKey: 'replay',
      });
      await h.drain();
      expect(h.botProvider.continues).toHaveLength(1);
      expect(await texts(a.tenantId, a.id)).toContain(
        'bot:Recebi: quero ajuda',
      );
    });

    it('mesmas retentativas do navegador (idempotencyKey) geram uma só mensagem e um só avanço', async () => {
      const a = await started();
      await Promise.all(
        Array.from({ length: 5 }, () =>
          consumerSays(a.tenantId, a.id, 'oi', undefined, 'k-1'),
        ),
      );
      await h.drain();
      expect(h.botProvider.continues).toHaveLength(1);
    });

    it('escolha vale só para a etapa ativa; o texto enviado ao bot vem do servidor', async () => {
      const a = await started();
      await consumerSays(a.tenantId, a.id, 'texto forjado', 'opt-a');
      await h.drain();
      expect(h.botProvider.continues.map((c) => c.text)).toEqual([
        'Consultar solicitações',
      ]);

      // Agora a etapa ativa é um input de texto: a opção antiga não vale.
      await consumerSays(a.tenantId, a.id, 'opção velha', 'opt-a');
      await h.drain();
      expect(h.botProvider.continues).toHaveLength(1);
      expect(await texts(a.tenantId, a.id)).toContain(
        'system:Essa opção não está mais disponível.',
      );
    });

    it('falha ao avançar não repete às cegas: avisa o consumidor e aceita nova tentativa', async () => {
      const a = await started();
      h.botProvider.continueErrors = [new TypebotApiError('timeout', 0)];
      await consumerSays(a.tenantId, a.id, 'primeira');
      await h.drain();
      expect(h.botProvider.continues).toHaveLength(1); // sem retry automático
      expect(await texts(a.tenantId, a.id)).toContain(
        'system:Não consegui processar sua mensagem agora. Tente enviar novamente.',
      );
      expect((await sessions(a.id))[0].status).toBe('active');
      await consumerSays(a.tenantId, a.id, 'segunda');
      await h.drain();
      expect(h.botProvider.continues.map((c) => c.text)).toEqual([
        'primeira',
        'segunda',
      ]);
    });

    it('sessão perdida no Typebot (404) marca a sessão como failed', async () => {
      const a = await started();
      h.botProvider.continueErrors = [
        new TypebotApiError('session not found', 404),
      ];
      await consumerSays(a.tenantId, a.id, 'oi');
      await h.drain();
      expect((await sessions(a.id))[0].status).toBe('failed');
    });

    it('mensagens em ordem: a segunda só avança depois da primeira', async () => {
      const a = await started();
      await consumerSays(a.tenantId, a.id, 'um');
      await consumerSays(a.tenantId, a.id, 'dois');
      await consumerSays(a.tenantId, a.id, 'três');
      await h.drain();
      expect(h.botProvider.continues.map((c) => c.text)).toEqual([
        'um',
        'dois',
        'três',
      ]);
    });
  });

  describe('operações assíncronas', () => {
    const withOperation = async (action = 'test.read') => {
      const t = await h.newBotTenant();
      h.botProvider.onStart = async (input) => {
        // O que o bloco HTTP do Typebot faz dentro do startChat.
        await h.botOps.create(h.tokens.verify(input.variables.botToken), {
          action,
        });
      };
      const o = await h.open(t.tenant.id, t.app.id);
      await outboxOnly();
      h.botProvider.onStart = undefined;
      return { ...t, tenantId: t.tenant.id, id: o.attendance.id };
    };

    it('registra e retorna na hora; sessão aguarda; o resultado chega sem nova mensagem', async () => {
      const a = await withOperation();
      expect((await sessions(a.id))[0].status).toBe('waiting_operation');
      const state = await h.attendances.chatState(a.tenantId, a.id);
      expect(state.pendingOperation).toMatchObject({ status: 'pending' });
      expect(state.expecting).toBeNull(); // input oculto durante a espera

      await h.opsWorker.runOnce();
      await h.drain();
      expect(h.botProvider.continues.map((c) => c.text)).toEqual([
        'resultado da consulta',
      ]);
      expect((await sessions(a.id))[0].status).toBe('active');
      const op = (
        await h.db.query<{ status: string; resume_status: string }>(
          'SELECT status, resume_status FROM bot_operations WHERE attendance_id = $1',
          [a.id],
        )
      ).rows[0];
      expect(op).toEqual({ status: 'completed', resume_status: 'resumed' });
      expect(
        h.published.filter((p) => p.attendanceId === a.id).map((p) => p.event),
      ).toEqual(
        expect.arrayContaining([
          'bot.operation.started',
          'bot.operation.completed',
          'message.created',
        ]),
      );
    });

    it('operação que termina antes do commit do turno ainda retoma o fluxo', async () => {
      const t = await h.newBotTenant();
      h.botProvider.onStart = async (input) => {
        await h.botOps.create(h.tokens.verify(input.variables.botToken), {
          action: 'test.read',
        });
        await h.opsWorker.runOnce(); // conclui antes de o startSession persistir o turno
      };
      const o = await h.open(t.tenant.id, t.app.id);
      await h.drain();
      expect(h.botProvider.continues.map((c) => c.text)).toEqual([
        'resultado da consulta',
      ]);
      expect((await sessions(o.attendance.id))[0].status).toBe('active');
    });

    it('idempotência e uma operação bloqueante por sessão', async () => {
      const a = await withOperation();
      const claims = h.tokens.verify(
        h.botProvider.starts.at(-1)!.variables.botToken,
      );
      const again = await h.botOps.create(claims, { action: 'test.read' });
      const other = await h.botOps.create(claims, {
        action: 'test.read',
        idempotencyKey: 'outra',
      });
      const { rows } = await h.db.query(
        'SELECT id FROM bot_operations WHERE attendance_id = $1',
        [a.id],
      );
      expect(rows).toHaveLength(1);
      expect(again.operationId).toBe(rows[0].id);
      expect(other.operationId).toBe(rows[0].id);
    });

    it('ação fora da lista permitida é recusada', async () => {
      const a = await started();
      const claims = h.tokens.verify(
        h.botProvider.starts.at(-1)!.variables.botToken,
      );
      await expect(
        h.botOps.create(claims, { action: 'customer.delete_everything' }),
      ).rejects.toThrow('não permitida');
      expect(
        (
          await h.db.query(
            'SELECT 1 FROM bot_operations WHERE attendance_id = $1',
            [a.id],
          )
        ).rows,
      ).toHaveLength(0);
    });

    it('resultado tardio não altera protocolo encerrado', async () => {
      const a = await withOperation();
      await h.attendances.close({
        tenantId: a.tenantId,
        id: a.id,
        reason: 'bot_resolved',
        by: 'bot',
      });
      const before = await texts(a.tenantId, a.id);
      await h.opsWorker.runOnce();
      await h.drain();
      expect(await texts(a.tenantId, a.id)).toEqual(before);
      expect(h.botProvider.continues).toHaveLength(0);
      const op = (
        await h.db.query<{ status: string }>(
          'SELECT status FROM bot_operations WHERE attendance_id = $1',
          [a.id],
        )
      ).rows[0];
      expect(op.status).toBe('cancelled');
    });

    it('resultado tardio de sessão que mudou de estado é descartado (handoff cancela a consulta)', async () => {
      const a = await withOperation();
      const claims = h.tokens.verify(
        h.botProvider.starts.at(-1)!.variables.botToken,
      );
      await h.orchestrator.requestHandoff(claims);
      await h.opsWorker.runOnce();
      await outboxOnly();
      expect(h.botProvider.continues).toHaveLength(0);
      expect(await texts(a.tenantId, a.id)).not.toContain(
        'bot:resultado da consulta',
      );
    });

    it('falha: tenta de novo com backoff, depois retoma o fluxo com a mensagem de erro (uma vez)', async () => {
      h.registry.register({
        action: 'test.fail',
        mutating: false,
        maxAttempts: 2,
        execute: async () => {
          throw new Error('API da empresa fora do ar');
        },
      });
      const a = await withOperation('test.fail');
      await h.opsWorker.runOnce();
      let op = (
        await h.db.query<{ status: string; attempts: number }>(
          'SELECT status, attempts FROM bot_operations WHERE attendance_id = $1',
          [a.id],
        )
      ).rows[0];
      expect(op).toEqual({ status: 'pending', attempts: 1 }); // backoff
      await h.makeDue();
      await h.drain();
      op = (
        await h.db.query<{ status: string; attempts: number }>(
          'SELECT status, attempts FROM bot_operations WHERE attendance_id = $1',
          [a.id],
        )
      ).rows[0];
      expect(op).toEqual({ status: 'failed', attempts: 2 });
      expect(h.botProvider.continues.map((c) => c.text)).toEqual([
        'Não consegui consultar suas informações agora. Tente novamente mais tarde.',
      ]);
      expect(h.published.map((p) => p.event)).toContain('bot.operation.failed');
    });

    it('operação que muda estado externo nunca é repetida', async () => {
      let runs = 0;
      h.registry.register({
        action: 'test.mutate',
        mutating: true,
        execute: async () => {
          runs++;
          throw new Error('timeout');
        },
      });
      const a = await withOperation('test.mutate');
      await h.opsWorker.runOnce();
      await h.makeDue();
      await h.drain();
      expect(runs).toBe(1);
      expect(
        (
          await h.db.query<{ status: string }>(
            'SELECT status FROM bot_operations WHERE attendance_id = $1',
            [a.id],
          )
        ).rows[0].status,
      ).toBe('failed');
    });

    it('lease vencido: outro worker assume a operação de leitura', async () => {
      const a = await withOperation();
      await h.botOps.claim(1, 1); // worker "morre" com o lease de 1 ms
      await new Promise((r) => setTimeout(r, 30));
      await h.opsWorker.runOnce();
      await h.drain();
      const op = (
        await h.db.query<{ status: string; attempts: number }>(
          'SELECT status, attempts FROM bot_operations WHERE attendance_id = $1',
          [a.id],
        )
      ).rows[0];
      expect(op).toEqual({ status: 'completed', attempts: 2 });
    });

    it('falha ao retomar o Typebot: entrega o resultado direto e não repete o avanço', async () => {
      const a = await withOperation();
      h.botProvider.continueErrors = [new TypebotApiError('timeout', 0)];
      await h.opsWorker.runOnce();
      await h.drain();
      expect(h.botProvider.continues).toHaveLength(1);
      expect(await texts(a.tenantId, a.id)).toContain(
        'bot:resultado da consulta',
      );
      const op = (
        await h.db.query<{ resume_status: string }>(
          'SELECT resume_status FROM bot_operations WHERE attendance_id = $1',
          [a.id],
        )
      ).rows[0];
      expect(op.resume_status).toBe('fallback');
      expect((await sessions(a.id))[0].status).toBe('active');
    });
  });

  describe('credencial de execução do bot', () => {
    it('rejeita token adulterado, expirado ou sem escopo', async () => {
      const a = await started();
      const token = h.botProvider.starts.at(-1)!.variables.botToken;
      expect(() => h.tokens.verify(token + 'x')).toThrow(NaoAutorizadoError);
      expect(() => h.tokens.verify(undefined)).toThrow(NaoAutorizadoError);
      expect(() =>
        h.tokens.verify(token, Date.now() + 365 * 24 * 3600 * 1000),
      ).toThrow('expirada');
      const claims = h.tokens.verify(token);
      const semEscopo = { ...claims, scope: ['handoff'] };
      await expect(
        h.botOps.create(semEscopo, { action: 'test.read' }),
      ).rejects.toThrow('sem escopo');
      expect(a.id).toBe(claims.attendanceId);
    });

    it('credencial de um tenant não alcança atendimento de outro', async () => {
      const a = await started();
      const b = await started();
      const claimsA = h.tokens.verify(
        h.botProvider.starts.at(-2)!.variables.botToken,
      );
      expect(claimsA.attendanceId).toBe(a.id);
      // Claims forjadas: tenant de A com o atendimento/sessão de B.
      const [sessionB] = await sessions(b.id);
      const forged = {
        ...claimsA,
        attendanceId: b.id,
        botSessionId: sessionB.id,
      };
      await expect(
        h.botOps.create(forged, { action: 'test.read' }),
      ).rejects.toThrow(ConflitoError);
      await expect(h.orchestrator.requestHandoff(forged)).rejects.toThrow(
        ConflitoError,
      );
      expect((await h.attendances.get(b.tenantId, b.id)).phase).toBe('bot');
    });

    it('credencial morre junto com a sessão (protocolo encerrado)', async () => {
      const a = await started();
      const claims = h.tokens.verify(
        h.botProvider.starts.at(-1)!.variables.botToken,
      );
      await h.orchestrator.closeByBot(claims, 'resolvido');
      await expect(
        h.botOps.create(claims, { action: 'test.read' }),
      ).rejects.toThrow(ConflitoError);
      expect((await h.attendances.get(a.tenantId, a.id)).status).toBe('closed');
    });
  });

  describe('encerramento', () => {
    it('bot encerra: operações canceladas, sessões interrompidas, mensagens somente leitura; idempotente', async () => {
      const a = await started();
      const claims = h.tokens.verify(
        h.botProvider.starts.at(-1)!.variables.botToken,
      );
      await h.botOps.create(claims, { action: 'test.read' });
      expect(await h.orchestrator.closeByBot(claims, 'bot_resolved')).toEqual({
        closed: true,
      });
      expect(await h.orchestrator.closeByBot(claims, 'bot_resolved')).toEqual({
        closed: false,
      });
      const att = await h.attendances.get(a.tenantId, a.id);
      expect(att).toMatchObject({
        status: 'closed',
        closedBy: 'bot',
        closedReason: 'bot_resolved',
      });
      expect((await sessions(a.id))[0].status).toBe('interrupted');
      const op = (
        await h.db.query<{ status: string }>(
          'SELECT status FROM bot_operations WHERE attendance_id = $1',
          [a.id],
        )
      ).rows[0];
      expect(op.status).toBe('cancelled');
      await expect(consumerSays(a.tenantId, a.id, 'oi')).rejects.toThrow(
        ConflitoError,
      );
    });

    it('expiração por inatividade também interrompe sessões e cancela operações', async () => {
      const t = await h.newBotTenant({ generalInactivityMinutes: 1 });
      const o = await h.open(t.tenant.id, t.app.id);
      await h.drain();
      h.attendances.clock = () => new Date(Date.now() + 2 * 60_000);
      try {
        const expired = await h.attendances.expireDue();
        expect(expired.map((e) => e.id)).toContain(o.attendance.id);
      } finally {
        h.attendances.clock = () => new Date();
      }
      expect((await sessions(o.attendance.id))[0].status).toBe('interrupted');
      await h.drain();
      expect(h.published.map((p) => p.event)).toContain('attendance.updated');
    });
  });
});
