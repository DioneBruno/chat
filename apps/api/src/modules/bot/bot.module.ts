import { Module } from '@nestjs/common';
import { AttendancesModule } from '../attendances/attendances.module';
import { MessagesModule } from '../messages/messages.module';
import { BotConfigService } from './application/bot-config.service';
import { BotDevSeedService } from './application/bot-dev-seed.service';
import { BotExecutionTokenService } from './application/bot-execution-token.service';
import { BotFlowResolverService } from './application/bot-flow-resolver.service';
import { BotOrchestratorService } from './application/bot-orchestrator.service';
import { BOT_PROVIDER } from './domain/bot-provider.interface';
import { TypebotMessageMapper } from './infrastructure/typebot/typebot-message.mapper';
import { TypebotProvider } from './infrastructure/typebot/typebot.provider';
import { TypebotClient } from './infrastructure/typebot/typebot.client';

@Module({
  imports: [AttendancesModule, MessagesModule],
  providers: [
    BotOrchestratorService,
    BotFlowResolverService,
    BotConfigService,
    BotDevSeedService,
    BotExecutionTokenService,
    TypebotClient,
    TypebotMessageMapper,
    TypebotProvider,
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
