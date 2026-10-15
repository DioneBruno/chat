import { Global, Module } from '@nestjs/common';
import { OutboxDispatcher } from './outbox.dispatcher';
import { OutboxService } from './outbox.service';
import { OutboxWorker } from './outbox.worker';

@Global()
@Module({
  providers: [OutboxService, OutboxDispatcher, OutboxWorker],
  exports: [OutboxService, OutboxDispatcher, OutboxWorker],
})
export class OutboxModule {}
