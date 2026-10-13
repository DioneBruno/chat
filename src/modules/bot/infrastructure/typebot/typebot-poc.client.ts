/**
 * Cliente mínimo para a API de chat do Typebot, usado apenas pela POC #1
 * (ver /home/dione/.claude/plans/shimmering-puzzling-wave.md).
 *
 * Contrato real confirmado em docs.typebot.com/api-reference/chat/*:
 * - startChat: POST /api/v1/typebots/{publicId}/startChat
 * - continueChat: POST /api/v1/sessions/{sessionId}/continueChat
 * - Resposta a texto livre e a escolha de opção usam o mesmo formato
 *   { message: { type: 'text', text: '<valor>' } } — a doc oficial não
 *   confirma isso para "choice input", então validamos na prática.
 */
import { Injectable } from '@nestjs/common';

export interface TypebotMessage {
  id: string;
  type: string;
  content: unknown;
}

export interface TypebotInputOption {
  id: string;
  content?: string;
}

export interface TypebotInput {
  id: string;
  type: string;
  options?: {
    items?: TypebotInputOption[];
    labels?: { placeholder?: string; button?: string };
  };
}

export interface TypebotTurnResult {
  sessionId?: string;
  messages: TypebotMessage[];
  input?: TypebotInput;
}

@Injectable()
export class TypebotPocClient {
  private readonly apiUrl = process.env.TYPEBOT_API_URL ?? 'http://localhost:8081/api';
  private readonly typebotId = process.env.TYPEBOT_ID ?? '';
  private readonly apiToken = process.env.TYPEBOT_API_TOKEN ?? '';

  async startChat(): Promise<TypebotTurnResult> {
    const response = await fetch(`${this.apiUrl}/v1/typebots/${this.typebotId}/startChat`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({}),
    });
    return this.parse(response);
  }

  async continueChat(sessionId: string, text: string): Promise<TypebotTurnResult> {
    const response = await fetch(`${this.apiUrl}/v1/sessions/${sessionId}/continueChat`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ message: { type: 'text', text } }),
    });
    return this.parse(response);
  }

  private headers() {
    return {
      'Content-Type': 'application/json',
      ...(this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {}),
    };
  }

  private async parse(response: Response): Promise<TypebotTurnResult> {
    const body = await response.json();
    if (!response.ok) {
      throw new Error(`Typebot API error ${response.status}: ${JSON.stringify(body)}`);
    }
    return body as TypebotTurnResult;
  }
}
