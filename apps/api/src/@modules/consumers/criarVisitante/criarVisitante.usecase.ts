import { ConsumidorEntity } from '@modules/consumers/consumidor.entity';
import { IdentidadeEntity } from '@modules/consumers/identidade.entity';
import type { ConsumidorSalvo } from '@modules/consumers/salvarConsumidor';
import type { CriarVisitanteRepository } from '@modules/consumers/criarVisitante/criarVisitanteRepository';

export type CriarVisitanteInput = {
  tenantId: string;
  nome?: string;
};

export class CriarVisitanteUsecase {
  constructor(readonly repo: CriarVisitanteRepository) {}

  async execute(input: CriarVisitanteInput): Promise<ConsumidorSalvo> {
    const consumidor = new ConsumidorEntity({
      tenantId: input.tenantId,
      nome: input.nome ?? null,
      identidade: IdentidadeEntity.criarVisitante(),
    });
    return this.repo.saveConsumidor(consumidor);
  }
}
