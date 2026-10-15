/**
 * POC #3. Autenticação dos endpoints é estática (segredo em header/query);
 * a versão real usa credencial de execução de curta duração (bot) e valida
 * a origem do webhook conforme o que a versão do Chatwoot suportar.
 */
import { Body, ConflictException, Controller, ForbiddenException, Headers, HttpCode, Post, Req } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ChatwootPocService } from './chatwoot-poc.service';

@Controller()
export class ChatwootPocController {
  constructor(private readonly service: ChatwootPocService) {}

  private checkBotSecret(secret?: string) {
    const expected = process.env.BOT_INTERNAL_SECRET;
    if (expected && secret !== expected) throw new ForbiddenException();
  }

  @Post('internal/bot/handoff')
  async handoff(@Headers('x-bot-secret') secret: string | undefined, @Body() body: { chatId: string }) {
    this.checkBotSecret(secret);
    try {
      return await this.service.handoff(body.chatId);
    } catch (error) {
      throw new ConflictException((error as Error).message);
    }
  }

  @Post('internal/bot/close')
  async close(
    @Headers('x-bot-secret') secret: string | undefined,
    @Body() body: { chatId: string; reason?: string },
  ) {
    this.checkBotSecret(secret);
    return this.service.close(body.chatId, body.reason ?? 'bot_resolved');
  }

  /**
   * O Chatwoot assina o webhook do inbox: `X-Chatwoot-Signature: sha256=HMAC(secret, "<ts>.<corpo>")`
   * com `X-Chatwoot-Timestamp`. Validamos assinatura e janela de tempo (anti-replay).
   */
  @Post('webhooks/chatwoot')
  @HttpCode(200)
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-chatwoot-signature') signature: string | undefined,
    @Headers('x-chatwoot-timestamp') timestamp: string | undefined,
    @Body() body: Parameters<ChatwootPocService['handleWebhook']>[0],
  ) {
    const secret = process.env.CHATWOOT_WEBHOOK_SECRET;
    if (secret) {
      const age = Math.abs(Date.now() / 1000 - Number(timestamp));
      const expected = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${req.rawBody?.toString('utf8') ?? ''}`).digest('hex')}`;
      const valid =
        !!signature &&
        signature.length === expected.length &&
        timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
      if (!valid || !(age < 300)) throw new ForbiddenException();
    }
    return this.service.handleWebhook(body);
  }
}
