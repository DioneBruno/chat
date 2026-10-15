import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TenantsService } from './tenants.service';

/** Tenant e aplicação do cliente piloto/POC, criados na subida se `SEED_POC_TENANT` != "false". */
@Injectable()
export class DevSeedService implements OnModuleInit {
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
