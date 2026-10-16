import {
  DatabaseService,
  Queryable,
} from '@modules/shared/database/database.service';

export interface OutboxEventInput {
  tenantId?: string | null;
  attendanceId?: string | null;
  type: string;
  /** Payload mínimo: sem dados pessoais ou sensíveis (seção 13). */
  payload?: Record<string, unknown>;
  /** Eventos com a mesma chave são gravados uma única vez. */
  dedupeKey?: string;
  delayMs?: number;
  maxAttempts?: number;
}

export interface OutboxEvent {
  id: string;
  tenantId: string | null;
  attendanceId: string | null;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

const MAX_BACKOFF_MS = 60_000;

/**
 * Outbox transacional em PostgreSQL (seção 2: sem filas no MVP). `enqueue` recebe o
 * client da transação que muda o estado, então evento e mudança saem juntos ou nenhum.
 */
export class OutboxService {
  constructor(private readonly db: DatabaseService) {}

  async enqueue(q: Queryable, input: OutboxEventInput): Promise<void> {
    await q.query(
      `INSERT INTO outbox_events (tenant_id, attendance_id, type, payload, dedupe_key, next_attempt_at, max_attempts)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6), COALESCE($7, 10))
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [
        input.tenantId ?? null,
        input.attendanceId ?? null,
        input.type,
        JSON.stringify(input.payload ?? {}),
        input.dedupeKey ?? null,
        (input.delayMs ?? 0) / 1000,
        input.maxAttempts ?? null,
      ],
    );
  }

  /**
   * Reivindica eventos com lease (`FOR UPDATE SKIP LOCKED`, sem transação aberta durante
   * o processamento). No máximo um evento por atendimento é reivindicado por vez e nenhum
   * enquanto outro do mesmo atendimento estiver em processamento: os avanços do bot/humano
   * de um protocolo são seriais (seção 13). Lease vencido = worker caiu; o evento é retomado.
   * Um lote pode vir menor que `limit` (eventos do mesmo atendimento); o worker repete o ciclo.
   */
  async claim(limit: number, leaseMs: number): Promise<OutboxEvent[]> {
    // Evento que perdeu o lease e já esgotou as tentativas não volta a rodar.
    await this.db.query(
      `UPDATE outbox_events SET status = 'dead', last_error = COALESCE(last_error, 'lease expirado sem sucesso')
        WHERE status = 'processing' AND lease_expires_at < now() AND attempts >= max_attempts`,
    );
    // Dois statements na mesma transação (curta, sem I/O externo): o primeiro trava os
    // candidatos; o segundo reconfere a exclusão por atendimento com snapshot novo. Sem
    // isso, uma réplica com snapshot antigo perderia o evento mais antigo (reivindicado
    // por outra) e escolheria o seguinte do mesmo atendimento.
    const rows = await this.db.tx(async (q) => {
      const locked = await q.query<{ id: string }>(
        `WITH locked AS (
           SELECT o.id, o.attendance_id, o.seq
             FROM outbox_events o
            WHERE ((o.status = 'pending' AND o.next_attempt_at <= now())
                OR (o.status = 'processing' AND o.lease_expires_at < now()))
              AND (o.attendance_id IS NULL OR (
                    NOT EXISTS (SELECT 1 FROM outbox_events p
                                 WHERE p.attendance_id = o.attendance_id AND p.id <> o.id
                                   AND p.status = 'processing' AND p.lease_expires_at >= now())
                    -- Réplicas concorrentes não pegam eventos do mesmo atendimento ao mesmo tempo.
                    AND pg_try_advisory_xact_lock(hashtextextended(o.attendance_id::text, 7))))
            ORDER BY o.next_attempt_at, o.seq
            LIMIT $1
            FOR UPDATE OF o SKIP LOCKED
         )
         SELECT id FROM (
           SELECT id, row_number() OVER (PARTITION BY COALESCE(attendance_id, id) ORDER BY seq) AS rn FROM locked
         ) c WHERE c.rn = 1`,
        [limit],
      );
      if (!locked.rowCount) return [];
      const claimed = await q.query<OutboxEvent>(
        `UPDATE outbox_events e
            SET status = 'processing', attempts = e.attempts + 1,
                lease_expires_at = now() + make_interval(secs => $2)
          WHERE e.id = ANY($1)
            AND ((e.status = 'pending' AND e.next_attempt_at <= now())
              OR (e.status = 'processing' AND e.lease_expires_at < now()))
            AND (e.attendance_id IS NULL OR NOT EXISTS (
                  SELECT 1 FROM outbox_events p
                   WHERE p.attendance_id = e.attendance_id AND p.id <> e.id
                     AND p.status = 'processing' AND p.lease_expires_at >= now()))
          RETURNING e.id, e.tenant_id AS "tenantId", e.attendance_id AS "attendanceId", e.type, e.payload,
                    e.attempts, e.max_attempts AS "maxAttempts"`,
        [locked.rows.map((r) => r.id), leaseMs / 1000],
      );
      return claimed.rows;
    });
    return rows;
  }

  /**
   * Retenção (LGPD/higiene): remove eventos concluídos antigos. Os `dead` ficam para
   * investigação e reprocessamento manual.
   */
  async purgeDone(retentionDays: number): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM outbox_events WHERE status = 'done' AND processed_at < now() - make_interval(days => $1)`,
      [retentionDays],
    );
    return rowCount ?? 0;
  }

  /** O `attempts` confere a posse: quem perdeu o lease não sobrescreve o novo dono. */
  async complete(event: OutboxEvent) {
    await this.db.query(
      `UPDATE outbox_events SET status = 'done', processed_at = now(), lease_expires_at = NULL, last_error = NULL
        WHERE id = $1 AND status = 'processing' AND attempts = $2`,
      [event.id, event.attempts],
    );
  }

  /** Reagenda com backoff exponencial (ou `delayMs`); esgotadas as tentativas, vira `dead`. */
  async fail(
    event: OutboxEvent,
    error: string,
    opts: { delayMs?: number; permanent?: boolean } = {},
  ) {
    const dead = opts.permanent || event.attempts >= event.maxAttempts;
    const delay =
      opts.delayMs ??
      Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (event.attempts - 1));
    await this.db.query(
      `UPDATE outbox_events
          SET status = CASE WHEN $3 THEN 'dead' ELSE 'pending' END, last_error = $4, lease_expires_at = NULL,
              next_attempt_at = now() + make_interval(secs => $5)
        WHERE id = $1 AND status = 'processing' AND attempts = $2`,
      [event.id, event.attempts, dead, error.slice(0, 500), delay / 1000],
    );
  }
}
