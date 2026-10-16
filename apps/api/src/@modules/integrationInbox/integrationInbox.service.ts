import { createHash } from 'crypto';
import {
  DatabaseService,
  Queryable,
} from '@modules/shared/database/database.service';

/** Webhooks recebidos: grava uma vez por (provider, chave) e permite marcar o resultado. */
export class IntegrationInboxService {
  private timer?: NodeJS.Timeout;

  constructor(private readonly db: DatabaseService) {}

  onModuleInit() {
    if (process.env.INBOX_PURGE === 'false') return;
    this.timer = setInterval(
      () => void this.purge().catch(() => undefined),
      3_600_000,
    );
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** Retenção: o payload do webhook pode conter texto de conversa (`INBOX_RETENTION_DAYS`, 30). */
  async purge(retentionDays = Number(process.env.INBOX_RETENTION_DAYS ?? 30)) {
    const { rowCount } = await this.db.query(
      `DELETE FROM integration_inbox WHERE status <> 'received' AND processed_at < now() - make_interval(days => $1)`,
      [retentionDays],
    );
    return rowCount ?? 0;
  }

  /** Retorna `duplicate: true` quando a chave já foi recebida (reentrega do provedor). */
  async receive(
    q: Queryable,
    input: { provider: string; idempotencyKey: string; payload: unknown },
  ): Promise<{ id: string; duplicate: boolean }> {
    const body = JSON.stringify(input.payload);
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO integration_inbox (provider, idempotency_key, payload_hash, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider, idempotency_key) DO NOTHING RETURNING id`,
      [
        input.provider,
        input.idempotencyKey,
        createHash('sha256').update(body).digest('hex'),
        body,
      ],
    );
    if (rows[0]) return { id: rows[0].id, duplicate: false };
    const existing = await q.query<{ id: string }>(
      'SELECT id FROM integration_inbox WHERE provider = $1 AND idempotency_key = $2',
      [input.provider, input.idempotencyKey],
    );
    return { id: existing.rows[0].id, duplicate: true };
  }

  async get(id: string) {
    const { rows } = await this.db.query<{
      id: string;
      provider: string;
      payload: unknown;
      status: string;
    }>(
      'SELECT id, provider, payload, status FROM integration_inbox WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }

  async mark(
    id: string,
    status: 'processed' | 'ignored' | 'failed',
    detail?: string,
  ) {
    await this.db.query(
      'UPDATE integration_inbox SET status = $2, detail = $3, processed_at = now() WHERE id = $1',
      [id, status, detail ?? null],
    );
  }
}
