import { Module } from '@nestjs/common';
import { criarProvedor } from '@http/shared/criarProvedor';
import { AttendancesService } from '@modules/attendances/attendances.service';
import { IntegrationInboxService } from '@modules/integrationInbox/integrationInbox.service';
import { MessagesService } from '@modules/messages/messages.service';
import { OutboxDispatcher } from '@modules/outbox/outbox.dispatcher';
import { OutboxService } from '@modules/outbox/outbox.service';
import { DatabaseService } from '@modules/shared/database/database.service';
import { AttendancesModule } from '@http/attendances/attendances.module';
import { IntegrationInboxModule } from '@http/integrationInbox/integrationInbox.module';
import { MessagesModule } from '@http/messages/messages.module';
import { HumanSupportService } from '@modules/humanSupport/humanSupport.service';
import { HUMAN_SUPPORT_PROVIDER } from '@modules/humanSupport/humanSupportProvider.interface';
import { ChatwootClient } from '@modules/humanSupport/chatwoot/chatwoot.client';
import { ChatwootProvider } from '@modules/humanSupport/chatwoot/chatwoot.provider';
import { ChatwootWebhookController } from '@http/humanSupport/chatwootWebhook.controller';

@Module({
  imports: [AttendancesModule, MessagesModule, IntegrationInboxModule],
  controllers: [ChatwootWebhookController],
  providers: [
    criarProvedor(HumanSupportService, [
      DatabaseService,
      AttendancesService,
      MessagesService,
      IntegrationInboxService,
      OutboxService,
      OutboxDispatcher,
      HUMAN_SUPPORT_PROVIDER,
    ]),
    criarProvedor(ChatwootClient),
    criarProvedor(ChatwootProvider, [ChatwootClient]),
    { provide: HUMAN_SUPPORT_PROVIDER, useExisting: ChatwootProvider },
  ],
  exports: [HumanSupportService],
})
export class HumanSupportModule {}
