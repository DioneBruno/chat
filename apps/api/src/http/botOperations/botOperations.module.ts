import { Module } from '@nestjs/common';
import { criarProvedor } from '@http/shared/criarProvedor';
import { OutboxService } from '@modules/outbox/outbox.service';
import { DatabaseService } from '@modules/shared/database/database.service';
import { BotModule } from '@http/bot/bot.module';
import { BotInternalController } from '@http/botOperations/botInternal.controller';
import { BotOperationsService } from '@modules/botOperations/botOperations.service';
import { BotOperationsWorker } from '@modules/botOperations/botOperations.worker';
import {
  OperationExecutorRegistry,
  SimulatedExecutors,
} from '@modules/botOperations/operationExecutors';

@Module({
  imports: [BotModule],
  controllers: [BotInternalController],
  providers: [
    criarProvedor(BotOperationsService, [
      DatabaseService,
      OutboxService,
      OperationExecutorRegistry,
    ]),
    criarProvedor(BotOperationsWorker, [
      BotOperationsService,
      OperationExecutorRegistry,
    ]),
    criarProvedor(OperationExecutorRegistry),
    criarProvedor(SimulatedExecutors, [OperationExecutorRegistry]),
  ],
  exports: [
    BotOperationsService,
    BotOperationsWorker,
    OperationExecutorRegistry,
  ],
})
export class BotOperationsModule {}
