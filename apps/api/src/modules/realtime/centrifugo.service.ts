/**
 * POC #2 — publicação e tokens do Centrifugo. Eventos são apenas sinais
 * (o banco/store é a fonte da verdade); falha de publicação não derruba
 * a operação.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';

export type RealtimeEvent =
  | 'bot.operation.started'
  | 'bot.operation.completed'
  | 'bot.operation.failed'
  | 'message.created';

@Injectable()
export class CentrifugoService {
  private readonly logger = new Logger(CentrifugoService.name);
  private readonly apiUrl = process.env.CENTRIFUGO_API_URL ?? 'http://localhost:8000/api';
  private readonly apiKey = process.env.CENTRIFUGO_API_KEY ?? 'poc-api-key';
  private readonly hmacSecret = process.env.CENTRIFUGO_HMAC_SECRET ?? 'poc-hmac-secret';

  channelFor(chatId: string) {
    return `attendance:${chatId}`;
  }

  async publish(chatId: string, event: RealtimeEvent, payload: Record<string, unknown> = {}) {
    try {
      const response = await fetch(`${this.apiUrl}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey },
        body: JSON.stringify({ channel: this.channelFor(chatId), data: { event, ...payload } }),
      });
      if (!response.ok) this.logger.warn(`publish ${event} -> HTTP ${response.status}`);
    } catch (error) {
      this.logger.warn(`publish ${event} falhou: ${(error as Error).message}`);
    }
  }

  /** Tokens de conexão e de assinatura (HS256) para o canal do atendimento. */
  tokensFor(chatId: string) {
    const channel = this.channelFor(chatId);
    return {
      channel,
      connectionToken: this.sign({ sub: chatId }),
      subscriptionToken: this.sign({ sub: chatId, channel }),
    };
  }

  private sign(claims: Record<string, unknown>) {
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...claims, exp })}`;
    return `${data}.${createHmac('sha256', this.hmacSecret).update(data).digest('base64url')}`;
  }
}
