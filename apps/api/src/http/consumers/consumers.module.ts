import { Module } from '@nestjs/common';
import { BuscarOuCriarConsumidorUsecase } from '@modules/consumers/buscarOuCriarConsumidor/buscarOuCriarConsumidor.usecase';
import { BuscarOuCriarConsumidorRepository } from '@modules/consumers/buscarOuCriarConsumidor/buscarOuCriarConsumidorRepository';
import { CriarVisitanteUsecase } from '@modules/consumers/criarVisitante/criarVisitante.usecase';
import { CriarVisitanteRepository } from '@modules/consumers/criarVisitante/criarVisitanteRepository';
import type { ConnectionsHubInterface } from '@modules/shared/connections/connectionsHub.interface';
import { DatabaseService } from '@modules/shared/database/database.service';

@Module({
  providers: [
    {
      provide: CriarVisitanteUsecase,
      useFactory: (connectionsHub: ConnectionsHubInterface) =>
        new CriarVisitanteUsecase(new CriarVisitanteRepository(connectionsHub)),
      inject: [DatabaseService],
    },
    {
      provide: BuscarOuCriarConsumidorUsecase,
      useFactory: (connectionsHub: ConnectionsHubInterface) =>
        new BuscarOuCriarConsumidorUsecase(
          new BuscarOuCriarConsumidorRepository(connectionsHub),
        ),
      inject: [DatabaseService],
    },
  ],
  exports: [CriarVisitanteUsecase, BuscarOuCriarConsumidorUsecase],
})
export class ConsumersModule {}
