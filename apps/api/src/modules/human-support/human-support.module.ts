import { Module } from '@nestjs/common';
import { AttendancesModule } from '../attendances/attendances.module';
import { IntegrationInboxModule } from '../integration-inbox/integration-inbox.module';
import { MessagesModule } from '../messages/messages.module';
import { HumanSupportService } from './application/human-support.service';
import { HUMAN_SUPPORT_PROVIDER } from './domain/human-support-provider.interface';
import { ChatwootClient } from './infrastructure/chatwoot/chatwoot.client';
import { ChatwootProvider } from './infrastructure/chatwoot/chatwoot.provider';
import { ChatwootWebhookController } from './infrastructure/chatwoot/chatwoot-webhook.controller';

@Module({
  imports: [AttendancesModule, MessagesModule, IntegrationInboxModule],
  controllers: [ChatwootWebhookController],
  providers: [
    HumanSupportService,
    ChatwootClient,
    ChatwootProvider,
    { provide: HUMAN_SUPPORT_PROVIDER, useExisting: ChatwootProvider },
  ],
  exports: [HumanSupportService],
})
export class HumanSupportModule {}
