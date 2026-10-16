import { Module } from '@nestjs/common';
import { criarProvedor } from '@http/shared/criarProvedor';
import { OutboxDispatcher } from '@modules/outbox/outbox.dispatcher';
import { CentrifugoService } from '@modules/realtime/centrifugo.service';
import { RealtimeOutboxHandler } from '@modules/realtime/realtimeOutbox.handler';

@Module({
  providers: [
    criarProvedor(CentrifugoService),
    criarProvedor(RealtimeOutboxHandler, [OutboxDispatcher, CentrifugoService]),
  ],
  exports: [CentrifugoService],
})
export class RealtimeModule {}
