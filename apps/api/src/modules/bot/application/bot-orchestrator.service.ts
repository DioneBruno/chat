import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { DatabaseService, Queryable } from '../../../database/database.service';
import { AttendancesService } from '../../attendances/attendances.service';
import { MessagesService } from '../../messages/messages.service';
import type { MessageContent } from '../../messages/messages.service';
import { OutboxDispatcher } from '../../outbox/outbox.dispatcher';
import { RetryLater } from '../../outbox/outbox.errors';
import { OutboxService } from '../../outbox/outbox.service';
import { BOT_PROVIDER } from '../domain/bot-provider.interface';
import type {
  BotProvider,
  BotTurnResult,
  PendingInput,
} from '../domain/bot-provider.interface';
import { TypebotApiError } from '../infrastructure/typebot/typebot.client';
import {
  BotExecutionClaims,
  BotExecutionTokenService,
} from './bot-execution-token.service';
import { BotFlowResolverService } from './bot-flow-resolver.service';
import type { FlowKind, ResolvedFlow } from './bot-flow-resolver.service';

export type BotSessionStatus =
  | 'starting'
  | 'active'
  | 'waiting_operation'
  | 'completed'
  | 'interrupted'
  | 'failed';

interface SessionRow {
  id: string;
  kind: FlowKind;
  status: BotSessionStatus;
  providerSessionId: string | null;
  pendingInput: PendingInput | null;
  lastProcessedSeq: string;
  stateVersion: number;
  botFlowId: string;
}

interface AttendanceLock {
  status: 'open' | 'closed' | 'expired';
  phase: string;
  stateVersion: number;
  applicationId: string;
}

const SESSION_COLUMNS = `id, kind, status, provider_session_id AS "providerSessionId", pending_input AS "pendingInput",
  last_processed_seq AS "lastProcessedSeq", state_version AS "stateVersion", bot_flow_id AS "botFlowId"`;
const LIVE = `('starting', 'active', 'waiting_operation')`;

export const OPERATION_FAILED_TEXT =
  'Não consegui consultar suas informações agora. Tente novamente mais tarde.';
const SESSION_LOST_TEXT =
  'Não foi possível continuar o atendimento automático agora. Um atendente poderá ajudar.';
const TURN_FAILED_TEXT =
  'Não consegui processar sua mensagem agora. Tente enviar novamente.';
const STALE_OPTION_TEXT = 'Essa opção não está mais disponível.';

/**
 * Responsável pela fase `bot`/`post_service` (seções 3 e 5): inicia sessões Typebot,
 * roteia mensagens do consumidor, retoma após operações assíncronas e responde aos
 * pedidos do fluxo (handoff, encerramento). Nunca mantém transação aberta durante
 * chamadas HTTP; avanços do mesmo atendimento são seriais porque os eventos chegam
 * pelo outbox, que processa um evento por atendimento por vez.
 */
@Injectable()
export class BotOrchestratorService implements OnModuleInit {
  private readonly logger = new Logger(BotOrchestratorService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly attendances: AttendancesService,
    private readonly messages: MessagesService,
    private readonly resolver: BotFlowResolverService,
    private readonly tokens: BotExecutionTokenService,
    private readonly outbox: OutboxService,
    private readonly dispatcher: OutboxDispatcher,
    @Inject(BOT_PROVIDER) private readonly provider: BotProvider,
  ) {}

  onModuleInit() {
    this.dispatcher.register('attendance.created', (e) =>
      this.startSession({
        tenantId: e.tenantId!,
        attendanceId: e.attendanceId!,
        kind: 'initial',
      }),
    );
    this.dispatcher.register('bot.start_post_service', (e) =>
      this.startSession({
        tenantId: e.tenantId!,
        attendanceId: e.attendanceId!,
        kind: 'post_service',
      }),
    );
    this.dispatcher.register('message.received', (e) =>
      this.routeConsumerMessage({
        tenantId: e.tenantId!,
        attendanceId: e.attendanceId!,
        messageId: String(e.payload.messageId),
        seq: Number(e.payload.seq),
      }),
    );
    this.dispatcher.register('bot.operation.resume', (e) =>
      this.resumeAfterOperation(e.tenantId!, String(e.payload.operationId)),
    );
  }

  // ------------------------------------------------------------------ sessões

