/**
 * Endpoints descartáveis da POC #1 — sem tenant, sem protocolo real, sem
 * Postgres. O Nest aqui é a fonte da verdade do estado do chat (keyed por
 * UUID), não o cliente. Não usar como base para os módulos reais de
 * `bot`/`attendances`.
 */
import { Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { TypebotPocClient } from './typebot-poc.client';
import { randomUUID } from 'crypto';
import { ChatState, TypebotPocStore } from './typebot-poc.store';

@Controller('poc/chats')
export class TypebotPocController {
  constructor(
    private readonly client: TypebotPocClient,
    private readonly store: TypebotPocStore,
  ) {}

  @Post()
  async create() {
    const chatId = randomUUID();
    const result = await this.client.startChat({ chatId });
    const chat = this.store.create(result.sessionId!, chatId);
    this.store.applyTurn(chat, result);
    return this.store.toDto(chat);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.store.toDto(this.findOrFail(id));
  }

  @Post(':id/messages')
  async continue(@Param('id') id: string, @Body() body: { text: string }) {
    const chat = this.findOrFail(id);
    chat.messages.push({ from: 'user', text: body.text });
    const result = await this.client.continueChat(chat.typebotSessionId, body.text);
    this.store.applyTurn(chat, result);
    return this.store.toDto(chat);
  }

  private findOrFail(id: string): ChatState {
    const chat = this.store.get(id);
    if (!chat) {
      throw new NotFoundException(`chat ${id} não encontrado`);
    }
    return chat;
  }
}
