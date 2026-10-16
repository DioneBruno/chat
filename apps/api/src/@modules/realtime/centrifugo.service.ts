/**
 * Publicação e tokens do Centrifugo. Eventos são apenas sinais: o banco é a fonte da
 * verdade (seção 13) e o front re-busca o estado ao receber um sinal ou ao reconectar.
 * A publicação sai do outbox (depois da persistência) e, por isso, lança em caso de
 * falha para o evento ser repetido.
 */
import { createHmac } from 'crypto';

export class CentrifugoService {
  private readonly apiUrl =
    process.env.CENTRIFUGO_API_URL ?? 'http://localhost:8000/api';
  private readonly apiKey = process.env.CENTRIFUGO_API_KEY ?? 'poc-api-key';
  private readonly hmacSecret =
    process.env.CENTRIFUGO_HMAC_SECRET ?? 'poc-hmac-secret';

  channelFor(attendanceId: string) {
    return `attendance:${attendanceId}`;
  }

  async publish(
    attendanceId: string,
    event: string,
    payload: Record<string, unknown> = {},
  ) {
    const response = await fetch(`${this.apiUrl}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey },
      body: JSON.stringify({
        channel: this.channelFor(attendanceId),
        data: { event, ...payload },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new Error(`Centrifugo publish ${event} -> HTTP ${response.status}`);
    // A API HTTP do Centrifugo responde 200 com `error` no corpo em falhas de aplicação.
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    if (body.error)
      throw new Error(`Centrifugo publish ${event}: ${body.error.message}`);
  }

  /** Tokens de conexão e de assinatura (HS256) para o canal do atendimento. */
  tokensFor(attendanceId: string) {
    const channel = this.channelFor(attendanceId);
    return {
      channel,
      connectionToken: this.sign({ sub: attendanceId }),
      subscriptionToken: this.sign({ sub: attendanceId, channel }),
    };
  }

  private sign(claims: Record<string, unknown>) {
    const b64 = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...claims, exp })}`;
    return `${data}.${createHmac('sha256', this.hmacSecret).update(data).digest('base64url')}`;
  }
}
