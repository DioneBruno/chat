/**
 * Endpoints descartáveis da POC #1 — sem tenant, sem protocolo, sem
 * persistência. Só repassam para a API do Typebot. Não usar como base
 * para os módulos reais de `bot`/`attendances`.
 */
import { Body, Controller, Post } from '@nestjs/common';
import { TypebotPocClient } from './typebot-poc.client';

@Controller('poc/typebot')
export class TypebotPocController {
  constructor(private readonly client: TypebotPocClient) {}

  @Post('start')
  start() {
    return this.client.startChat();
  }

  @Post('continue')
  continue(@Body() body: { sessionId: string; text: string }) {
    return this.client.continueChat(body.sessionId, body.text);
  }
}
