import type { MessageContent } from '@modules/messages/messages.service';

/** Etapa ativa do fluxo, em contrato próprio do chat (não é o formato do Typebot). */
export type PendingInput =
  | { type: 'options'; options: { id: string; label: string }[] }
  | { type: 'input'; inputType: string };

export interface BotTurnResult {
  /** Mensagens do bot, já no contrato do chat (as opções do `input` são materializadas pelo orquestrador). */
  messages: MessageContent[];
  /** Próxima etapa esperada do consumidor; ausente = fluxo parou/terminou. */
  input: PendingInput | null;
  /** Só no `startSession`. */
  providerSessionId?: string;
}

export interface StartBotSessionInput {
  /** Fluxo já resolvido pelo NestJS (o browser nunca escolhe). */
  flow: {
    externalFlowId: string;
    endpoint: string;
    credentialsRef: string | null;
  };
  /** Variáveis pré-preenchidas; `chatId`/`botToken` carregam a credencial de execução. */
  variables: Record<string, string>;
}

export interface ContinueBotSessionInput {
  endpoint: string;
  credentialsRef: string | null;
  providerSessionId: string;
  text: string;
}

export interface BotProvider {
  startSession(input: StartBotSessionInput): Promise<BotTurnResult>;
  continueSession(input: ContinueBotSessionInput): Promise<BotTurnResult>;
}

export const BOT_PROVIDER = Symbol('BOT_PROVIDER');
