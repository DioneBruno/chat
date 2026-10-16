import { Module } from '@nestjs/common';
import { criarProvedor } from '@http/shared/criarProvedor';
import { AttendancesService } from '@modules/attendances/attendances.service';
import { MessagesService } from '@modules/messages/messages.service';
import { OutboxDispatcher } from '@modules/outbox/outbox.dispatcher';
import { OutboxService } from '@modules/outbox/outbox.service';
import { DatabaseService } from '@modules/shared/database/database.service';
import { AttendancesModule } from '@http/attendances/attendances.module';
import { MessagesModule } from '@http/messages/messages.module';
import { BotConfigService } from '@modules/bot/botConfig.service';
import { BotDevSeedService } from '@modules/bot/botDevSeed.service';
import { BotExecutionTokenService } from '@modules/bot/botExecutionToken.service';
import { BotFlowResolverService } from '@modules/bot/botFlowResolver.service';
import { BotOrchestratorService } from '@modules/bot/botOrchestrator.service';
import { BOT_PROVIDER } from '@modules/bot/botProvider.interface';
import { TypebotMessageMapper } from '@modules/bot/typebot/typebotMessage.mapper';
import { TypebotProvider } from '@modules/bot/typebot/typebot.provider';
import { TypebotClient } from '@modules/bot/typebot/typebot.client';

@Module({
  imports: [AttendancesModule, MessagesModule],
  providers: [
    criarProvedor(BotOrchestratorService, [
      DatabaseService,
      AttendancesService,
      MessagesService,
      BotFlowResolverService,
      BotExecutionTokenService,
      OutboxService,
      OutboxDispatcher,
      BOT_PROVIDER,
    ]),
    criarProvedor(BotFlowResolverService, [DatabaseService]),
    criarProvedor(BotConfigService, [DatabaseService]),
    criarProvedor(BotDevSeedService, [DatabaseService, BotConfigService]),
    criarProvedor(BotExecutionTokenService),
    criarProvedor(TypebotClient),
    criarProvedor(TypebotMessageMapper),
    criarProvedor(TypebotProvider, [TypebotClient, TypebotMessageMapper]),
    { provide: BOT_PROVIDER, useExisting: TypebotProvider },
  ],
  exports: [
    BotOrchestratorService,
    BotFlowResolverService,
    BotConfigService,
    BotExecutionTokenService,
    BOT_PROVIDER,
  ],
})
export class BotModule {}
