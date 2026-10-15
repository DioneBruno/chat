import { Injectable, OnModuleInit } from '@nestjs/common';
import { OutboxDispatcher } from '../outbox/outbox.dispatcher';
import { PermanentOutboxError } from '../outbox/outbox.errors';
import { CentrifugoService } from './centrifugo.service';

/** `realtime.publish`: entrega o sinal ao Centrifugo depois que a mudança foi persistida. */
@Injectable()
export class RealtimeOutboxHandler implements OnModuleInit {
  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly centrifugo: CentrifugoService,
  ) {}

  onModuleInit() {
    this.dispatcher.register('realtime.publish', async (event) => {
      const { event: name, ...payload } = event.payload as { event?: string };
      if (!name || !event.attendanceId)
        throw new PermanentOutboxError(
          'realtime.publish sem event/attendanceId',
        );
      await this.centrifugo.publish(event.attendanceId, name, payload);
    });
  }
}
