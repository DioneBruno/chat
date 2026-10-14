/**
 * Store em memória da POC #1 — mantém o estado do chat endereçado por um
 * UUID próprio (distinto do sessionId do Typebot), pra não depender de
 * localStorage no cliente. Some ao reiniciar o processo: não é a
 * persistência real (isso vem na "Fundação persistente", seção 18 do
 * CLAUDE.md, com Postgres).
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { extractBotText, TypebotInput, TypebotTurnResult } from './typebot-poc.client';

export interface ChatMessage {
  from: 'bot' | 'user';
  text: string;
}

export interface ChatState {
  id: string;
  typebotSessionId: string;
  messages: ChatMessage[];
  input: TypebotInput | null;
  isFinished: boolean;
  /** POC #2: operação assíncrona em andamento (no máx. uma por chat). */
  pendingOperationId: string | null;
}

@Injectable()
export class TypebotPocStore {
  private readonly chats = new Map<string, ChatState>();

  create(typebotSessionId: string, id: string = randomUUID()): ChatState {
    const chat: ChatState = {
      id,
      typebotSessionId,
      messages: [],
      input: null,
      isFinished: false,
      pendingOperationId: null,
    };
    this.chats.set(chat.id, chat);
    return chat;
  }

  get(id: string): ChatState | undefined {
    return this.chats.get(id);
  }

  applyTurn(chat: ChatState, result: TypebotTurnResult) {
    for (const message of result.messages ?? []) {
      chat.messages.push({ from: 'bot', text: extractBotText(message) });
    }
    chat.input = result.input ?? null;
    chat.isFinished = !result.input;
  }

  toDto(chat: ChatState) {
    const waiting = chat.pendingOperationId !== null;
    return {
      chatId: chat.id,
      messages: chat.messages,
      // Enquanto há operação pendente o input do Typebot (usado só para a
      // retomada programática) fica oculto para o consumidor.
      input: waiting ? null : chat.input,
      isFinished: chat.isFinished,
      pendingOperationId: chat.pendingOperationId,
    };
  }
}
