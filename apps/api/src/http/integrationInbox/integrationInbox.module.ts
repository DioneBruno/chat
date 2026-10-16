import { Module } from '@nestjs/common';
import { criarProvedor } from '@http/shared/criarProvedor';
import { DatabaseService } from '@modules/shared/database/database.service';
import { IntegrationInboxService } from '@modules/integrationInbox/integrationInbox.service';

@Module({
  providers: [criarProvedor(IntegrationInboxService, [DatabaseService])],
  exports: [IntegrationInboxService],
})
export class IntegrationInboxModule {}
