/**
 * POC #2 — operações assíncronas do bot. Fila em memória: a versão real
 * usa `bot_operations` no Postgres com `FOR UPDATE SKIP LOCKED` + lease
 * (seção 13 do CLAUDE.md). Aqui o objetivo é validar o contrato com o
 * Typebot e a entrega pelo Centrifugo sem nova mensagem do consumidor.
 *
 * ASYNC_RESUME_MODE:
 *  - `continue` (padrão): o fluxo Typebot fica parado num bloco de input
 *    e o Nest o avança via continueChat com o resultado.
 *  - `direct`: o Nest só publica o resultado como mensagem do bot
 *    (fallback caso o Typebot não aceite a retomada).
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TypebotPocClient } from '../bot/infrastructure/typebot/typebot-poc.client';
import { TypebotPocStore } from '../bot/infrastructure/typebot/typebot-poc.store';
import { CentrifugoService } from '../realtime/centrifugo.service';

export type OperationStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface BotOperation {
  id: string;
  chatId: string;
  action: string;
  idempotencyKey: string;
  status: OperationStatus;
  attempts: number;
  nextAttemptAt: number;
  result?: { text: string };
  error?: string;
}

const MAX_ATTEMPTS = 3;

@Injectable()
export class BotOperationsPocService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotOperationsPocService.name);
  private readonly operations = new Map<string, BotOperation>();
  private timer?: NodeJS.Timeout;
  private readonly simulatedMs = Number(process.env.OP_SIMULATED_MS ?? 5000);
  private readonly resumeMode = process.env.ASYNC_RESUME_MODE ?? 'continue';

  constructor(
    private readonly store: TypebotPocStore,
    private readonly client: TypebotPocClient,
    private readonly realtime: CentrifugoService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 500);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** Chamado pelo bloco HTTP do Typebot: registra e retorna na hora. */
  async enqueue(chatId: string, action: string, idempotencyKey?: string): Promise<BotOperation> {
    const chat = this.store.get(chatId);
    if (!chat || chat.isFinished) throw new Error('atendimento inexistente ou encerrado');

    const key = idempotencyKey ?? `${chatId}:${action}:${chat.messages.length}`;
    const existing = [...this.operations.values()].find(
      (op) => op.chatId === chatId && op.idempotencyKey === key,
    );
    if (existing) return existing; // retry do Typebot não duplica

    if (chat.pendingOperationId) return this.operations.get(chat.pendingOperationId)!; // 1 bloqueante por sessão

    const op: BotOperation = {
      id: randomUUID(),
      chatId,
      action,
      idempotencyKey: key,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: Date.now(),
    };
    this.operations.set(op.id, op);
    chat.pendingOperationId = op.id;
    await this.realtime.publish(chatId, 'bot.operation.started', { operationId: op.id });
    return op;
  }

  get(id: string) {
    return this.operations.get(id);
  }

  async tick() {
    const due = [...this.operations.values()].filter(
      (op) => op.status === 'pending' && op.nextAttemptAt <= Date.now(),
    );
    await Promise.all(due.map((op) => this.run(op)));
  }

  private async run(op: BotOperation) {
    op.status = 'processing'; // "claim" — em Postgres seria SKIP LOCKED + lease
    op.attempts += 1;
    try {
      const text = await this.simulateEnterpriseQuery(op);
      await this.complete(op, { text });
    } catch (error) {
      if (op.attempts < MAX_ATTEMPTS) {
        op.status = 'pending';
        op.nextAttemptAt = Date.now() + 1000 * 2 ** op.attempts;
        return;
      }
      await this.fail(op, (error as Error).message);
    }
  }

  private async simulateEnterpriseQuery(op: BotOperation) {
    await new Promise((resolve) => setTimeout(resolve, this.simulatedMs));
    if (op.action === 'customer.requests.fail') throw new Error('falha simulada');
    return 'Você tem 2 solicitações: #1042 (em análise) e #1038 (concluída).';
  }

  /** Conclusão idempotente: só a primeira chamada tem efeito. */
  async complete(op: BotOperation, result: { text: string }) {
    if (op.status === 'completed' || op.status === 'cancelled') return;
    const chat = this.store.get(op.chatId);
    // Resultado tardio não altera atendimento encerrado ou que mudou de estado.
    if (!chat || chat.isFinished || chat.pendingOperationId !== op.id) {
      op.status = 'cancelled';
      this.logger.warn(`operação ${op.id} descartada (atendimento mudou de estado)`);
      return;
    }
    op.status = 'completed';
    op.result = result;
    chat.pendingOperationId = null;

    if (this.resumeMode === 'continue') {
      try {
        const turn = await this.client.continueChat(chat.typebotSessionId, result.text);
        this.store.applyTurn(chat, turn);
      } catch (error) {
        // Não repete cegamente: o Typebot pode ter processado o avanço.
        this.logger.error(`continueChat falhou: ${(error as Error).message}`);
        chat.messages.push({ from: 'bot', text: result.text });
      }
    } else {
      chat.messages.push({ from: 'bot', text: result.text });
    }
    await this.realtime.publish(op.chatId, 'bot.operation.completed', { operationId: op.id });
    await this.realtime.publish(op.chatId, 'message.created');
  }

  private async fail(op: BotOperation, error: string) {
    op.status = 'failed';
    op.error = error;
    const chat = this.store.get(op.chatId);
    if (!chat || chat.pendingOperationId !== op.id) return;
    chat.pendingOperationId = null;
    chat.messages.push({ from: 'bot', text: 'Não consegui consultar suas informações agora. Tente novamente mais tarde.' });
    // O fluxo do Typebot continua parado no input de retomada; reabrir o input
    // para o consumidor é decisão do fluxo real (ver docs).
    await this.realtime.publish(op.chatId, 'bot.operation.failed', { operationId: op.id });
    await this.realtime.publish(op.chatId, 'message.created');
  }
}
