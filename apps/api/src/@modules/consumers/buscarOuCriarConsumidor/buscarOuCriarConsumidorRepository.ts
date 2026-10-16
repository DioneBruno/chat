import type { ConsumidorEntity } from '@modules/consumers/consumidor.entity';
import { salvarConsumidor } from '@modules/consumers/salvarConsumidor';
import type { ConsumidorSalvo } from '@modules/consumers/salvarConsumidor';
import type { ConnectionsHubInterface } from '@modules/shared/connections/connectionsHub.interface';
import type { Queryable } from '@modules/shared/database/database.service';

type IdentidadeRow = { consumer_id: string };

export class BuscarOuCriarConsumidorRepository {
  constructor(readonly connectionsHub: ConnectionsHubInterface) {}

  async findOrSaveConsumidor(
    consumidor: ConsumidorEntity,
  ): Promise<ConsumidorSalvo> {
    return this.connectionsHub.tx(async (conexao) => {
      await this.travarIdentidade(conexao, consumidor);
      const existente = await this.findConsumidorPorIdentidade(
        conexao,
        consumidor,
      );
      if (existente) return existente;
      return salvarConsumidor(conexao, consumidor);
    });
  }

  private async travarIdentidade(
    conexao: Queryable,
    consumidor: ConsumidorEntity,
  ): Promise<void> {
    await conexao.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`${consumidor.tenantId()}:${consumidor.identidade().hash()}`],
    );
  }

  private async findConsumidorPorIdentidade(
    conexao: Queryable,
    consumidor: ConsumidorEntity,
  ): Promise<ConsumidorSalvo | null> {
    const identidade = consumidor.identidade();
    const { rows } = await conexao.query<IdentidadeRow>(
      'SELECT consumer_id FROM consumer_identities WHERE tenant_id = $1 AND kind = $2 AND value_hash = $3',
      [consumidor.tenantId(), identidade.tipo(), identidade.hash()],
    );
    if (!rows[0]) return null;
    return { id: rows[0].consumer_id };
  }
}
