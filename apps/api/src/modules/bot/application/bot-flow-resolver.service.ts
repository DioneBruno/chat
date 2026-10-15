import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService, Queryable } from '../../../database/database.service';

export type FlowKind =
  'initial' | 'post_service' | 'business_hours' | 'auxiliary';

export interface ResolvedFlow {
  id: string;
  kind: FlowKind;
  externalFlowId: string;
  endpoint: string;
  credentialsRef: string | null;
  prefilledVariables: Record<string, string>;
}

/** Resolve o fluxo por tenant → aplicação → tipo, com fallback ao padrão da empresa (seção 8). */
@Injectable()
export class BotFlowResolverService {
  constructor(private readonly db: DatabaseService) {}

  async resolve(
    tenantId: string,
    applicationId: string,
    kind: FlowKind,
    q: Queryable = this.db,
  ): Promise<ResolvedFlow> {
    const { rows } = await q.query<ResolvedFlow>(
      `SELECT f.id, f.kind, f.external_flow_id AS "externalFlowId", p.endpoint, p.credentials_ref AS "credentialsRef",
              f.prefilled_variables AS "prefilledVariables"
         FROM bot_flows f
         JOIN tenant_bot_workspaces w ON w.tenant_id = f.tenant_id AND w.id = f.workspace_id
         JOIN bot_providers p ON p.id = w.bot_provider_id
        WHERE f.tenant_id = $1 AND f.kind = $3 AND f.enabled AND w.enabled AND p.enabled
          AND (f.application_id = $2 OR f.application_id IS NULL)
        ORDER BY (f.application_id IS NULL) -- específico da aplicação vem antes do padrão
        LIMIT 1`,
      [tenantId, applicationId, kind],
    );
    if (!rows[0])
      throw new NotFoundException(
        `nenhum fluxo ${kind} habilitado para o tenant`,
      );
    return rows[0];
  }
}
