import type { ConsumidorEntity } from '@modules/consumers/consumidor.entity';
import { salvarConsumidor } from '@modules/consumers/salvarConsumidor';
import type { ConsumidorSalvo } from '@modules/consumers/salvarConsumidor';
import type { ConnectionsHubInterface } from '@modules/shared/connections/connectionsHub.interface';

export class CriarVisitanteRepository {
  constructor(readonly connectionsHub: ConnectionsHubInterface) {}

  async saveConsumidor(consumidor: ConsumidorEntity): Promise<ConsumidorSalvo> {
    return this.connectionsHub.tx((conexao) =>
      salvarConsumidor(conexao, consumidor),
    );
  }
}
