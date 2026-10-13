/**
 * Endpoints descartáveis da POC #1 — sem tenant, sem protocolo real, sem
 * Postgres. O Nest aqui é a fonte da verdade do estado do chat (keyed por
 * UUID), não o cliente. Não usar como base para os módulos reais de
 * `bot`/`attendances`.
 */
import { Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { extractBotText, TypebotPocClient, TypebotTurnResult } from './typebot-poc.client';
import { ChatState, TypebotPocStore } from './typebot-poc.store';

@Controller('poc/chats')
export class TypebotPocController {
  constructor(
    private readonly client: TypebotPocClient,
    private readonly store: TypebotPocStore,
  ) {}

  @Post()
  async create() {
    const result = await this.client.startChat();
    const chat = this.store.create(result.sessionId!);
    this.applyTurn(chat, result);
    return this.toDto(chat);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.toDto(this.findOrFail(id));
  }

  @Post(':id/messages')
  async continue(@Param('id') id: string, @Body() body: { text: string }) {
    const chat = this.findOrFail(id);
    chat.messages.push({ from: 'user', text: body.text });
    const result = await this.client.continueChat(chat.typebotSessionId, body.text);
    this.applyTurn(chat, result);
    return this.toDto(chat);
  }

  private findOrFail(id: string): ChatState {
    const chat = this.store.get(id);
    if (!chat) {
      throw new NotFoundException(`chat ${id} não encontrado`);
    }
    return chat;
  }

  private applyTurn(chat: ChatState, result: TypebotTurnResult) {
    for (const message of result.messages ?? []) {
      chat.messages.push({ from: 'bot', text: extractBotText(message) });
    }
    chat.input = result.input ?? null;
    chat.isFinished = !result.input;
  }

  private toDto(chat: ChatState) {
    return {
      chatId: chat.id,
      messages: chat.messages,
      input: chat.input,
      isFinished: chat.isFinished,
    };
  }
}
