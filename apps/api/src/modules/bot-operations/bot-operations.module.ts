import { Module } from '@nestjs/common';
import { BotModule } from '../bot/bot.module';
import { BotInternalController } from './bot-internal.controller';
import { BotOperationsService } from './bot-operations.service';
import { BotOperationsWorker } from './bot-operations.worker';
import {
  OperationExecutorRegistry,
  SimulatedExecutors,
} from './operation-executors';

@Module({
  imports: [BotModule],
  controllers: [BotInternalController],
  providers: [
    BotOperationsService,
    BotOperationsWorker,
    OperationExecutorRegistry,
    SimulatedExecutors,
  ],
  exports: [
    BotOperationsService,
    BotOperationsWorker,
    OperationExecutorRegistry,
  ],
})
export class BotOperationsModule {}
