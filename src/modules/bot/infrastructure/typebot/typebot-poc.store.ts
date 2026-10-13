/**
 * Store em memória da POC #1 — mantém o estado do chat endereçado por um
 * UUID próprio (distinto do sessionId do Typebot), pra não depender de
 * localStorage no cliente. Some ao reiniciar o processo: não é a
 * persistência real (isso vem na "Fundação persistente", seção 18 do
 * CLAUDE.md, com Postgres).
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TypebotInput } from './typebot-poc.client';

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
}

@Injectable()
export class TypebotPocStore {
  private readonly chats = new Map<string, ChatState>();

  create(typebotSessionId: string): ChatState {
    const chat: ChatState = {
      id: randomUUID(),
      typebotSessionId,
      messages: [],
      input: null,
      isFinished: false,
    };
    this.chats.set(chat.id, chat);
    return chat;
  }

  get(id: string): ChatState | undefined {
    return this.chats.get(id);
  }
}
