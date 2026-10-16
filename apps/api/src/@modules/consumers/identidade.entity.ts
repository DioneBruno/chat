import { createHash, randomUUID } from 'crypto';

export type TipoIdentidade =
  'whatsapp' | 'email' | 'phone' | 'external_user' | 'cpf_cnpj' | 'visitor';

export type IdentidadeProps = {
  tipo: TipoIdentidade;
  valor: string;
};

const TIPOS_SEM_VALOR_EM_CLARO: TipoIdentidade[] = ['cpf_cnpj', 'visitor'];

export function gerarHashIdentidade(
  tipo: TipoIdentidade,
  valor: string,
): string {
  return createHash('sha256')
    .update(`${tipo}:${valor.trim().toLowerCase()}`)
    .digest('hex');
}

export class IdentidadeEntity {
  constructor(readonly props: IdentidadeProps) {}

  static criarVisitante(): IdentidadeEntity {
    return new IdentidadeEntity({ tipo: 'visitor', valor: randomUUID() });
  }

  tipo(): TipoIdentidade {
    return this.props.tipo;
  }

  hash(): string {
    return gerarHashIdentidade(this.props.tipo, this.props.valor);
  }

  valorArmazenavel(): string | null {
    if (TIPOS_SEM_VALOR_EM_CLARO.includes(this.props.tipo)) return null;
    return this.props.valor;
  }

  verificada(): boolean {
    return false;
  }
}
