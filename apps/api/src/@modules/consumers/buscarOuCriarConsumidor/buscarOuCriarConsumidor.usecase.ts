import { ConsumidorEntity } from '@modules/consumers/consumidor.entity';
import { IdentidadeEntity } from '@modules/consumers/identidade.entity';
import type { TipoIdentidade } from '@modules/consumers/identidade.entity';
import type { ConsumidorSalvo } from '@modules/consumers/salvarConsumidor';
import type { BuscarOuCriarConsumidorRepository } from '@modules/consumers/buscarOuCriarConsumidor/buscarOuCriarConsumidorRepository';

export type BuscarOuCriarConsumidorInput = {
  tenantId: string;
  tipo: TipoIdentidade;
  valor: string;
  nome?: string;
};

export class BuscarOuCriarConsumidorUsecase {
  constructor(readonly repo: BuscarOuCriarConsumidorRepository) {}

  async execute(input: BuscarOuCriarConsumidorInput): Promise<ConsumidorSalvo> {
    const consumidor = new ConsumidorEntity({
      tenantId: input.tenantId,
      nome: input.nome ?? null,
      identidade: new IdentidadeEntity({
        tipo: input.tipo,
        valor: input.valor,
      }),
    });
    return this.repo.findOrSaveConsumidor(consumidor);
  }
}
