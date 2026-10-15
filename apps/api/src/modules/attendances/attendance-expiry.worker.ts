import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AttendancesService } from './attendances.service';

/** Worker de polling no PostgreSQL (sem filas no MVP, seção 2). */
@Injectable()
export class AttendanceExpiryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AttendanceExpiryWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly attendances: AttendancesService) {}

  onModuleInit() {
    if (process.env.EXPIRY_WORKER === 'false') return;
    this.timer = setInterval(
      () => void this.tick(),
      Number(process.env.EXPIRY_WORKER_INTERVAL_MS ?? 30_000),
    );
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const a of await this.attendances.expireDue()) {
        this.logger.log(
          `atendimento ${a.id} (tenant ${a.tenantId}) expirado: ${a.closedReason} (autor: system)`,
        );
      }
    } catch (error) {
      this.logger.error(
        `falha ao expirar atendimentos: ${(error as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }
}
