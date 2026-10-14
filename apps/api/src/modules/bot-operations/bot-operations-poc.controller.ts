/**
 * POC #2. O endpoint interno aqui NÃO tem credencial de execução de curta
 * duração (seção 13/15 do CLAUDE.md): só um segredo estático opcional
 * (`BOT_INTERNAL_SECRET`) no header `x-bot-secret`.
 */
import { Body, Controller, ForbiddenException, Get, Headers, NotFoundException, Param, Post } from '@nestjs/common';
import { CentrifugoService } from '../realtime/centrifugo.service';
import { BotOperationsPocService } from './bot-operations-poc.service';
import { TypebotPocStore } from '../bot/infrastructure/typebot/typebot-poc.store';

@Controller()
export class BotOperationsPocController {
  constructor(
    private readonly operations: BotOperationsPocService,
    private readonly realtime: CentrifugoService,
    private readonly store: TypebotPocStore,
  ) {}

  @Post('internal/bot/operations')
  async create(
    @Headers('x-bot-secret') secret: string | undefined,
    @Body() body: { chatId: string; action: string; idempotencyKey?: string },
  ) {
    const expected = process.env.BOT_INTERNAL_SECRET;
    if (expected && secret !== expected) throw new ForbiddenException();
    const op = await this.operations.enqueue(body.chatId, body.action, body.idempotencyKey);
    return { operationId: op.id, status: op.status };
  }

  @Get('poc/operations/:id')
  get(@Param('id') id: string) {
    const op = this.operations.get(id);
    if (!op) throw new NotFoundException();
    return { operationId: op.id, status: op.status, attempts: op.attempts };
  }

  @Get('poc/chats/:id/realtime')
  realtimeTokens(@Param('id') id: string) {
    if (!this.store.get(id)) throw new NotFoundException();
    return this.realtime.tokensFor(id);
  }
}
