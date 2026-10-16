import { BuscarOuCriarConsumidorUsecase } from '@modules/consumers/buscarOuCriarConsumidor/buscarOuCriarConsumidor.usecase';
import type { BuscarOuCriarConsumidorRepository } from '@modules/consumers/buscarOuCriarConsumidor/buscarOuCriarConsumidorRepository';
import type { ConsumidorEntity } from '@modules/consumers/consumidor.entity';
import { gerarHashIdentidade } from '@modules/consumers/identidade.entity';

const TENANT_ID = 'tenant-1';
const CONSUMIDOR_ID = 'consumidor-1';
const WHATSAPP = '+5511999990000';
const CPF = '123.456.789-09';

function criarRepositorioFalso() {
  const recebidos: ConsumidorEntity[] = [];
  const repo = {
    findOrSaveConsumidor: (consumidor: ConsumidorEntity) => {
      recebidos.push(consumidor);
      return Promise.resolve({ id: CONSUMIDOR_ID });
    },
  } as unknown as BuscarOuCriarConsumidorRepository;
  return { repo, recebidos };
}

describe('BuscarOuCriarConsumidorUsecase', () => {
  it('busca ou cria pelo hash da identidade e guarda o valor de contato em claro', async () => {
    const { repo, recebidos } = criarRepositorioFalso();
    const resultado = await new BuscarOuCriarConsumidorUsecase(repo).execute({
      tenantId: TENANT_ID,
      tipo: 'whatsapp',
      valor: WHATSAPP,
    });
    expect(resultado).toEqual({ id: CONSUMIDOR_ID });
    const identidade = recebidos[0].identidade();
    expect(identidade.hash()).toBe(gerarHashIdentidade('whatsapp', WHATSAPP));
    expect(identidade.valorArmazenavel()).toBe(WHATSAPP);
  });

  it('nunca expõe CPF/CNPJ em claro para persistência', async () => {
    const { repo, recebidos } = criarRepositorioFalso();
    await new BuscarOuCriarConsumidorUsecase(repo).execute({
      tenantId: TENANT_ID,
      tipo: 'cpf_cnpj',
      valor: CPF,
    });
    const identidade = recebidos[0].identidade();
    expect(identidade.valorArmazenavel()).toBeNull();
    expect(identidade.hash()).toBe(gerarHashIdentidade('cpf_cnpj', CPF));
  });

  it('normaliza o valor antes do hash', () => {
    expect(gerarHashIdentidade('email', ' Ana@Exemplo.com ')).toBe(
      gerarHashIdentidade('email', 'ana@exemplo.com'),
    );
  });
});
