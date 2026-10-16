import type { ConsumidorEntity } from '@modules/consumers/consumidor.entity';
import type { Queryable } from '@modules/shared/database/database.service';

export type ConsumidorSalvo = { id: string };

export async function salvarConsumidor(
  conexao: Queryable,
  consumidor: ConsumidorEntity,
): Promise<ConsumidorSalvo> {
  const { rows } = await conexao.query<ConsumidorSalvo>(
    'INSERT INTO consumers (tenant_id, name) VALUES ($1, $2) RETURNING id',
    [consumidor.tenantId(), consumidor.nome()],
  );
  const identidade = consumidor.identidade();
  await conexao.query(
    `INSERT INTO consumer_identities (tenant_id, consumer_id, kind, value, value_hash, verified)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      consumidor.tenantId(),
      rows[0].id,
      identidade.tipo(),
      identidade.valorArmazenavel(),
      identidade.hash(),
      identidade.verificada(),
    ],
  );
  return rows[0];
}