  /**
   * Cria a sessão (linha `starting` antes da chamada externa: o bloco HTTP do Typebot
   * roda dentro do `startChat` e já precisa do id), inicia no Typebot e persiste o
   * primeiro turno. Reexecutável: uma sessão `starting` abandonada é substituída.
   */
  async startSession(input: {
    tenantId: string;
    attendanceId: string;
    kind: 'initial' | 'post_service';
  }): Promise<void> {
    const prepared = await this.db.tx(async (q) => {
      const att = await this.lockAttendance(
        q,
        input.tenantId,
        input.attendanceId,
      );
      if (!att || att.status !== 'open') return null;
      // Outro fluxo já avançou a fase: evento repetido/atrasado, nada a fazer.
      if (att.phase !== (input.kind === 'initial' ? 'bot' : 'returning_to_bot'))
        return null;
      const live = await q.query<SessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM bot_sessions
          WHERE tenant_id = $1 AND attendance_id = $2 AND status IN ${LIVE} FOR UPDATE`,
        [input.tenantId, input.attendanceId],
      );
      if (live.rows.some((s) => s.kind === input.kind && s.providerSessionId))
        return null;
      await this.interruptSessions(
        q,
        input.tenantId,
        live.rows.map((s) => s.id),
      );

      const flow = await this.resolver.resolve(
        input.tenantId,
        att.applicationId,
        input.kind,
        q,
      );
      // Sessões de pós-atendimento só enxergam mensagens posteriores a elas.
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO bot_sessions (tenant_id, attendance_id, bot_flow_id, kind, last_processed_seq)
         VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'initial' THEN 0
                 ELSE (SELECT COALESCE(max(seq), 0) FROM messages WHERE tenant_id = $1 AND attendance_id = $2) END)
         RETURNING id`,
        [input.tenantId, input.attendanceId, flow.id, input.kind],
      );
      return { botSessionId: rows[0].id, flow };
    });
    if (!prepared) return;

