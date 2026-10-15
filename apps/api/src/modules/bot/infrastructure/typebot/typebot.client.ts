/**
 * Cliente da API de chat do Typebot v3.19.0 (contratos validados nas POCs #1–#3,
 * ver docs/poc-typebot-notas.md):
 * - startChat:    POST /v1/typebots/{publicId}/startChat
 * - continueChat: POST /v1/sessions/{sessionId}/continueChat  { message: { type:'text', text } }
 */
import { Injectable } from '@nestjs/common';

export interface TypebotMessage {
  id: string;
  type: string;
  content: unknown;
}

export interface TypebotInput {
  id: string;
  type: string;
  /** Itens do `choice input` na v3.19.0 (confirmado na execução real). */
  items?: { id: string; content?: string }[];
  /** Formato assumido na POC #1; não aparece na v3.19.0, mantido por compatibilidade. */
  options?: { items?: { id: string; content?: string }[] };
}

export interface TypebotTurnResult {
  sessionId?: string;
  messages: TypebotMessage[];
  input?: TypebotInput;
}

export class TypebotApiError extends Error {
  constructor(
    message: string,
    /** 0 = sem resposta (timeout/rede): o Typebot pode ter processado a chamada. */
    readonly status: number,
  ) {
    super(message);
  }
}

@Injectable()
export class TypebotClient {
  private readonly timeoutMs = Number(process.env.TYPEBOT_TIMEOUT_MS ?? 20_000);

  startChat(
    endpoint: string,
    token: string | undefined,
    publicId: string,
    prefilledVariables: Record<string, string>,
  ) {
    return this.post(
      `${endpoint}/v1/typebots/${encodeURIComponent(publicId)}/startChat`,
      token,
      { prefilledVariables },
    );
  }

  continueChat(
    endpoint: string,
    token: string | undefined,
    sessionId: string,
    text: string,
  ) {
    return this.post(
      `${endpoint}/v1/sessions/${encodeURIComponent(sessionId)}/continueChat`,
      token,
      { message: { type: 'text', text } },
    );
  }

  private async post(
    url: string,
    token: string | undefined,
    body: unknown,
  ): Promise<TypebotTurnResult> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new TypebotApiError(
        `Typebot sem resposta: ${(error as Error).message}`,
        0,
      );
    }
    const text = await response.text();
    if (!response.ok)
      throw new TypebotApiError(
        `Typebot API ${response.status}: ${text.slice(0, 300)}`,
        response.status,
      );
    return JSON.parse(text) as TypebotTurnResult;
  }
}
