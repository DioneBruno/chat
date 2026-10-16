import {
  ConflitoError,
  EntidadeInvalidaError,
  NaoEncontradoError,
} from '@modules/shared/error/erroAplicacao';
import { PoolClient } from 'pg';
import {
  DatabaseService,
  Queryable,
} from '@modules/shared/database/database.service';
import { OutboxService } from '@modules/outbox/outbox.service';
import { TenantsService } from '@modules/tenants/tenants.service';

export type AttendanceStatus = 'open' | 'closed' | 'expired';
export type AttendancePhase =
  | 'bot'
  | 'awaiting_business_hours'
  | 'handoff_pending'
  | 'human'
  | 'returning_to_bot'
  | 'post_service';
export type Actor = 'consumer' | 'bot' | 'agent' | 'system';

export interface Attendance {
  id: string;
  tenantId: string;
  applicationId: string;
  consumerId: string;
  protocolNumber: string;
  status: AttendanceStatus;
  phase: AttendancePhase;
  inactivityDeadlineAt: Date | null;
  closedReason: string | null;
  closedBy: Actor | null;
  stateVersion: number;
  createdAt: Date;
  closedAt: Date | null;
}

const COLUMNS = `id, tenant_id AS "tenantId", application_id AS "applicationId", consumer_id AS "consumerId",
  protocol_number AS "protocolNumber", status, phase, inactivity_deadline_at AS "inactivityDeadlineAt",
  closed_reason AS "closedReason", closed_by AS "closedBy", state_version AS "stateVersion",
  created_at AS "createdAt", closed_at AS "closedAt"`;

/**
 * Transições de fase permitidas (fluxo da seção 5). Proposta técnica derivada
 * do diagrama, não regra aprovada além dele; ajustar ao implementar o orquestrador.
 */
export const PHASE_TRANSITIONS: Record<AttendancePhase, AttendancePhase[]> = {
  bot: ['awaiting_business_hours', 'handoff_pending', 'post_service'],
  awaiting_business_hours: ['bot', 'handoff_pending'],
  handoff_pending: ['human', 'bot', 'awaiting_business_hours'],
  human: ['returning_to_bot'],
  returning_to_bot: ['post_service', 'human'],
  post_service: ['bot', 'handoff_pending'],
};

export interface TransitionInput {
  tenantId: string;
  id: string;
  to: AttendancePhase;
  expectedVersion: number;
  inactivityDeadlineAt?: Date | null;
}

export interface CloseInput {
  tenantId: string;
  id: string;
  reason: string;
  by: Actor;
  status?: 'closed' | 'expired';
}

/** Único serviço autorizado a alterar status/fase de um atendimento (seção 9). */
export class AttendancesService {
  /** Relógio injetável (testes de virada de ano). */
  clock: () => Date = () => new Date();