    // Fora de transação: a chamada ao Typebot pode demorar e disparar o bloco HTTP.
    const credential = this.tokens.issue({
      tenantId: input.tenantId,
      attendanceId: input.attendanceId,
      botSessionId: prepared.botSessionId,
      scope: ['operations', 'handoff', 'close'],
    });
    let turn: BotTurnResult;
    try {
      turn = await this.provider.startSession({
        flow: prepared.flow,
        // `chatId` é o nome da variável nos fluxos das POCs; hoje carrega a credencial.
        variables: {
          ...prepared.flow.prefilledVariables,
          chatId: credential,
          botToken: credential,
        },
      });
    } catch (error) {
      await this.markSession(
        prepared.botSessionId,
        input.tenantId,
        ['starting'],
        'failed',
      );
      throw error; // o outbox repete; a sessão `failed` fica registrada
    }
    const committed = await this.commitTurn({
      tenantId: input.tenantId,
      attendanceId: input.attendanceId,
      botSessionId: prepared.botSessionId,
      expect: ['starting'],
      turn,
    });
    if (!committed)
      this.logger.warn(
        `turno inicial descartado (atendimento/sessão mudou) attendance=${input.attendanceId} session=${prepared.botSessionId}`,
      );
  }

  // ------------------------------------------------------------------ mensagens

  async routeConsumerMessage(input: {
    tenantId: string;
    attendanceId: string;
    messageId: string;
    seq: number;
  }): Promise<void> {
    const attendance = await this.attendances.get(
      input.tenantId,
      input.attendanceId,
    );
    if (attendance.status !== 'open') return;
    switch (attendance.phase) {
      case 'bot':
      case 'post_service':
        return this.routeToBot(input);
      case 'human':
        await this.outbox.enqueue(this.db, {
          tenantId: input.tenantId,
          attendanceId: input.attendanceId,
          type: 'human.relay_message',
          payload: { messageId: input.messageId },
          dedupeKey: `human.relay_message:${input.messageId}`,
        });
        return;
      default:
        // handoff_pending: guardada, encaminhada ao confirmar o humano (nunca se perde).
        // returning_to_bot/awaiting_business_hours: ficam só no histórico.
        return;
    }
  }

  private async routeToBot(input: {
    tenantId: string;
    attendanceId: string;
    messageId: string;
    seq: number;
  }) {
    // 1) Reivindica a mensagem numa transação curta: o marcador `last_processed_seq`
    //    impede reprocessar o mesmo evento e processar fora de ordem.
    const claim = await this.db.tx(async (q) => {
      const att = await this.lockAttendance(
        q,
        input.tenantId,
        input.attendanceId,
      );
      if (!att || att.status !== 'open') return null;
      const { rows } = await q.query<SessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM bot_sessions
          WHERE tenant_id = $1 AND attendance_id = $2 AND status IN ${LIVE} FOR UPDATE`,
        [input.tenantId, input.attendanceId],
      );
      const session = rows[0];
      if (!session) return null;
      if (session.status === 'starting')
        throw new RetryLater('sessão do bot ainda iniciando', 500);
      // Durante uma operação assíncrona o input fica oculto; a mensagem só entra no histórico.
      if (session.status !== 'active') return null;
      if (Number(session.lastProcessedSeq) >= input.seq) return null;

      const msg = await q.query<{
        content: { text?: string; optionId?: string };
      }>(
        `SELECT content FROM messages WHERE tenant_id = $1 AND attendance_id = $2 AND id = $3 AND sender_type = 'consumer'`,
        [input.tenantId, input.attendanceId, input.messageId],
      );
      if (!msg.rows[0]) return null;
      const content = msg.rows[0].content;
      const pending = session.pendingInput;
      const advance = () =>
        q.query(
          `UPDATE bot_sessions SET last_processed_seq = $3, last_processed_message_id = $4,
                  state_version = state_version + 1, updated_at = now()
            WHERE tenant_id = $1 AND id = $2`,
          [input.tenantId, session.id, input.seq, input.messageId],
        );

      let text = content.text ?? '';
      if (content.optionId !== undefined) {
        // Escolha vale só para a etapa ativa; o texto enviado ao bot vem do servidor.
        const option =
          pending?.type === 'options'
            ? pending.options.find((o) => o.id === content.optionId)
            : undefined;
        if (!option) {
          await advance();
          await this.messages.appendIn(q, {
            tenantId: input.tenantId,
            attendanceId: input.attendanceId,
            sender: 'system',
            content: { type: 'text', text: STALE_OPTION_TEXT },
            idempotencyKey: `system:stale-option:${input.messageId}`,
          });
          return null;
        }
        text = option.label;
      }
      await advance();
      return { session, text };
    });
    if (!claim) return;

    // 2) Fora de transação. Timeout/erro não se repete às cegas: o Typebot pode ter processado.
    const flow = await this.flowOf(input.tenantId, claim.session.botFlowId);
    try {
      const turn = await this.provider.continueSession({
        endpoint: flow.endpoint,
        credentialsRef: flow.credentialsRef,
        providerSessionId: claim.session.providerSessionId!,
        text: claim.text,
      });
      await this.commitTurn({
        tenantId: input.tenantId,
        attendanceId: input.attendanceId,
        botSessionId: claim.session.id,
        expect: ['active'],
        turn,
      });
    } catch (error) {
      await this.onTurnFailure(input, claim.session, error);
    }
  }

  private async onTurnFailure(
    input: { tenantId: string; attendanceId: string; messageId: string },
    session: SessionRow,
    error: unknown,
  ) {
    const definitiveLoss =
      error instanceof TypebotApiError &&
      (error.status === 404 || error.status === 410);
    this.logger.error(
      `turno do bot falhou attendance=${input.attendanceId} session=${session.id}: ${(error as Error).message}`,
    );
    await this.db.tx(async (q) => {
      const att = await this.lockAttendance(
        q,
        input.tenantId,
        input.attendanceId,
      );
      if (!att || att.status !== 'open') return;
      if (definitiveLoss)
        await q.query(
          `UPDATE bot_sessions SET status = 'failed', ended_at = now(), state_version = state_version + 1, updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND status IN ${LIVE}`,
          [input.tenantId, session.id],
        );
      await this.messages.appendIn(q, {
        tenantId: input.tenantId,
        attendanceId: input.attendanceId,
        sender: 'system',
        content: {
          type: 'text',
          text: definitiveLoss ? SESSION_LOST_TEXT : TURN_FAILED_TEXT,
        },
        idempotencyKey: `system:turn-failed:${input.messageId}`,
      });
    });
  }

  // ------------------------------------------------------------------ operações

  /**
   * Retoma o fluxo com o resultado da operação (evento `bot.operation.resume`).
   * `resume_status` impede chamar o avanço do Typebot duas vezes; se uma tentativa
   * anterior ficou `resuming` (resultado desconhecido), entrega direto em vez de repetir.
   */
  async resumeAfterOperation(
    tenantId: string,
    operationId: string,
  ): Promise<void> {
    const mode = process.env.ASYNC_RESUME_MODE ?? 'continue';
    const claim = await this.db.tx(async (q) => {
      const op = await q.query<{
        attendanceId: string;
        botSessionId: string;
        status: string;
        resumeStatus: string | null;
        result: { text?: string } | null;
      }>(
        `SELECT attendance_id AS "attendanceId", bot_session_id AS "botSessionId", status,
                resume_status AS "resumeStatus", result
           FROM bot_operations WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, operationId],
      );
      const o = op.rows[0];
      if (!o || !['completed', 'failed'].includes(o.status)) return null;
      if (o.resumeStatus === 'resumed' || o.resumeStatus === 'fallback')
        return null;
      const att = await this.lockAttendance(q, tenantId, o.attendanceId);
      if (!att || att.status !== 'open') return null; // resultado tardio não altera protocolo encerrado
      const sessions = await q.query<SessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM bot_sessions WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, o.botSessionId],
      );
      const session = sessions.rows[0];
      // Sessão que mudou de estado (handoff, encerramento, nova sessão) descarta o resultado.
      if (!session || session.status !== 'waiting_operation') return null;
      if (!session.providerSessionId)
        throw new RetryLater('sessão ainda sem id no Typebot', 1000);

      const text =
        o.status === 'completed'
          ? (o.result?.text ?? '')
          : OPERATION_FAILED_TEXT;
      const unknownOutcome = o.resumeStatus === 'resuming';
      if (mode === 'direct' || unknownOutcome) {
        await this.deliverDirect(
          q,
          tenantId,
          o.attendanceId,
          session,
          operationId,
          text,
        );
        return null;
      }
      await q.query(
        `UPDATE bot_operations SET resume_status = 'resuming' WHERE tenant_id = $1 AND id = $2`,
        [tenantId, operationId],
      );
      return { attendanceId: o.attendanceId, session, text };
    });
    if (!claim) return;

    const flow = await this.flowOf(tenantId, claim.session.botFlowId);
    try {
      const turn = await this.provider.continueSession({
        endpoint: flow.endpoint,
        credentialsRef: flow.credentialsRef,
        providerSessionId: claim.session.providerSessionId!,
        text: claim.text,
      });
      await this.commitTurn({
        tenantId,
        attendanceId: claim.attendanceId,
        botSessionId: claim.session.id,
        expect: ['waiting_operation'],
        turn,
        onCommit: (q) =>
          q
            .query(
              `UPDATE bot_operations SET resume_status = 'resumed' WHERE tenant_id = $1 AND id = $2`,
              [tenantId, operationId],
            )
            .then(() => undefined),
      });
    } catch (error) {
      // Sem repetição às cegas: entrega o resultado diretamente (fallback validado na POC #2).
      this.logger.error(
        `retomada falhou operation=${operationId}: ${(error as Error).message}`,
      );
      await this.db.tx(async (q) => {
        const att = await this.lockAttendance(q, tenantId, claim.attendanceId);
        if (!att || att.status !== 'open') return;
        await this.deliverDirect(
          q,
          tenantId,
          claim.attendanceId,
          claim.session,
          operationId,
          claim.text,
        );
      });
    }
  }

  private async deliverDirect(
    q: Queryable,
    tenantId: string,
    attendanceId: string,
    session: SessionRow,
    operationId: string,
    text: string,
  ) {
    await this.messages.appendIn(q, {
      tenantId,
      attendanceId,
      sender: 'bot',
      content: { type: 'text', text },
      idempotencyKey: `op:${operationId}:result`,
    });
    await q.query(
      `UPDATE bot_operations SET resume_status = 'fallback' WHERE tenant_id = $1 AND id = $2`,
      [tenantId, operationId],
    );
    await q.query(
      `UPDATE bot_sessions SET status = 'active', state_version = state_version + 1, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND status = 'waiting_operation'`,
      [tenantId, session.id],
    );
  }

  // ------------------------------------------------------------------ pedidos do fluxo

  /** Bot pede humano: só registra o pedido; o Chatwoot é acionado pelo worker (seção 12). */
  async requestHandoff(claims: BotExecutionClaims): Promise<{ phase: string }> {
    return this.db.tx(async (q) => {
      const att = await this.lockAttendance(
        q,
        claims.tenantId,
        claims.attendanceId,
      );
      if (!att || att.status !== 'open')
        throw new ConflictException('atendimento inexistente ou encerrado');
      await this.requireLiveSession(q, claims);
      if (att.phase === 'handoff_pending' || att.phase === 'human')
        return { phase: att.phase }; // idempotente

      await this.attendances.transitionPhaseIn(q, {
        tenantId: claims.tenantId,
        id: claims.attendanceId,
        to: 'handoff_pending',
        expectedVersion: att.stateVersion,
      });
      // Pedir humano com consulta em andamento cancela a consulta (comportamento provisório, pendência 19.9).
      await q.query(
        `UPDATE bot_operations SET status = 'cancelled', completed_at = now(), lease_expires_at = NULL
          WHERE tenant_id = $1 AND bot_session_id = $2 AND status IN ('pending', 'processing')`,
        [claims.tenantId, claims.botSessionId],
      );
      const human = await q.query<{ id: string }>(
        `INSERT INTO human_sessions (tenant_id, attendance_id, started_after_seq)
         VALUES ($1, $2, (SELECT COALESCE(max(seq), 0) FROM messages WHERE tenant_id = $1 AND attendance_id = $2))
         RETURNING id`,
        [claims.tenantId, claims.attendanceId],
      );
      await this.messages.appendIn(q, {
        tenantId: claims.tenantId,
        attendanceId: claims.attendanceId,
        sender: 'system',
        content: { type: 'text', text: 'Transferindo para um atendente…' },
        idempotencyKey: `system:handoff:${human.rows[0].id}`,
      });
      await this.outbox.enqueue(q, {
        tenantId: claims.tenantId,
        attendanceId: claims.attendanceId,
        type: 'human.conversation_requested',
        payload: { humanSessionId: human.rows[0].id },
        dedupeKey: `human.conversation_requested:${human.rows[0].id}`,
      });
      return { phase: 'handoff_pending' };
    });
  }

  /** Bot encerra o protocolo (resolvido / "não preciso de mais nada"). Idempotente. */
  async closeByBot(
    claims: BotExecutionClaims,
    reason: string,
  ): Promise<{ closed: boolean }> {
    return this.db.tx(async (q) => {
      const att = await this.lockAttendance(
        q,
        claims.tenantId,
        claims.attendanceId,
      );
      if (!att || att.status !== 'open') return { closed: false };
      await this.requireLiveSession(q, claims);
      const closed = await this.attendances.closeIn(q, {
        tenantId: claims.tenantId,
        id: claims.attendanceId,
        reason: reason.slice(0, 100),
        by: 'bot',
      });
      return { closed: !!closed };
    });
  }

  // ------------------------------------------------------------------ internos

  /** Persiste o turno (mensagens + estado da sessão + fase) numa única transação. */
  private async commitTurn(input: {
    tenantId: string;
    attendanceId: string;
    botSessionId: string;
    expect: BotSessionStatus[];
    turn: BotTurnResult;
    onCommit?: (q: Queryable) => Promise<void>;
  }): Promise<boolean> {
    return this.db.tx(async (q) => {
      const att = await this.lockAttendance(
        q,
        input.tenantId,
        input.attendanceId,
      );
      if (!att || att.status !== 'open') return false;
      const sessions = await q.query<SessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM bot_sessions WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [input.tenantId, input.botSessionId],
      );
      const s = sessions.rows[0];
      if (!s || !input.expect.includes(s.status)) return false;

      const toPersist: MessageContent[] = [...input.turn.messages];
      if (input.turn.input?.type === 'options')
        toPersist.push({ type: 'options', options: input.turn.input.options });
      for (const [i, content] of toPersist.entries()) {
        await this.messages.appendIn(q, {
          tenantId: input.tenantId,
          attendanceId: input.attendanceId,
          sender: 'bot',
          content,
          idempotencyKey: `bot:${s.id}:v${s.stateVersion}:${i}`,
        });
      }
      const liveOp = await q.query(
        // Inclui operação já concluída e ainda não retomada: ela terminou antes do commit do turno.
        `SELECT 1 FROM bot_operations WHERE tenant_id = $1 AND bot_session_id = $2
            AND (status IN ('pending', 'processing') OR (status IN ('completed', 'failed') AND resume_status IS NULL))`,
        [input.tenantId, s.id],
      );
      // O bot só age nas fases do bot; se um handoff ocorreu durante o turno, a sessão encerra.
      const botPhase =
        att.phase === 'bot' ||
        att.phase === 'post_service' ||
        (att.phase === 'returning_to_bot' && s.kind === 'post_service');
      const status: BotSessionStatus = !botPhase
        ? 'completed'
        : liveOp.rowCount
          ? 'waiting_operation'
          : input.turn.input
            ? 'active'
            : 'completed';
      await q.query(
        `UPDATE bot_sessions
            SET provider_session_id = COALESCE($3, provider_session_id), status = $4, pending_input = $5,
                state_version = state_version + 1, updated_at = now(),
                ended_at = CASE WHEN $4 = 'completed' THEN now() END
          WHERE tenant_id = $1 AND id = $2`,
        [
          input.tenantId,
          s.id,
          input.turn.providerSessionId ?? null,
          status,
          input.turn.input ? JSON.stringify(input.turn.input) : null,
        ],
      );
      if (s.kind === 'post_service' && att.phase === 'returning_to_bot') {
        // A pergunta de pós-atendimento acabou de ser persistida: o prazo começa agora (seção 6).
        const settings = await q.query<{ minutes: number }>(
          'SELECT post_service_inactivity_minutes AS minutes FROM tenant_settings WHERE tenant_id = $1',
          [input.tenantId],
        );
        await this.attendances.transitionPhaseIn(q, {
          tenantId: input.tenantId,
          id: input.attendanceId,
          to: 'post_service',
          expectedVersion: att.stateVersion,
          inactivityDeadlineAt: new Date(
            this.attendances.clock().getTime() +
              settings.rows[0].minutes * 60_000,
          ),
        });
      }
      await input.onCommit?.(q);
      return true;
    });
  }

  private async lockAttendance(
    q: Queryable,
    tenantId: string,
    id: string,
  ): Promise<AttendanceLock | null> {
    const { rows } = await q.query<AttendanceLock>(
      `SELECT status, phase, state_version AS "stateVersion", application_id AS "applicationId"
         FROM attendances WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, id],
    );
    return rows[0] ?? null;
  }

  private async requireLiveSession(q: Queryable, claims: BotExecutionClaims) {
    const { rows } = await q.query(
      `SELECT 1 FROM bot_sessions WHERE tenant_id = $1 AND attendance_id = $2 AND id = $3 AND status IN ${LIVE}`,
      [claims.tenantId, claims.attendanceId, claims.botSessionId],
    );
    if (!rows.length)
      throw new ConflictException('sessão do bot não está ativa');
  }

  private async interruptSessions(
    q: Queryable,
    tenantId: string,
    ids: string[],
  ) {
    if (!ids.length) return;
    await q.query(
      `UPDATE bot_operations SET status = 'cancelled', completed_at = now(), lease_expires_at = NULL
        WHERE tenant_id = $1 AND bot_session_id = ANY($2) AND status IN ('pending', 'processing')`,
      [tenantId, ids],
    );
    await q.query(
      `UPDATE bot_sessions SET status = 'interrupted', pending_input = NULL, ended_at = now(),
              state_version = state_version + 1, updated_at = now()
        WHERE tenant_id = $1 AND id = ANY($2)`,
      [tenantId, ids],
    );
  }

  private async markSession(
    id: string,
    tenantId: string,
    from: BotSessionStatus[],
    to: BotSessionStatus,
  ) {
    await this.db.tx(async (q) => {
      await q.query(
        `UPDATE bot_sessions SET status = $4, ended_at = now(), state_version = state_version + 1, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND status = ANY($3)`,
        [tenantId, id, from, to],
      );
      await q.query(
        `UPDATE bot_operations SET status = 'cancelled', completed_at = now(), lease_expires_at = NULL
          WHERE tenant_id = $1 AND bot_session_id = $2 AND status IN ('pending', 'processing')`,
        [tenantId, id],
      );
    });
  }

  private async flowOf(
    tenantId: string,
    botFlowId: string,
  ): Promise<ResolvedFlow> {
    const { rows } = await this.db.query<ResolvedFlow>(
      `SELECT f.id, f.kind, f.external_flow_id AS "externalFlowId", p.endpoint, p.credentials_ref AS "credentialsRef",
              f.prefilled_variables AS "prefilledVariables"
         FROM bot_flows f
         JOIN tenant_bot_workspaces w ON w.tenant_id = f.tenant_id AND w.id = f.workspace_id
         JOIN bot_providers p ON p.id = w.bot_provider_id
        WHERE f.tenant_id = $1 AND f.id = $2`,
      [tenantId, botFlowId],
    );
    return rows[0];
  }
}
