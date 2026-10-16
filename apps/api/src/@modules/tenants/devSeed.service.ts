import { Logger } from '@modules/shared/util/logger';
import { TenantsService } from '@modules/tenants/tenants.service';

/** Tenant e aplicação do cliente piloto/POC, criados na subida se `SEED_POC_TENANT` != "false". */
export class DevSeedService {
  private readonly logger = new Logger(DevSeedService.name);

  constructor(private readonly tenants: TenantsService) {}

  async onModuleInit() {
    if (process.env.SEED_POC_TENANT === 'false') return;
    if (await this.tenants.getBySlug('poc')) return;
    const tenant = await this.tenants.createTenant({
      slug: 'poc',
      name: 'Empresa Piloto (POC)',
    });
    await this.tenants.createApplication(tenant.id, {
      slug: 'chat',
      name: 'Chat público',
      channel: 'public_link',
    });
    this.logger.log('seed: tenant "poc" com aplicação "chat" criados');
  }
}
