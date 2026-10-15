import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import type { BotExecutionClaims } from '../bot/application/bot-execution-token.service';
import { OutboxService } from '../outbox/outbox.service';
import { OperationExecutorRegistry } from './operation-executors';

export interface BotOperation {
  id: string;
  tenantId: string;
  attendanceId: string;
  botSessionId: string;
  action: string;
  parameters: Record<string, unknown>;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  attempts: number;
  maxAttempts: number;
}

const COLUMNS = `id, tenant_id AS "tenantId", attendance_id AS "attendanceId", bot_session_id AS "botSessionId",
  action, parameters, status, attempts, max_attempts AS "maxAttempts"`;
const MAX_RESULT = 4000;

@Injectable()
export class BotOperationsService {
  private readonly logger = new Logger(BotOperationsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly outbox: OutboxService,
    private readonly registry: OperationExecutorRegistry,
  ) {}

  /**
   * Registra a operação e retorna na hora (chamado pelo bloco HTTP do Typebot, que não
   * pode esperar). Idempotente por chave; no máximo uma operação bloqueante por sessão.
   */
  async create(
    claims: BotExecutionClaims,
    input: {
      action: string;
      parameters?: Record<string, unknown>;
      idempotencyKey?: string;
    },
  ): Promise<{ operationId: string; status: string }> {
    if (!claims.scope.includes('operations'))
      throw new ForbiddenException('credencial sem escopo para operações');
    const executor = this.registry.get(input.action);
    if (!executor) throw new BadRequestException('ação não permitida');

    return this.db.tx(async (q) => {
      const att = await q.query<{ status: string }>(
        `SELECT status FROM attendances WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [claims.tenantId, claims.attendanceId],
      );
      if (att.rows[0]?.status !== 'open')
        throw new ConflictException('atendimento inexistente ou encerrado');
      const session = await q.query<{ status: string; stateVersion: number }>(
        `SELECT status, state_version AS "stateVersion" FROM bot_sessions
          WHERE tenant_id = $1 AND attendance_id = $2 AND id = $3 FOR UPDATE`,
        [claims.tenantId, claims.attendanceId, claims.botSessionId],
      );
      const s = session.rows[0];
      if (!s || !['starting', 'active', 'waiting_operation'].includes(s.status))
        throw new ConflictException('sessão do bot não está ativa');

      // A versão da sessão só muda quando o turno avança: um retry do Typebot repete a chave.
      const key =
        input.idempotencyKey ??
        `${claims.botSessionId}:${input.action}:v${s.stateVersion}`;
      const existing = await q.query<{ id: string; status: string }>(
        `SELECT id, status FROM bot_operations WHERE tenant_id = $1 AND attendance_id = $2 AND idempotency_key = $3`,
        [claims.tenantId, claims.attendanceId, key],
      );
      if (existing.rows[0])
        return {
          operationId: existing.rows[0].id,
          status: existing.rows[0].status,
        };
      const blocking = await q.query<{ id: string; status: string }>(
        `SELECT id, status FROM bot_operations
          WHERE tenant_id = $1 AND bot_session_id = $2 AND status IN ('pending', 'processing')`,
        [claims.tenantId, claims.botSessionId],
      );
      if (blocking.rows[0])
        return {
          operationId: blocking.rows[0].id,
          status: blocking.rows[0].status,
        };

      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO bot_operations (tenant_id, attendance_id, bot_session_id, action, parameters, idempotency_key, max_attempts)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          claims.tenantId,
          claims.attendanceId,
          claims.botSessionId,
          input.action,
          JSON.stringify(input.parameters ?? {}),
          key,
          executor.mutating ? 1 : (executor.maxAttempts ?? 3),
        ],
      );
      await this.outbox.enqueue(q, {
        tenantId: claims.tenantId,
        attendanceId: claims.attendanceId,
        type: 'realtime.publish',
        payload: { event: 'bot.operation.started', operationId: rows[0].id },
        dedupeKey: `bot.operation.started:${rows[0].id}`,
      });
      return { operationId: rows[0].id, status: 'pending' };
    });
  }

  /**
   * Reivindica operações vencidas com lease (`FOR UPDATE SKIP LOCKED`); a transação
   * termina aqui, a execução HTTP acontece depois. Lease vencido = worker caiu.
   */
  async claim(limit: number, leaseMs: number): Promise<BotOperation[]> {
    const { rows } = await this.db.query<BotOperation>(
      `UPDATE bot_operations
          SET status = 'processing', attempts = attempts + 1, lease_expires_at = now() + make_interval(secs => $2)
        WHERE id IN (
          SELECT id FROM bot_operations
           WHERE (status = 'pending' AND next_attempt_at <= now())
              OR (status = 'processing' AND lease_expires_at < now())
           ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING ${COLUMNS}`,
      [limit, leaseMs / 1000],
    );
    return rows;
  }

  /** Conclusão idempotente: só vale para operação ainda `processing` (não cancelada). */
  async complete(op: BotOperation, text: string): Promise<boolean> {
    return this.finish(
      op,
      'completed',
      { text: text.slice(0, MAX_RESULT) },
      null,
    );
  }

  /** Falha definitiva: o Typebot é retomado com a mensagem de erro (fluxo não fica preso). */
  async fail(op: BotOperation, error: string): Promise<boolean> {
    return this.finish(op, 'failed', null, error);
  }

  /** Falha transitória: volta a `pending` com backoff, ou falha de vez ao esgotar as tentativas. */
  async retryOrFail(op: BotOperation, error: string): Promise<boolean> {
    const executor = this.registry.get(op.action);
    if (executor?.mutating || op.attempts >= op.maxAttempts)
      return this.fail(op, error);
    const { rowCount } = await this.db.query(
      `UPDATE bot_operations
          SET status = 'pending', lease_expires_at = NULL, last_error = $3,
              next_attempt_at = now() + make_interval(secs => $4)
        WHERE tenant_id = $1 AND id = $2 AND status = 'processing' AND attempts = $5`,
      [
        op.tenantId,
        op.id,
        error.slice(0, 500),
        Math.min(60, 2 ** op.attempts),
        op.attempts,
      ],
    );
    return !!rowCount;
  }

  private async finish(
    op: BotOperation,
    status: 'completed' | 'failed',
    result: { text: string } | null,
    error: string | null,
  ): Promise<boolean> {
    return this.db.tx(async (q) => {
      // Cancelada (protocolo encerrado, handoff, sessão trocada) ou reivindicada por outro worker: descarta.
      const { rowCount } = await q.query(
        `UPDATE bot_operations
            SET status = $3, result = $4, last_error = $5, completed_at = now(), lease_expires_at = NULL,
                state_version = state_version + 1
          WHERE tenant_id = $1 AND id = $2 AND status = 'processing' AND attempts = $6`,
        [
          op.tenantId,
          op.id,
          status,
          result ? JSON.stringify(result) : null,
          error?.slice(0, 500) ?? null,
          op.attempts,
        ],
      );
      if (!rowCount) {
        this.logger.warn(
          `resultado da operação ${op.id} descartado (cancelada ou já tratada)`,
        );
        return false;
      }
      await this.outbox.enqueue(q, {
        tenantId: op.tenantId,
        attendanceId: op.attendanceId,
        type: 'bot.operation.resume',
        payload: { operationId: op.id },
        dedupeKey: `bot.operation.resume:${op.id}`,
      });
      await this.outbox.enqueue(q, {
        tenantId: op.tenantId,
        attendanceId: op.attendanceId,
        type: 'realtime.publish',
        payload: {
          event:
            status === 'completed'
              ? 'bot.operation.completed'
              : 'bot.operation.failed',
          operationId: op.id,
        },
        dedupeKey: `bot.operation.${status}:${op.id}`,
      });
      return true;
    });
  }
}
