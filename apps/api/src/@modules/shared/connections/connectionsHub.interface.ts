import type { Queryable } from '@modules/shared/database/database.service';

export interface ConnectionsHubInterface extends Queryable {
  tx<T>(operacao: (conexao: Queryable) => Promise<T>): Promise<T>;
}
