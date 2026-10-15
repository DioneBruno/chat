import { Injectable } from '@nestjs/common';
import type { BotTurnResult } from '../../domain/bot-provider.interface';
import type { MessageContent } from '../../../messages/messages.service';
import type { TypebotMessage, TypebotTurnResult } from './typebot.client';

interface RichTextBlock {
  children?: { text?: string }[];
}

/** Converte mensagens/inputs/choices do Typebot para o contrato próprio do chat (seção 11). */
@Injectable()
export class TypebotMessageMapper {
  toTurn(result: TypebotTurnResult): BotTurnResult {
    const messages: MessageContent[] = [];
    for (const m of result.messages ?? []) {
      const text = this.text(m);
      if (text) messages.push({ type: 'text', text });
    }
    let input: BotTurnResult['input'] = null;
    if (result.input) {
      const items = result.input.items ?? result.input.options?.items;
      if (result.input.type.includes('choice') && items?.length) {
        // A mensagem de opções é criada pelo orquestrador a partir deste input, para
        // coincidir sempre com a etapa ativa (escolhas antigas não valem).
        input = {
          type: 'options',
          options: items.map((i) => ({ id: i.id, label: i.content ?? '' })),
        };
      } else {
        input = { type: 'input', inputType: result.input.type };
      }
    }
    return { messages, input, providerSessionId: result.sessionId };
  }

  private text(message: TypebotMessage): string {
    const content = message.content as
      | { type?: string; markdown?: string; richText?: RichTextBlock[] }
      | undefined;
    if (content?.type === 'markdown') return content.markdown ?? '';
    if (content?.type === 'richText') {
      return (content.richText ?? [])
        .map((block) =>
          (block.children ?? []).map((c) => c.text ?? '').join(''),
        )
        .join('\n')
        .trim();
    }
    // Tipos não suportados no MVP (imagem, vídeo, embed…) não são renderizados no chat.
    return '';
  }
}
