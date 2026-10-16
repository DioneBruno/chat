import type { ConsumidorEntity } from '@modules/consumers/consumidor.entity';
import { CriarVisitanteUsecase } from '@modules/consumers/criarVisitante/criarVisitante.usecase';
import type { CriarVisitanteRepository } from '@modules/consumers/criarVisitante/criarVisitanteRepository';

const TENANT_ID = 'tenant-1';
const CONSUMIDOR_ID = 'consumidor-1';

function criarRepositorioFalso() {
  const salvos: ConsumidorEntity[] = [];
  const repo = {
    saveConsumidor: (consumidor: ConsumidorEntity) => {
      salvos.push(consumidor);
      return Promise.resolve({ id: CONSUMIDOR_ID });
    },
  } as unknown as CriarVisitanteRepository;
  return { repo, salvos };
}

describe('CriarVisitanteUsecase', () => {
  it('cria consumidor anônimo com identidade de visitante sem valor em claro', async () => {
    const { repo, salvos } = criarRepositorioFalso();
    const resultado = await new CriarVisitanteUsecase(repo).execute({
      tenantId: TENANT_ID,
    });
    expect(resultado).toEqual({ id: CONSUMIDOR_ID });
    expect(salvos).toHaveLength(1);
    expect(salvos[0].tenantId()).toBe(TENANT_ID);
    expect(salvos[0].nome()).toBeNull();
    expect(salvos[0].identidade().tipo()).toBe('visitor');
    expect(salvos[0].identidade().valorArmazenavel()).toBeNull();
    expect(salvos[0].identidade().verificada()).toBe(false);
  });

  it('gera identidade de visitante distinta a cada chamada', async () => {
    const { repo, salvos } = criarRepositorioFalso();
    const usecase = new CriarVisitanteUsecase(repo);
    await usecase.execute({ tenantId: TENANT_ID, nome: 'Maria' });
    await usecase.execute({ tenantId: TENANT_ID });
    expect(salvos[0].nome()).toBe('Maria');
    expect(salvos[0].identidade().hash()).not.toBe(
      salvos[1].identidade().hash(),
    );
  });
});
