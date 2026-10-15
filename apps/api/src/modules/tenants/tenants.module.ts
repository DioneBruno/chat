import { Module } from '@nestjs/common';
import { DevSeedService } from './dev-seed.service';
import { TenantsService } from './tenants.service';

@Module({
  providers: [TenantsService, DevSeedService],
  exports: [TenantsService],
})
export class TenantsModule {}
