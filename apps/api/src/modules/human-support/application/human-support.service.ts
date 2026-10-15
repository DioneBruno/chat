import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService, Queryable } from '../../../database/database.service';
import { AttendancesService } from '../../attendances/attendances.service';
import { IntegrationInboxService } from '../../integration-inbox/integration-inbox.service';
import { MessagesService } from '../../messages/messages.service';
import { OutboxDispatcher } from '../../outbox/outbox.dispatcher';
import type { OutboxEvent } from '../../outbox/outbox.service';
import { RetryLater } from '../../outbox/outbox.errors';
import { OutboxService } from '../../outbox/outbox.service';
import { HUMAN_SUPPORT_PROVIDER } from '../domain/human-support-provider.interface';
import type { HumanSupportProvider } from '../domain/human-support-provider.interface';

export interface ChatwootWebhook {
  event: string;
  id?: number;
  message_type?: string;
  private?: boolean;
  content?: string;
  status?: string;
  conversation?: { id: number; status?: string };
  account?: { id: number };
}

interface HumanSession {
  id: string;
  tenantId: string;
  attendanceId: string;
  status: 'pending' | 'active' | 'ended' | 'failed';
  externalConversationId: string | null;
  externalContactId: string | null;
  externalSourceId: string | null;
  startedAfterSeq: string;
  contextSentAt: Date | null;
}

const SESSION_COLUMNS = `id, tenant_id AS "tenantId", attendance_id AS "attendanceId", status,
  external_conversation_id AS "externalConversationId", external_contact_id AS "externalContactId",
  external_source_id AS "externalSourceId", started_after_seq AS "startedAfterSeq", context_sent_at AS "contextSentAt"`;
const CLAIM_MS = 60_000;

/** Ciclo humano (seção 5): abre a conversa no Chatwoot, repassa mensagens e devolve ao bot. */
@Injectable()
export class HumanSupportService implements OnModuleInit {
  private readonly logger = new Logger(HumanSupportService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly attendances: AttendancesService,
    private readonly messages: MessagesService,
    private readonly inbox: IntegrationInboxService,
    private readonly outbox: OutboxService,
    private readonly dispatcher: OutboxDispatcher,
    @Inject(HUMAN_SUPPORT_PROVIDER)
    private readonly provider: HumanSupportProvider,
  ) {}

  onModuleInit() {
    this.dispatcher.register('human.conversation_requested', (e) =>
      this.establishConversation(e),
    );
    this.dispatcher.register('human.relay_message', (e) =>
      this.relayMessage(
        e.tenantId!,
        e.attendanceId!,
        String(e.payload.messageId),
      ),
    );
    this.dispatcher.register('integration.chatwoot_webhook', (e) =>
      this.processWebhook(String(e.payload.inboxId)),
    );
  }

  // ------------------------------------------------------------------ handoff

