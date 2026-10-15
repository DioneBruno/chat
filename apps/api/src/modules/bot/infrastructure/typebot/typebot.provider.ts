import { Injectable } from '@nestjs/common';
import type {
  BotProvider,
  BotTurnResult,
  ContinueBotSessionInput,
  StartBotSessionInput,
} from '../../domain/bot-provider.interface';
import { TypebotMessageMapper } from './typebot-message.mapper';
import { TypebotClient } from './typebot.client';

/** Credenciais ficam em variável de ambiente/secret store; o banco guarda só a referência. */
const tokenFor = (ref: string | null) => (ref ? process.env[ref] : undefined);

@Injectable()
export class TypebotProvider implements BotProvider {
  constructor(
    private readonly client: TypebotClient,
    private readonly mapper: TypebotMessageMapper,
  ) {}

  async startSession(input: StartBotSessionInput): Promise<BotTurnResult> {
    const result = await this.client.startChat(
      input.flow.endpoint,
      tokenFor(input.flow.credentialsRef),
      input.flow.externalFlowId,
      input.variables,
    );
    return this.mapper.toTurn(result);
  }

  async continueSession(
    input: ContinueBotSessionInput,
  ): Promise<BotTurnResult> {
    const result = await this.client.continueChat(
      input.endpoint,
      tokenFor(input.credentialsRef),
      input.providerSessionId,
      input.text,
    );
    return this.mapper.toTurn(result);
  }
}
