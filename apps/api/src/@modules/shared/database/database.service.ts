import { Pool } from 'pg';
import type { PoolClient, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import { runMigrations } from '@modules/shared/database/migrator';

export type Queryable = {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
};

export class DatabaseService {
  readonly pool: Pool;

  constructor(config?: PoolConfig) {
    this.pool = new Pool(
      config ?? {
        connectionString:
          process.env.DATABASE_URL ??
          'postgresql://platform:platform@localhost:5434/platform',
        max: Number(process.env.DATABASE_POOL_MAX ?? 20),
      },
    );
  }

  async onModuleInit() {
    await runMigrations(this.pool);
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ) {
    return this.pool.query<R>(text, values);
  }

  /** Transação curta; nunca faça chamadas HTTP externas dentro de `fn` (seção 13). */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export const PG_UNIQUE_VIOLATION = '23505';
export function isPgError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === code
  );
}
