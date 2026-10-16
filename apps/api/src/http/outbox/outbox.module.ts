import { Global, Module } from '@nestjs/common';
import { criarProvedor } from '@http/shared/criarProvedor';
import { DatabaseService } from '@modules/shared/database/database.service';
import { OutboxDispatcher } from '@modules/outbox/outbox.dispatcher';
import { OutboxService } from '@modules/outbox/outbox.service';
import { OutboxWorker } from '@modules/outbox/outbox.worker';

@Global()
@Module({
  providers: [
    criarProvedor(OutboxService, [DatabaseService]),
    criarProvedor(OutboxDispatcher),
    criarProvedor(OutboxWorker, [OutboxService, OutboxDispatcher]),
  ],
  exports: [OutboxService, OutboxDispatcher, OutboxWorker],
})
export class OutboxModule {}
