import { Injectable } from '@nestjs/common';
import { PermanentOutboxError } from './outbox.errors';
import type { OutboxEvent } from './outbox.service';

export type OutboxHandler = (event: OutboxEvent) => Promise<void>;

/**
 * Registro de handlers por tipo de evento. A entrega é "ao menos uma vez": todo
 * handler precisa ser idempotente (reexecução após queda entre efeito e `complete`).
 */
@Injectable()
export class OutboxDispatcher {
  private readonly handlers = new Map<string, OutboxHandler>();

  register(type: string, handler: OutboxHandler) {
    if (this.handlers.has(type))
      throw new Error(`handler duplicado para o evento ${type}`);
    this.handlers.set(type, handler);
  }

  dispatch(event: OutboxEvent): Promise<void> {
    const handler = this.handlers.get(event.type);
    if (!handler)
      return Promise.reject(
        new PermanentOutboxError(`sem handler para o evento ${event.type}`),
      );
    return handler(event);
  }
}
