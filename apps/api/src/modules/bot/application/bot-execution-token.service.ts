import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

export interface BotExecutionClaims {
  tenantId: string;
  attendanceId: string;
  botSessionId: string;
  /** Ações que o bot desta sessão pode pedir (`*` = ver `BotInternalController`). */
  scope: string[];
}

interface Payload extends BotExecutionClaims {
  exp: number;
}

/**
 * Credencial de execução do bot (seções 13/15): vinculada a tenant, protocolo, sessão
 * e escopo. O Typebot a guarda como variável do fluxo. Além da validade (`exp`), o
 * servidor confere a cada chamada se a sessão ainda está viva — a credencial morre
 * junto com a sessão.
 */
@Injectable()
export class BotExecutionTokenService {
  private readonly ttlMs =
    Number(process.env.BOT_TOKEN_TTL_MINUTES ?? 24 * 60) * 60_000;

  private get secret() {
    return (
      process.env.BOT_EXECUTION_SECRET ??
      process.env.ACCESS_SESSION_SECRET ??
      'poc-bot-execution-secret-change-me'
    );
  }

  issue(claims: BotExecutionClaims, now = Date.now()): string {
    const body = Buffer.from(
      JSON.stringify({ ...claims, exp: now + this.ttlMs } satisfies Payload),
    ).toString('base64url');
    return `bx1.${body}.${this.sign(body)}`;
  }

  verify(token: string | undefined, now = Date.now()): BotExecutionClaims {
    const [prefix, body, signature] = (token ?? '').split('.');
    if (prefix !== 'bx1' || !body || !signature)
      throw new UnauthorizedException();
    const expected = this.sign(body);
    const ok =
      signature.length === expected.length &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!ok) throw new UnauthorizedException();
    let payload: Payload;
    try {
      payload = JSON.parse(
        Buffer.from(body, 'base64url').toString('utf8'),
      ) as Payload;
    } catch {
      throw new UnauthorizedException();
    }
    if (!(payload.exp > now))
      throw new UnauthorizedException('credencial expirada');
    return {
      tenantId: payload.tenantId,
      attendanceId: payload.attendanceId,
      botSessionId: payload.botSessionId,
      scope: payload.scope,
    };
  }

  private sign(body: string) {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}