  /**
   * `human.conversation_requested`: cria contato/conversa, envia o contexto mínimo, confirma o
   * responsável (`handoff_pending` → `human`) e só então encaminha as mensagens guardadas.
   * Cada etapa grava seu progresso, então uma repetição do evento continua de onde parou.
   */
  async establishConversation(event: OutboxEvent): Promise<void> {
    const { tenantId, attendanceId } = event;
    const humanSessionId = String(event.payload.humanSessionId);
    let session = await this.getSession(this.db, tenantId!, humanSessionId);
    if (!session || session.status === 'ended' || session.status === 'failed')
      return;

    if (!session.externalConversationId) {
      try {
        const attendance = await this.attendances.get(tenantId!, attendanceId!);
        if (attendance.status !== 'open') return;
        const previous = await this.db.query<{
          contactId: string;
          sourceId: string;
        }>(
          `SELECT external_contact_id AS "contactId", external_source_id AS "sourceId" FROM human_sessions
            WHERE tenant_id = $1 AND attendance_id = $2 AND external_contact_id IS NOT NULL
            ORDER BY started_at DESC LIMIT 1`,
          [tenantId, attendanceId],
        );
        const conversation = await this.provider.createOrGetConversation({
          tenantId: tenantId!,
          attendanceId: attendanceId!,
          consumerId: attendance.consumerId,
          displayName: `Consumidor ${attendance.protocolNumber}`,
          existingContact: previous.rows[0]
            ? {
                externalContactId: previous.rows[0].contactId,
                externalSourceId: previous.rows[0].sourceId,
              }
            : undefined,
        });
        await this.db.query(
          `UPDATE human_sessions
              SET external_account_id = $3, external_inbox_id = $4, external_contact_id = $5,
                  external_source_id = $6, external_conversation_id = $7
            WHERE tenant_id = $1 AND id = $2 AND external_conversation_id IS NULL`,
          [
            tenantId,
            humanSessionId,
            conversation.externalAccountId,
            conversation.externalInboxId,
            conversation.externalContactId,
            conversation.externalSourceId,
            conversation.externalConversationId,
          ],
        );
      } catch (error) {
        // handoff_pending é recuperável: o outbox repete. Avisa o consumidor uma vez.
        if (event.attempts === 1)
          await this.messages
            .append({
              tenantId: tenantId!,
              attendanceId: attendanceId!,
              sender: 'system',
              content: {
                type: 'text',
                text: 'Não foi possível contatar um atendente agora; tentaremos novamente.',
              },
              idempotencyKey: `system:handoff-retry:${humanSessionId}`,
            })
            .catch(() => undefined);
        throw error;
      }
      session = (await this.getSession(this.db, tenantId!, humanSessionId))!;
    }

    if (!session.contextSentAt) {
      await this.provider.sendMessage({
        externalConversationId: session.externalConversationId!,
        messageId: `context:${humanSessionId}`,
        content: await this.contextNote(tenantId!, attendanceId!),
        private: true,
      });
      await this.db.query(
        'UPDATE human_sessions SET context_sent_at = now() WHERE tenant_id = $1 AND id = $2',
        [tenantId, humanSessionId],
      );
    }

    // Confirma o responsável: só agora a fase vira `human`.
    const activated = await this.db.tx(async (q) => {
      const att = await this.lockAttendance(q, tenantId!, attendanceId!);
      if (!att || att.status !== 'open') return false;
      const updated = await q.query(
        `UPDATE human_sessions SET status = 'active' WHERE tenant_id = $1 AND id = $2 AND status IN ('pending', 'active')`,
        [tenantId, humanSessionId],
      );
      if (!updated.rowCount) return false;
      if (att.phase === 'handoff_pending')
        await this.attendances.transitionPhaseIn(q, {
          tenantId: tenantId!,
          id: attendanceId!,
          to: 'human',
          expectedVersion: att.stateVersion,
        });
      return att.phase === 'handoff_pending' || att.phase === 'human';
    });
    if (activated) await this.flushQueued(tenantId!, attendanceId!, session);
  }

