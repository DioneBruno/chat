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
  from: 'bot' | 'user' | 'agent' | 'system';
  text: string;
}

/** Subconjunto de `AttendancePhase` (CLAUDE.md seção 9) usado na POC #3. */
export type ChatPhase = 'bot' | 'handoff_pending' | 'human' | 'returning_to_bot' | 'post_service';

export interface ChatState {
  id: string;
  typebotSessionId: string;
  messages: ChatMessage[];
  input: TypebotInput | null;
  isFinished: boolean;
  /** POC #2: operação assíncrona em andamento (no máx. uma por chat). */
  pendingOperationId: string | null;
  /** POC #3 */
  phase: ChatPhase;
  closedReason: string | null;
  humanConversationId: number | null;
  humanContactId: number | null;
  humanSourceId: string | null;
  /** Mensagens do consumidor recebidas em handoff_pending; encaminhadas ao confirmar o humano. */
  queuedForHuman: string[];
  inactivityDeadlineAt: number | null;
}

@Injectable()
export class TypebotPocStore {
  private readonly chats = new Map<string, ChatState>();

  /**
   * Gancho registrado pelo módulo do Chatwoot (evita dependência circular entre
   * módulos na POC). Na versão real é o serviço de orquestração que decide o responsável.
   */
  humanRelay: ((chat: ChatState, text: string) => Promise<void>) | null = null;

  all(): ChatState[] {
    return [...this.chats.values()];
  }

  create(typebotSessionId: string, id: string = randomUUID()): ChatState {
    const chat: ChatState = {
      id,
      typebotSessionId,
      messages: [],
      input: null,
      isFinished: false,
      pendingOperationId: null,
      phase: 'bot',
      closedReason: null,
      humanConversationId: null,
      humanContactId: null,
      humanSourceId: null,
      queuedForHuman: [],
      inactivityDeadlineAt: null,
    };
    this.chats.set(chat.id, chat);
    return chat;
  }

  remove(id: string) {
    this.chats.delete(id);
  }

  get(id: string): ChatState | undefined {
    return this.chats.get(id);
  }

  applyTurn(chat: ChatState, result: TypebotTurnResult) {
    for (const message of result.messages ?? []) {
      chat.messages.push({ from: 'bot', text: extractBotText(message) });
    }
    chat.input = result.input ?? null;
    if (!result.input && chat.phase === 'bot') chat.isFinished = true;
    if (!result.input && chat.phase === 'post_service') {
      chat.isFinished = true;
      chat.closedReason ??= 'bot_flow_ended';
    }
  }

  toDto(chat: ChatState) {
    const waiting = chat.pendingOperationId !== null;
    const botInputVisible = chat.phase === 'bot' || chat.phase === 'post_service';
    return {
      chatId: chat.id,
      messages: chat.messages,
      // Enquanto há operação pendente o input do Typebot (usado só para a
      // retomada programática) fica oculto para o consumidor.
      input: waiting || !botInputVisible ? null : chat.input,
      isFinished: chat.isFinished,
      pendingOperationId: chat.pendingOperationId,
      phase: chat.phase,
      closedReason: chat.closedReason,
      /** Na fase humana o texto livre vai ao atendente (não há input do bot). */
      canType: !chat.isFinished && (chat.phase === 'human' || chat.phase === 'handoff_pending'),
    };
  }
}
