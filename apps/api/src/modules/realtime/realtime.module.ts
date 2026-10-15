import { Module } from '@nestjs/common';
import { CentrifugoService } from './centrifugo.service';
import { RealtimeOutboxHandler } from './realtime-outbox.handler';

@Module({
  providers: [CentrifugoService, RealtimeOutboxHandler],
  exports: [CentrifugoService],
})
export class RealtimeModule {}
