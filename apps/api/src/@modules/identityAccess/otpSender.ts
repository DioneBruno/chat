import { Logger } from '@modules/shared/util/logger';

/**
 * Canal de envio do OTP AINDA NÃO DEFINIDO (CLAUDE.md seção 19.3). O contrato
 * isola a decisão: WhatsApp/e-mail/SMS serão implementações desta interface.
 */
export interface OtpSender {
  send(input: {
    tenantId: string;
    attendanceId: string;
    code: string;
    expiresAt: Date;
  }): Promise<void>;
}
export const OTP_SENDER = Symbol('OTP_SENDER');

/** Implementação de desenvolvimento: só registra no log, e apenas se OTP_DEV_LOG=true. */
export class DevLogOtpSender implements OtpSender {
  private readonly logger = new Logger('OtpSender');

  async send(input: { attendanceId: string; code: string }) {
    if (process.env.OTP_DEV_LOG === 'true')
      this.logger.warn(
        `[DEV] OTP do atendimento ${input.attendanceId}: ${input.code}`,
      );
    else
      this.logger.warn(
        `OTP gerado para ${input.attendanceId}, mas nenhum canal de envio está configurado`,
      );
  }
}
