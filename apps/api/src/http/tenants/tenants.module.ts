import { Module } from '@nestjs/common';
import { criarProvedor } from '@http/shared/criarProvedor';
import { DatabaseService } from '@modules/shared/database/database.service';
import { DevSeedService } from '@modules/tenants/devSeed.service';
import { TenantsService } from '@modules/tenants/tenants.service';

@Module({
  providers: [
    criarProvedor(TenantsService, [DatabaseService]),
    criarProvedor(DevSeedService, [TenantsService]),
  ],
  exports: [TenantsService],
})
export class TenantsModule {}
