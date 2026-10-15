import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { TenantsService } from '../tenants/tenants.service';

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

/** Único serviço autorizado a alterar status/fase de um atendimento (seção 9). */
@Injectable()
export class AttendancesService {
  /** Relógio injetável (testes de virada de ano). */
  clock: () => Date = () => new Date();

  constructor(
    private readonly db: DatabaseService,
    private readonly tenants: TenantsService,
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
        throw new NotFoundException('aplicação inexistente ou desabilitada');
      const consumer = await client.query(
        'SELECT 1 FROM consumers WHERE tenant_id = $1 AND id = $2',
        [input.tenantId, input.consumerId],
      );
      if (!consumer.rowCount)
        throw new NotFoundException('consumidor inexistente neste tenant');

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
    const { rows } = await this.db.query<Attendance>(
      `SELECT ${COLUMNS} FROM attendances WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    if (!rows[0]) throw new NotFoundException('atendimento não encontrado');
    return rows[0];
  }

  async getConversationId(
    tenantId: string,
    attendanceId: string,
  ): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      'SELECT id FROM conversations WHERE tenant_id = $1 AND attendance_id = $2',
      [tenantId, attendanceId],
    );
    if (!rows[0]) throw new NotFoundException('conversa não encontrada');
    return rows[0].id;
  }

  /**
   * Muda a fase com controle otimista (`expectedVersion`). Entrar em
   * `awaiting_business_hours` suspende o prazo de inatividade (seção 7).
   */
  async transitionPhase(input: {
    tenantId: string;
    id: string;
    to: AttendancePhase;
    expectedVersion: number;
    inactivityDeadlineAt?: Date | null;
  }): Promise<Attendance> {
    const current = await this.get(input.tenantId, input.id);
    if (current.status !== 'open')
      throw new ConflictException('atendimento encerrado');
    if (!PHASE_TRANSITIONS[current.phase].includes(input.to)) {
      throw new UnprocessableEntityException(
        `transição ${current.phase} -> ${input.to} não permitida`,
      );
    }
    const deadline =
      input.to === 'awaiting_business_hours'
        ? null
        : input.inactivityDeadlineAt === undefined
          ? current.inactivityDeadlineAt
          : input.inactivityDeadlineAt;
    const { rows } = await this.db.query<Attendance>(
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
      throw new ConflictException(
        'estado do atendimento mudou; recarregue e tente de novo',
      );
    return rows[0];
  }

  /** Encerra de forma condicional/idempotente: retorna `null` se já não estava aberto. */
  async close(input: {
    tenantId: string;
    id: string;
    reason: string;
    by: Actor;
    status?: 'closed' | 'expired';
  }) {
    const { rows } = await this.db.query<Attendance>(
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
    return rows[0] ?? null;
  }

  /**
   * Expira atendimentos vencidos (chamado pelo worker). O UPDATE condicional
   * sobre `status='open'` e o prazo é a condição transacional que impede
   * corrida com a resposta do consumidor (que zera/renova o prazo na mesma linha).
   * Atendimentos em `awaiting_business_hours` nunca expiram.
   */
  async expireDue(limit = 100): Promise<Attendance[]> {
    const { rows } = await this.db.query<Attendance>(
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

  private yearIn(timeZone: string) {
    return Number(
      new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric' }).format(
        this.clock(),
      ),
    );
  }
}
