import { DatabaseService } from '@modules/shared/database/database.service';
import type { FlowKind } from '@modules/bot/botFlowResolver.service';

/**
 * Cadastro `tenant → workspace → fluxos publicados` (seção 8). Só a equipe interna do
 * SaaS configura; não há API pública para isso no MVP. Publicar um novo fluxo desabilita
 * o anterior (o histórico de revisões fica nas linhas desabilitadas).
 */
export class BotConfigService {
  constructor(private readonly db: DatabaseService) {}

  async registerProvider(input: {
    name: string;
    endpoint: string;
    credentialsRef?: string;
  }) {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO bot_providers (name, endpoint, credentials_ref) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET endpoint = EXCLUDED.endpoint, credentials_ref = EXCLUDED.credentials_ref
       RETURNING id`,
      [input.name, input.endpoint, input.credentialsRef ?? null],
    );
    return rows[0].id;
  }

  async registerWorkspace(input: {
    tenantId: string;
    botProviderId: string;
    externalWorkspaceId: string;
  }) {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO tenant_bot_workspaces (tenant_id, bot_provider_id, external_workspace_id) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, bot_provider_id) DO UPDATE SET external_workspace_id = EXCLUDED.external_workspace_id
       RETURNING id`,
      [input.tenantId, input.botProviderId, input.externalWorkspaceId],
    );
    return rows[0].id;
  }

  async registerFlow(input: {
    tenantId: string;
    workspaceId: string;
    applicationId?: string;
    kind: FlowKind;
    externalFlowId: string;
    publishedRevision?: string;
    prefilledVariables?: Record<string, string>;
  }) {
    return this.db.tx(async (q) => {
      await q.query(
        `UPDATE bot_flows SET enabled = false
          WHERE tenant_id = $1 AND kind = $2 AND enabled
            AND application_id IS NOT DISTINCT FROM $3`,
        [input.tenantId, input.kind, input.applicationId ?? null],
      );
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO bot_flows (tenant_id, workspace_id, application_id, kind, external_flow_id, published_revision, prefilled_variables)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          input.tenantId,
          input.workspaceId,
          input.applicationId ?? null,
          input.kind,
          input.externalFlowId,
          input.publishedRevision ?? null,
          JSON.stringify(input.prefilledVariables ?? {}),
        ],
      );
      return rows[0].id;
    });
  }
}
