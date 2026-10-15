/**
 * POC #3 — handoff Typebot → Chatwoot → Typebot (pós-atendimento).
 * Estado em memória; a versão real usa human_sessions, outbox e
 * integration_inbox no Postgres (seções 10 e 12 do CLAUDE.md).
 * O NestJS é o único que muda a fase: o Chatwoot só avisa por webhook.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { TypebotPocClient } from '../../../bot/infrastructure/typebot/typebot-poc.client';
import { ChatState, TypebotPocStore } from '../../../bot/infrastructure/typebot/typebot-poc.store';
import { CentrifugoService } from '../../../realtime/centrifugo.service';
import { ChatwootPocClient } from './chatwoot-poc.client';

interface ChatwootWebhook {
  event: string;
  id?: number;
  message_type?: string;
  private?: boolean;
  content?: string;
  status?: string;
  sender?: { type?: string };
  conversation?: { id: number; status?: string };
}

@Injectable()
export class ChatwootPocService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatwootPocService.name);
  private readonly postServiceTypebotId = process.env.TYPEBOT_POST_SERVICE_ID ?? 'poc-post-service';
  /** 60 min por padrão (CLAUDE.md seção 6); reduzível por env nos testes. */
  private readonly postServiceMs = Number(process.env.POST_SERVICE_INACTIVITY_MS ?? 60 * 60 * 1000);
  private readonly seenWebhooks = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly store: TypebotPocStore,
    private readonly typebot: TypebotPocClient,
    private readonly chatwoot: ChatwootPocClient,
    private readonly realtime: CentrifugoService,
  ) {}

  onModuleInit() {
    this.store.humanRelay = (chat, text) => this.relayConsumerMessage(chat, text);
    this.timer = setInterval(() => void this.expireInactive(), 1000);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** Chamado pelo bloco HTTP do Typebot. Idempotente por fase. */
  async handoff(chatId: string) {
    const chat = this.requireOpen(chatId);
    if (chat.phase === 'handoff_pending' || chat.phase === 'human') return { phase: chat.phase };

    chat.phase = 'handoff_pending'; // transitório e recuperável
    chat.input = null;
    chat.messages.push({ from: 'system', text: 'Transferindo para um atendente…' });
    await this.signal(chat);

    try {
      if (!chat.humanContactId) {
        const contact = await this.chatwoot.createContact(chat.id, `Consumidor ${chat.id.slice(0, 8)}`);
        chat.humanContactId = contact.contactId;
        chat.humanSourceId = contact.sourceId;
      }
            chat.humanConversationId = await this.chatwoot.createConversation(chat.humanSourceId!, chat.humanContactId!, chat.id);
      // Contexto mínimo permitido: só as mensagens da conversa, como nota interna.
      const context = chat.messages
        .filter((m) => m.from !== 'system')
        .map((m) => `${m.from === 'user' ? 'Consumidor' : 'Bot'}: ${m.text}`)
        .join('\n');
      await this.chatwoot.sendMessage(chat.humanConversationId, `Contexto do atendimento:\n${context}`, { private: true });
      for (const text of chat.queuedForHuman.splice(0)) {
        await this.chatwoot.sendMessage(chat.humanConversationId, text);
      }
      chat.phase = 'human';
    } catch (error) {
      // Permanece em handoff_pending: recuperável (a versão real reprocessa via outbox).
      this.logger.error(`handoff falhou: ${(error as Error).message}`);
      chat.messages.push({ from: 'system', text: 'Não foi possível contatar um atendente agora; tentaremos novamente.' });
    }
    await this.signal(chat);
    return { phase: chat.phase };
  }

  /** Mensagem do consumidor durante handoff_pending/human. A mensagem já está persistida no chat. */
  async relayConsumerMessage(chat: ChatState, text: string) {
    if (chat.phase === 'handoff_pending' || !chat.humanConversationId) {
      chat.queuedForHuman.push(text); // nunca perder mensagens
      return;
    }
    await this.chatwoot.sendMessage(chat.humanConversationId, text);
  }

  async close(chatId: string, reason: string) {
    const chat = this.store.get(chatId);
    if (!chat || chat.isFinished) return { closed: false };
    this.finish(chat, reason);
    await this.signal(chat);
    return { closed: true };
  }

  /** Webhook do Chatwoot: autenticado no controller; aqui deduplica e impede loops. */
  async handleWebhook(payload: ChatwootWebhook) {
    const conversationId = payload.conversation?.id ?? (payload.event.startsWith('conversation') ? (payload as unknown as { id: number }).id : undefined);
    const dedupeKey =
      payload.event === 'message_created'
        ? `msg:${payload.id}`
        : `${payload.event}:${conversationId}:${payload.status ?? payload.conversation?.status}`;
    if (this.seenWebhooks.has(dedupeKey)) return { ignored: 'duplicate' };
    this.seenWebhooks.add(dedupeKey);

    const chat = this.store.all().find((c) => c.humanConversationId === conversationId);
    if (!chat) return { ignored: 'unknown_conversation' };

    if (payload.event === 'message_created') {
      // Loop: o que nós mesmos enviamos (incoming do consumidor, notas privadas) volta no webhook.
      if (payload.message_type !== 'outgoing' || payload.private) return { ignored: 'not_agent_message' };
      if (chat.phase !== 'human' || chat.isFinished) return { ignored: 'wrong_phase' };
      chat.messages.push({ from: 'agent', text: payload.content ?? '' });
      await this.signal(chat);
      return { ok: true };
    }

    const status = payload.status ?? payload.conversation?.status;
    if (payload.event === 'conversation_status_changed' && status === 'resolved') {
      return this.returnToBot(chat);
    }
    return { ignored: 'event' };
  }

  /** Resolução no Chatwoot NÃO fecha o protocolo: abre nova sessão Typebot de pós-atendimento. */
  private async returnToBot(chat: ChatState) {
    if (chat.phase !== 'human' || chat.isFinished) return { ignored: 'wrong_phase' }; // idempotência por estado
    chat.phase = 'returning_to_bot';
    await this.signal(chat);
    try {
      const turn = await this.typebot.startChat({ chatId: chat.id }, this.postServiceTypebotId);
      chat.typebotSessionId = turn.sessionId!; // nova sessão: a anterior não é reaproveitada
      chat.phase = 'post_service';
      this.store.applyTurn(chat, turn);
      // Prazo conta a partir da persistência da pergunta de pós-atendimento.
      if (!chat.isFinished) chat.inactivityDeadlineAt = Date.now() + this.postServiceMs;
    } catch (error) {
      this.logger.error(`retorno ao bot falhou: ${(error as Error).message}`);
      chat.phase = 'human'; // recuperável: um novo evento de resolução tenta de novo
      return { error: 'returning_failed' };
    }
    await this.signal(chat);
    return { ok: true };
  }

  /** Worker: encerra pós-atendimento sem resposta. Condição de estado evita corrida com a resposta. */
  private async expireInactive() {
    const now = Date.now();
    for (const chat of this.store.all()) {
      if (chat.phase !== 'post_service' || chat.isFinished) continue;
      if (chat.inactivityDeadlineAt === null || chat.inactivityDeadlineAt > now) continue;
      this.finish(chat, 'post_service_inactivity');
      chat.messages.push({ from: 'system', text: 'Atendimento encerrado por inatividade.' });
      this.logger.log(`atendimento ${chat.id} encerrado: post_service_inactivity (autor: system)`);
      await this.signal(chat);
    }
  }

  private finish(chat: ChatState, reason: string) {
    chat.isFinished = true;
    chat.closedReason = reason;
    chat.input = null;
    chat.inactivityDeadlineAt = null;
    chat.pendingOperationId = null;
  }

  private requireOpen(chatId: string) {
    const chat = this.store.get(chatId);
    if (!chat || chat.isFinished) throw new Error('atendimento inexistente ou encerrado');
    return chat;
  }

  private async signal(chat: ChatState) {
    await this.realtime.publish(chat.id, 'message.created');
  }
}
