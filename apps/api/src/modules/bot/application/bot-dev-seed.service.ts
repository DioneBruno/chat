import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../../database/database.service';
import { BotConfigService } from './bot-config.service';

/**
 * Liga o tenant da POC aos fluxos publicados no Typebot (variáveis `TYPEBOT_ID` e
 * `TYPEBOT_POST_SERVICE_ID`). Só desenvolvimento: em produção a equipe interna cadastra.
 */
@Injectable()
export class BotDevSeedService implements OnModuleInit {
  private readonly logger = new Logger(BotDevSeedService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: BotConfigService,
  ) {}

  async onModuleInit() {
    if (process.env.SEED_POC_TENANT === 'false') return;
    const tenant = await this.db.query<{ id: string }>(
      "SELECT id FROM tenants WHERE slug = 'poc'",
    );
    if (!tenant.rows[0]) return;
    const tenantId = tenant.rows[0].id;
    const providerId = await this.config.registerProvider({
      name: 'typebot-poc',
      endpoint: process.env.TYPEBOT_API_URL ?? 'http://localhost:8081/api',
      credentialsRef: 'TYPEBOT_API_TOKEN',
    });
    const workspaceId = await this.config.registerWorkspace({
      tenantId,
      botProviderId: providerId,
      externalWorkspaceId: process.env.TYPEBOT_WORKSPACE_ID ?? 'poc',
    });
    // `acao`: o fluxo `poc-async` envia `{{acao}}` no bloco HTTP (a ação é do fluxo, não do navegador).
    const wanted = [
      {
        kind: 'initial' as const,
        id: process.env.TYPEBOT_ID,
        variables: {
          acao: process.env.POC_BOT_ACTION ?? 'customer.requests.list',
        },
      },
      {
        kind: 'post_service' as const,
        id: process.env.TYPEBOT_POST_SERVICE_ID ?? 'poc-post-service',
        variables: {} as Record<string, string>,
      },
    ];
    for (const { kind, id, variables } of wanted) {
      if (!id) continue;
      const current = await this.db.query<{
        external_flow_id: string;
        prefilled_variables: Record<string, string>;
      }>(
        `SELECT external_flow_id, prefilled_variables FROM bot_flows WHERE tenant_id = $1 AND kind = $2 AND enabled AND application_id IS NULL`,
        [tenantId, kind],
      );
      const row = current.rows[0];
      if (
        row?.external_flow_id === id &&
        JSON.stringify(row.prefilled_variables) === JSON.stringify(variables)
      )
        continue;
      await this.config.registerFlow({
        tenantId,
        workspaceId,
        kind,
        externalFlowId: id,
        prefilledVariables: variables,
      });
      this.logger.log(`seed: fluxo ${kind} do tenant "poc" -> ${id}`);
    }
  }
}