  /** Encaminha as mensagens do consumidor guardadas durante `handoff_pending` (nunca se perdem). */
  private async flushQueued(
    tenantId: string,
    attendanceId: string,
    session: HumanSession,
  ) {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT m.id FROM messages m
        WHERE m.tenant_id = $1 AND m.attendance_id = $2 AND m.sender_type = 'consumer' AND m.seq > $3
          AND NOT EXISTS (SELECT 1 FROM human_message_deliveries d WHERE d.message_id = m.id AND d.delivered_at IS NOT NULL)
        ORDER BY m.seq`,
      [tenantId, attendanceId, session.startedAfterSeq],
    );
    for (const row of rows)
      await this.relayMessage(tenantId, attendanceId, row.id);
  }

  /** Contexto mínimo permitido: só o texto da conversa, como nota interna (seção 5). */
  private async contextNote(tenantId: string, attendanceId: string) {
    const history = await this.messages.list({
      tenantId,
      attendanceId,
      limit: 100,
    });
    const lines = history
      .filter((m) => m.sender !== 'system' && m.content.type === 'text')
      .map(
        (m) =>
          `${m.sender === 'consumer' ? 'Consumidor' : m.sender === 'bot' ? 'Bot' : 'Atendente'}: ${(m.content as { text: string }).text}`,
      );
    return `Contexto do atendimento:\n${lines.join('\n') || '(sem mensagens anteriores)'}`;
  }

  // ------------------------------------------------------------------ mensagens

  /** Entrega uma mensagem do consumidor ao Chatwoot, no máximo uma vez por mensagem. */
  async relayMessage(
    tenantId: string,
    attendanceId: string,
    messageId: string,
  ): Promise<void> {
    const session = await this.db.query<HumanSession>(
      `SELECT ${SESSION_COLUMNS} FROM human_sessions
        WHERE tenant_id = $1 AND attendance_id = $2 AND status = 'active'`,
      [tenantId, attendanceId],
    );
    const human = session.rows[0];
    if (!human?.externalConversationId) return;
    const msg = await this.db.query<{ content: { text?: string } }>(
      `SELECT content FROM messages WHERE tenant_id = $1 AND attendance_id = $2 AND id = $3 AND sender_type = 'consumer'`,
      [tenantId, attendanceId, messageId],
    );
    const text = msg.rows[0]?.content.text;
    if (!text) return;

    // Posse da entrega: outro worker que já esteja enviando (lease) ou já entregue = não repete.
    const claim = await this.db.query(
      `INSERT INTO human_message_deliveries (tenant_id, message_id, human_session_id, claimed_until)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))
       ON CONFLICT (message_id) DO UPDATE SET claimed_until = EXCLUDED.claimed_until, human_session_id = EXCLUDED.human_session_id
         WHERE human_message_deliveries.delivered_at IS NULL AND human_message_deliveries.claimed_until < now()
       RETURNING message_id`,
      [tenantId, messageId, human.id, CLAIM_MS / 1000],
    );
    if (!claim.rowCount) {
      const delivered = await this.db.query(
        'SELECT 1 FROM human_message_deliveries WHERE message_id = $1 AND delivered_at IS NOT NULL',
        [messageId],
      );
      if (delivered.rowCount) return;
      throw new RetryLater('mensagem em entrega por outro worker', 2000);
    }
    try {
      const { externalMessageId } = await this.provider.sendMessage({
        externalConversationId: human.externalConversationId,
        messageId,
        content: text,
      });
      await this.db.query(
        'UPDATE human_message_deliveries SET delivered_at = now(), external_message_id = $2 WHERE message_id = $1',
        [messageId, externalMessageId],
      );
    } catch (error) {
      await this.db.query(
        'UPDATE human_message_deliveries SET claimed_until = now() WHERE message_id = $1 AND delivered_at IS NULL',
        [messageId],
      );
      throw error;
    }
  }

  // ------------------------------------------------------------------ webhook

  /** Recebe o webhook: deduplica no inbox e enfileira o processamento na mesma transação. */
  async receiveWebhook(
    payload: ChatwootWebhook,
  ): Promise<{ duplicate: boolean; accepted: boolean }> {
    const conversationId =
      payload.conversation?.id ??
      (payload.event?.startsWith('conversation') ? payload.id : undefined);
    if (!payload.event || conversationId === undefined)
      return { duplicate: false, accepted: false };
    const status = payload.status ?? payload.conversation?.status;
    const key =
      payload.event === 'message_created' && payload.id !== undefined
        ? `message:${payload.id}`
        : `${payload.event}:${conversationId}:${status ?? ''}`;
    return this.db.tx(async (q) => {
      const received = await this.inbox.receive(q, {
        provider: 'chatwoot',
        idempotencyKey: key,
        payload,
      });
      if (!received.duplicate)
        await this.outbox.enqueue(q, {
          type: 'integration.chatwoot_webhook',
          payload: { inboxId: received.id },
          dedupeKey: `integration.chatwoot_webhook:${received.id}`,
        });
      return { duplicate: received.duplicate, accepted: true };
    });
  }

  /** Mapeia o webhook ao ciclo humano; impede loops (eco das mensagens que nós enviamos). */
  async processWebhook(inboxId: string): Promise<void> {
    const entry = await this.inbox.get(inboxId);
    if (!entry || entry.status !== 'received') return;
    const payload = entry.payload as ChatwootWebhook;
    const conversationId = String(payload.conversation?.id ?? payload.id);

    const found = await this.db.query<HumanSession>(
      `SELECT ${SESSION_COLUMNS} FROM human_sessions WHERE external_conversation_id = $1`,
      [conversationId],
    );
    const human = found.rows[0];
    if (!human)
      return this.inbox.mark(inboxId, 'ignored', 'unknown_conversation');

    if (payload.event === 'message_created') {
      // Mensagens do consumidor (incoming) e notas privadas são nossas: voltam no webhook.
      if (payload.message_type !== 'outgoing' || payload.private)
        return this.inbox.mark(inboxId, 'ignored', 'not_agent_message');
      const stored = await this.db.tx(async (q) => {
        const att = await this.lockAttendance(
          q,
          human.tenantId,
          human.attendanceId,
        );
        const live = await this.getSession(q, human.tenantId, human.id);
        if (
          !att ||
          att.status !== 'open' ||
          att.phase !== 'human' ||
          live?.status !== 'active'
        )
          return false;
        await this.messages.appendIn(q, {
          tenantId: human.tenantId,
          attendanceId: human.attendanceId,
          sender: 'agent',
          content: { type: 'text', text: payload.content ?? '' },
          idempotencyKey: `chatwoot:message:${payload.id}`,
          externalIds: { chatwootMessageId: payload.id },
        });
        return true;
      });
      return this.inbox.mark(
        inboxId,
        stored ? 'processed' : 'ignored',
        stored ? undefined : 'wrong_phase',
      );
    }

    const status = payload.status ?? payload.conversation?.status;
    if (
      payload.event === 'conversation_status_changed' &&
      status === 'resolved'
    ) {
      const returned = await this.returnToBot(human);
      return this.inbox.mark(
        inboxId,
        returned ? 'processed' : 'ignored',
        returned ? undefined : 'wrong_phase',
      );
    }
    return this.inbox.mark(inboxId, 'ignored', 'event');
  }

  /**
   * Resolução no Chatwoot NÃO fecha o protocolo: encerra o ciclo humano, vai para
   * `returning_to_bot` e agenda uma NOVA sessão Typebot de pós-atendimento (seção 5).
   */
  private async returnToBot(human: HumanSession): Promise<boolean> {
    return this.db.tx(async (q) => {
      const att = await this.lockAttendance(
        q,
        human.tenantId,
        human.attendanceId,
      );
      const live = await this.getSession(q, human.tenantId, human.id);
      if (
        !att ||
        att.status !== 'open' ||
        att.phase !== 'human' ||
        live?.status !== 'active'
      )
        return false;
      await this.attendances.transitionPhaseIn(q, {
        tenantId: human.tenantId,
        id: human.attendanceId,
        to: 'returning_to_bot',
        expectedVersion: att.stateVersion,
      });
      await q.query(
        `UPDATE human_sessions SET status = 'ended', end_reason = 'resolved', ended_at = now() WHERE tenant_id = $1 AND id = $2`,
        [human.tenantId, human.id],
      );
      await this.outbox.enqueue(q, {
        tenantId: human.tenantId,
        attendanceId: human.attendanceId,
        type: 'bot.start_post_service',
        dedupeKey: `bot.start_post_service:${human.id}`,
      });
      return true;
    });
  }

  // ------------------------------------------------------------------ internos

  private async getSession(q: Queryable, tenantId: string, id: string) {
    const { rows } = await q.query<HumanSession>(
      `SELECT ${SESSION_COLUMNS} FROM human_sessions WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return rows[0] ?? null;
  }

  private async lockAttendance(q: Queryable, tenantId: string, id: string) {
    const { rows } = await q.query<{
      status: string;
      phase: string;
      stateVersion: number;
    }>(
      `SELECT status, phase, state_version AS "stateVersion" FROM attendances WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, id],
    );
    return rows[0] ?? null;
  }
}
