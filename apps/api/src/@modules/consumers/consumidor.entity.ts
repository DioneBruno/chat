import type { IdentidadeEntity } from '@modules/consumers/identidade.entity';

export type ConsumidorProps = {
  tenantId: string;
  nome: string | null;
  identidade: IdentidadeEntity;
};

export class ConsumidorEntity {
  constructor(readonly props: ConsumidorProps) {}

  tenantId(): string {
    return this.props.tenantId;
  }

  nome(): string | null {
    return this.props.nome;
  }

  identidade(): IdentidadeEntity {
    return this.props.identidade;
  }
}
