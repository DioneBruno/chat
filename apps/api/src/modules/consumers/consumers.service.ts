import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { DatabaseService, Queryable } from '../../database/database.service';

export type IdentityKind =
  'whatsapp' | 'email' | 'phone' | 'external_user' | 'cpf_cnpj' | 'visitor';

export function hashIdentityValue(kind: IdentityKind, value: string) {
  return createHash('sha256')
    .update(`${kind}:${value.trim().toLowerCase()}`)
    .digest('hex');
}

@Injectable()
export class ConsumersService {
  constructor(private readonly db: DatabaseService) {}

  /** Visitante anônimo: cadastro provisório com identidade `visitor` aleatória. */
  async createVisitor(
    tenantId: string,
    name?: string,
  ): Promise<{ id: string }> {
    return this.db.tx(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO consumers (tenant_id, name) VALUES ($1, $2) RETURNING id',
        [tenantId, name ?? null],
      );
      await this.addIdentity(
        client,
        tenantId,
        rows[0].id,
        'visitor',
        randomUUID(),
        false,
        false,
      );
      return rows[0];
    });
  }

  /**
   * Localiza ou cria consumidor por identidade externa (ex.: número de WhatsApp).
   * CPF/CNPJ só é guardado como hash (`storeValue=false`).
   */
  async findOrCreateByIdentity(
    tenantId: string,
    kind: IdentityKind,
    value: string,
    name?: string,
  ): Promise<{ id: string }> {
    const valueHash = hashIdentityValue(kind, value);
    return this.db.tx(async (client) => {
      // Serializa a criação concorrente da mesma identidade.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`${tenantId}:${valueHash}`],
      );
      const found = await client.query<{ consumer_id: string }>(
        'SELECT consumer_id FROM consumer_identities WHERE tenant_id = $1 AND kind = $2 AND value_hash = $3',
        [tenantId, kind, valueHash],
      );
      if (found.rows[0]) return { id: found.rows[0].consumer_id };
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO consumers (tenant_id, name) VALUES ($1, $2) RETURNING id',
        [tenantId, name ?? null],
      );
      await this.addIdentity(
        client,
        tenantId,
        rows[0].id,
        kind,
        value,
        kind !== 'cpf_cnpj',
        false,
      );
      return rows[0];
    });
  }

  private addIdentity(
    q: Queryable,
    tenantId: string,
    consumerId: string,
    kind: IdentityKind,
    value: string,
    storeValue: boolean,
    verified: boolean,
  ) {
    return q.query(
      `INSERT INTO consumer_identities (tenant_id, consumer_id, kind, value, value_hash, verified)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        tenantId,
        consumerId,
        kind,
        storeValue ? value : null,
        hashIdentityValue(kind, value),
        verified,
      ],
    );
  }
}
