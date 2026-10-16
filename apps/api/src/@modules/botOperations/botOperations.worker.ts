import { Logger } from '@modules/shared/util/logger';
import { BotOperationsService } from '@modules/botOperations/botOperations.service';
import type { BotOperation } from '@modules/botOperations/botOperations.service';
import { OperationExecutorRegistry } from '@modules/botOperations/operationExecutors';

/** Worker de operações assíncronas (seção 13): polling no PostgreSQL, sem transação durante o HTTP. */
export class BotOperationsWorker {
  private readonly logger = new Logger(BotOperationsWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  batchSize = Number(process.env.OPERATIONS_BATCH_SIZE ?? 10);

  constructor(
    private readonly operations: BotOperationsService,
    private readonly registry: OperationExecutorRegistry,
  ) {}

  onModuleInit() {
    if (process.env.OPERATIONS_WORKER === 'false') return;
    this.timer = setInterval(
      () => void this.tick(),
      Number(process.env.OPERATIONS_WORKER_INTERVAL_MS ?? 500),
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
      while (!this.stopped && (await this.runOnce()) > 0);
    } catch (error) {
      this.logger.error(
        `falha no ciclo de operações: ${(error as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }

  async runOnce(): Promise<number> {
    const leaseMs = Number(process.env.OPERATIONS_LEASE_MS ?? 60_000);
    const ops = await this.operations.claim(this.batchSize, leaseMs);
    await Promise.all(ops.map((op) => this.execute(op)));
    return ops.length;
  }

  private async execute(op: BotOperation) {
    const executor = this.registry.get(op.action);
    if (!executor)
      return void (await this.operations.fail(op, 'ação desconhecida'));
    // Reivindicação repetida de operação mutável = resultado desconhecido: nunca reexecutar.
    if (executor.mutating && op.attempts > 1)
      return void (await this.operations.fail(
        op,
        'resultado desconhecido (worker caiu)',
      ));
    try {
      const result = await executor.execute({
        tenantId: op.tenantId,
        attendanceId: op.attendanceId,
        operationId: op.id,
        action: op.action,
        parameters: op.parameters,
        signal: AbortSignal.timeout(executor.timeoutMs ?? 15_000),
      });
      await this.operations.complete(op, result.text);
    } catch (error) {
      this.logger.warn(
        `operação ${op.id} (${op.action}) falhou, tentativa ${op.attempts}/${op.maxAttempts}: ${(error as Error).message}`,
      );
      await this.operations.retryOrFail(op, (error as Error).message);
    }
  }
}
