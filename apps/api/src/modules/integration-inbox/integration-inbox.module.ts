import { Module } from '@nestjs/common';
import { IntegrationInboxService } from './integration-inbox.service';

@Module({
  providers: [IntegrationInboxService],
  exports: [IntegrationInboxService],
})
export class IntegrationInboxModule {}