  constructor(
    private readonly db: DatabaseService,
    private readonly tenants: TenantsService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Retorna o atendimento aberto do consumidor na aplicação ou cria um novo
   * protocolo (`ANO-SEQUENCIAL`) com sua conversa, atomicamente.
   */
  async openOrGet(input: {
    tenantId: string;
    applicationId: string;
    consumerId: string;
  }) {
    const settings = await this.tenants.getSettings(input.tenantId);
    const year = this.yearIn(settings.timezone);
    return this.db.tx(async (client) => {
      // Serializa aberturas concorrentes do mesmo consumidor: evita protocolo duplicado.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 1))',
        [`${input.tenantId}:${input.applicationId}:${input.consumerId}`],
      );
      const app = await client.query<{ enabled: boolean }>(
        'SELECT enabled FROM applications WHERE tenant_id = $1 AND id = $2',
        [input.tenantId, input.applicationId],
      );
      if (!app.rows[0]?.enabled)
        throw new NaoEncontradoError('aplicação inexistente ou desabilitada');
      const consumer = await client.query(
        'SELECT 1 FROM consumers WHERE tenant_id = $1 AND id = $2',
        [input.tenantId, input.consumerId],
      );
      if (!consumer.rowCount)
        throw new NaoEncontradoError('consumidor inexistente neste tenant');

      const open = await client.query<Attendance>(
        `SELECT ${COLUMNS} FROM attendances
          WHERE tenant_id = $1 AND application_id = $2 AND consumer_id = $3 AND status = 'open'`,
        [input.tenantId, input.applicationId, input.consumerId],
      );
      if (open.rows[0]) return { attendance: open.rows[0], created: false };

      const sequence = await this.allocateSequence(
        client,
        input.tenantId,
        year,
      );
      const protocolNumber = `${year}-${String(sequence).padStart(6, '0')}`;
      const { rows } = await client.query<Attendance>(
        `INSERT INTO attendances (tenant_id, application_id, consumer_id, protocol_year, protocol_sequence,
                                  protocol_number, inactivity_deadline_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
        [
          input.tenantId,
          input.applicationId,
          input.consumerId,
          year,
          sequence,
          protocolNumber,
          new Date(
            this.clock().getTime() + settings.generalInactivityMinutes * 60_000,
          ),
        ],
      );
      await client.query(
        'INSERT INTO conversations (tenant_id, attendance_id) VALUES ($1, $2)',
        [input.tenantId, rows[0].id],
      );
      // Todo atendimento começa no Typebot (seção 5): o worker inicia a sessão inicial.
      await this.outbox.enqueue(client, {
        tenantId: input.tenantId,
        attendanceId: rows[0].id,
        type: 'attendance.created',
        dedupeKey: `attendance.created:${rows[0].id}`,
      });
      return { attendance: rows[0], created: true };
    });
  }

  /**
   * Sequencial por (tenant, ano). O UPSERT trava a linha do contador até o
   * commit: sem duplicidade e, como o rollback desfaz o incremento, sem buracos.
   */
  private async allocateSequence(
    client: PoolClient,
    tenantId: string,
    year: number,
  ) {
    const { rows } = await client.query<{ sequence: number }>(
      `INSERT INTO attendance_counters (tenant_id, year, next_sequence) VALUES ($1, $2, 2)
       ON CONFLICT (tenant_id, year) DO UPDATE SET next_sequence = attendance_counters.next_sequence + 1
       RETURNING next_sequence - 1 AS sequence`,
      [tenantId, year],
    );
    return rows[0].sequence;
  }

  async get(tenantId: string, id: string): Promise<Attendance> {
    return this.getIn(this.db, tenantId, id);
  }

  async getIn(q: Queryable, tenantId: string, id: string): Promise<Attendance> {
    const { rows } = await q.query<Attendance>(
      `SELECT ${COLUMNS} FROM attendances WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    if (!rows[0]) throw new NaoEncontradoError('atendimento não encontrado');
    return rows[0];
  }

  /**
   * Estado do chat para o front reconectar sem perder o contexto: operação em andamento
   * e o que se espera do consumidor (o banco é a fonte da verdade; o realtime é só sinal).
   */
  async chatState(tenantId: string, attendanceId: string) {
    const [session, operation] = await Promise.all([
      this.db.query<{ status: string; pendingInput: { type: string } | null }>(
        `SELECT status, pending_input AS "pendingInput" FROM bot_sessions
          WHERE tenant_id = $1 AND attendance_id = $2 AND status IN ('starting', 'active', 'waiting_operation')`,
        [tenantId, attendanceId],
      ),
      this.db.query<{ id: string; status: string }>(
        `SELECT id, status FROM bot_operations
          WHERE tenant_id = $1 AND attendance_id = $2
            AND (status IN ('pending', 'processing') OR (status IN ('completed', 'failed') AND resume_status IS NULL))
          ORDER BY created_at DESC LIMIT 1`,
        [tenantId, attendanceId],
      ),
    ]);
    const s = session.rows[0];
    return {
      pendingOperation: operation.rows[0]
        ? { id: operation.rows[0].id, status: operation.rows[0].status }
        : null,
      expecting: s?.status === 'active' ? (s.pendingInput?.type ?? null) : null,
    };
  }

  async getConversationId(
    tenantId: string,
    attendanceId: string,
  ): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      'SELECT id FROM conversations WHERE tenant_id = $1 AND attendance_id = $2',
      [tenantId, attendanceId],
    );
    if (!rows[0]) throw new NaoEncontradoError('conversa não encontrada');
    return rows[0].id;
  }

  /**
   * Muda a fase com controle otimista (`expectedVersion`). Entrar em
   * `awaiting_business_hours` suspende o prazo de inatividade (seção 7).
   */
  transitionPhase(input: TransitionInput): Promise<Attendance> {
    return this.db.tx((client) => this.transitionPhaseIn(client, input));
  }

  /** Versão para compor com outras escritas na transação do chamador (orquestrador). */
  async transitionPhaseIn(
    q: Queryable,
    input: TransitionInput,
  ): Promise<Attendance> {
    const current = await this.getIn(q, input.tenantId, input.id);
    if (current.status !== 'open')
      throw new ConflitoError('atendimento encerrado');
    if (!PHASE_TRANSITIONS[current.phase].includes(input.to)) {
      throw new EntidadeInvalidaError(
        `transição ${current.phase} -> ${input.to} não permitida`,
      );
    }
    const deadline =
      input.to === 'awaiting_business_hours'
        ? null
        : input.inactivityDeadlineAt === undefined
          ? current.inactivityDeadlineAt
          : input.inactivityDeadlineAt;
    const { rows } = await q.query<Attendance>(
      `UPDATE attendances SET phase = $4, inactivity_deadline_at = $5, state_version = state_version + 1
        WHERE tenant_id = $1 AND id = $2 AND status = 'open' AND state_version = $3 AND phase = $6
        RETURNING ${COLUMNS}`,
      [
        input.tenantId,
        input.id,
        input.expectedVersion,
        input.to,
        deadline,
        current.phase,
      ],
    );
    if (!rows[0])
      throw new ConflitoError(
        'estado do atendimento mudou; recarregue e tente de novo',
      );
    await this.signalUpdated(q, rows[0]);
    return rows[0];
  }

  /**
   * Define o prazo de inatividade sem mudar a fase (ex.: pergunta de pós-atendimento
   * entregue). Condicional à versão: não pisa numa mudança concorrente.
   */
  async setDeadlineIn(
    q: Queryable,
    input: { tenantId: string; id: string; deadline: Date | null },
  ) {
    await q.query(
      `UPDATE attendances SET inactivity_deadline_at = $3
        WHERE tenant_id = $1 AND id = $2 AND status = 'open'`,
      [input.tenantId, input.id, input.deadline],
    );
  }

  /** Encerra de forma condicional/idempotente: retorna `null` se já não estava aberto. */
  close(input: CloseInput) {
    return this.db.tx((client) => this.closeIn(client, input));
  }

  async closeIn(q: Queryable, input: CloseInput) {
    const { rows } = await q.query<Attendance>(
      `UPDATE attendances
          SET status = $3, closed_reason = $4, closed_by = $5, closed_at = now(),
              inactivity_deadline_at = NULL, state_version = state_version + 1
        WHERE tenant_id = $1 AND id = $2 AND status = 'open'
        RETURNING ${COLUMNS}`,
      [
        input.tenantId,
        input.id,
        input.status ?? 'closed',
        input.reason,
        input.by,
      ],
    );
    if (rows[0]) await this.onTerminal(q, rows[0]);
    return rows[0] ?? null;
  }

  /**
   * Expira atendimentos vencidos (chamado pelo worker). O UPDATE condicional
   * sobre `status='open'` e o prazo é a condição transacional que impede
   * corrida com a resposta do consumidor (que zera/renova o prazo na mesma linha).
   * Atendimentos em `awaiting_business_hours` nunca expiram.
   */
  expireDue(limit = 100): Promise<Attendance[]> {
    return this.db.tx(async (client) => {
      const rows = await this.expireDueIn(client, limit);
      for (const row of rows) await this.onTerminal(client, row);
      return rows;
    });
  }

  private async expireDueIn(q: Queryable, limit: number) {
    const { rows } = await q.query<Attendance>(
      `UPDATE attendances
          SET status = 'expired', closed_by = 'system', closed_at = now(), inactivity_deadline_at = NULL,
              closed_reason = CASE WHEN phase = 'post_service' THEN 'post_service_inactivity' ELSE 'inactivity' END,
              state_version = state_version + 1
        WHERE id IN (
          SELECT id FROM attendances
           WHERE status = 'open' AND phase <> 'awaiting_business_hours' AND inactivity_deadline_at <= $1
           ORDER BY inactivity_deadline_at LIMIT $2 FOR UPDATE SKIP LOCKED)
          AND status = 'open' AND inactivity_deadline_at <= $1
        RETURNING ${COLUMNS}`,
      [this.clock(), limit],
    );
    return rows;
  }

  /**
   * Efeitos do encerramento (evento `attendance.closed`, seção 12), na mesma transação:
   * cancela operações, interrompe sessões do bot/humano e sinaliza o realtime.
   * Resultados tardios de operações canceladas são descartados pelo worker.
   */
  private async onTerminal(q: Queryable, a: Attendance) {
    await q.query(
      `UPDATE bot_operations SET status = 'cancelled', completed_at = now(), lease_expires_at = NULL
        WHERE tenant_id = $1 AND attendance_id = $2 AND status IN ('pending', 'processing')`,
      [a.tenantId, a.id],
    );
    await q.query(
      `UPDATE bot_sessions SET status = 'interrupted', pending_input = NULL, ended_at = now(),
              state_version = state_version + 1, updated_at = now()
        WHERE tenant_id = $1 AND attendance_id = $2 AND status IN ('starting', 'active', 'waiting_operation')`,
      [a.tenantId, a.id],
    );
    await q.query(
      `UPDATE human_sessions SET status = 'ended', end_reason = $3, ended_at = now()
        WHERE tenant_id = $1 AND attendance_id = $2 AND status IN ('pending', 'active')`,
      [a.tenantId, a.id, `attendance_${a.status}`],
    );
    await this.signalUpdated(q, a);
  }

  private signalUpdated(q: Queryable, a: Attendance) {
    return this.outbox.enqueue(q, {
      tenantId: a.tenantId,
      attendanceId: a.id,
      type: 'realtime.publish',
      payload: { event: 'attendance.updated' },
      dedupeKey: `attendance.updated:${a.id}:${a.stateVersion}`,
    });
  }

  private yearIn(timeZone: string) {
    return Number(
      new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric' }).format(
        this.clock(),
      ),
    );
  }
}
