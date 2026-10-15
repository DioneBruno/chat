/**
 * Webhook do inbox API do Chatwoot. Assinatura: `X-Chatwoot-Signature: sha256=HMAC(secret,
 * "<timestamp>.<corpo bruto>")` + `X-Chatwoot-Timestamp` (validada na POC #3), com janela
 * anti-replay de 5 min. Responde rápido: o processamento roda no worker (outbox).
 */
import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { HumanSupportService } from '../../application/human-support.service';
import type { ChatwootWebhook } from '../../application/human-support.service';

@Controller('webhooks')
export class ChatwootWebhookController {
  constructor(private readonly service: HumanSupportService) {}

  @Post('chatwoot')
  @HttpCode(200)
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-chatwoot-signature') signature: string | undefined,
    @Headers('x-chatwoot-timestamp') timestamp: string | undefined,
    @Body() body: ChatwootWebhook,
  ) {
    const secret = process.env.CHATWOOT_WEBHOOK_SECRET;
    if (!secret) {
      // Sem segredo só em desenvolvimento: em produção o webhook sem assinatura é recusado.
      if (process.env.NODE_ENV === 'production') throw new ForbiddenException();
    } else {
      const age = Math.abs(Date.now() / 1000 - Number(timestamp));
      const expected = `sha256=${createHmac('sha256', secret)
        .update(`${timestamp}.${req.rawBody?.toString('utf8') ?? ''}`)
        .digest('hex')}`;
      const valid =
        !!signature &&
        signature.length === expected.length &&
        timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
      if (!valid || !(age < 300)) throw new ForbiddenException();
    }
    return this.service.receiveWebhook(body);
  }
}
