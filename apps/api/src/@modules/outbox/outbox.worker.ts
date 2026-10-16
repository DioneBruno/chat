import { Logger } from '@modules/shared/util/logger';
import { OutboxDispatcher } from '@modules/outbox/outbox.dispatcher';
import {
  PermanentOutboxError,
  RetryLater,
} from '@modules/outbox/outbox.errors';
import { OutboxService } from '@modules/outbox/outbox.service';

/** Worker de polling no PostgreSQL. Réplicas podem rodar juntas: o claim usa SKIP LOCKED. */
export class OutboxWorker {
  private readonly logger = new Logger(OutboxWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private lastPurge = 0;
  batchSize = Number(process.env.OUTBOX_BATCH_SIZE ?? 20);
  leaseMs = Number(process.env.OUTBOX_LEASE_MS ?? 60_000);

  constructor(
    private readonly outbox: OutboxService,
    private readonly dispatcher: OutboxDispatcher,
  ) {}

  onModuleInit() {
    if (process.env.OUTBOX_WORKER === 'false') return;
    this.timer = setInterval(
      () => void this.tick(),
      Number(process.env.OUTBOX_WORKER_INTERVAL_MS ?? 500),
    );
  }

  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 20));
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // Esvazia enquanto houver trabalho (eventos encadeiam outros); depois espera o próximo tick.
      while (!this.stopped && (await this.runOnce()) > 0);
    } catch (error) {
      this.logger.error(
        `falha no ciclo do outbox: ${(error as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }

  /** Uma vez por hora remove eventos concluídos além da retenção (`OUTBOX_RETENTION_DAYS`, 7). */
  private async purgeIfDue() {
    if (Date.now() - this.lastPurge < 3_600_000) return;
    this.lastPurge = Date.now();
    const removed = await this.outbox.purgeDone(
      Number(process.env.OUTBOX_RETENTION_DAYS ?? 7),
    );
    if (removed)
      this.logger.log(`${removed} eventos concluídos removidos (retenção)`);
  }

  /** Reivindica e processa um lote. Eventos de atendimentos diferentes rodam em paralelo. */
  async runOnce(): Promise<number> {
    const events = await this.outbox.claim(this.batchSize, this.leaseMs);
    await Promise.all(
      events.map(async (event) => {
        try {
          await this.dispatcher.dispatch(event);
          await this.outbox.complete(event);
        } catch (error) {
          const message = (error as Error).message;
          if (error instanceof RetryLater) {
            await this.outbox.fail(event, message, { delayMs: error.delayMs });
          } else if (error instanceof PermanentOutboxError) {
            this.logger.error(
              `evento ${event.type} ${event.id} descartado: ${message}`,
            );
            await this.outbox.fail(event, message, { permanent: true });
          } else {
            this.logger.warn(
              `evento ${event.type} ${event.id} falhou (tentativa ${event.attempts}/${event.maxAttempts}): ${message}`,
            );
            await this.outbox.fail(event, message);
          }
        }
      }),
    );
    return events.length;
  }
}
