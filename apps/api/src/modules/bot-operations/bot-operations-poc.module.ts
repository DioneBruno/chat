import { Module } from '@nestjs/common';
import { TypebotPocModule } from '../bot/infrastructure/typebot/typebot-poc.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { BotOperationsPocController } from './bot-operations-poc.controller';
import { BotOperationsPocService } from './bot-operations-poc.service';

/** Módulo temporário da POC #2. */
@Module({
  imports: [TypebotPocModule, RealtimeModule],
  controllers: [BotOperationsPocController],
  providers: [BotOperationsPocService],
})
export class BotOperationsPocModule {}
