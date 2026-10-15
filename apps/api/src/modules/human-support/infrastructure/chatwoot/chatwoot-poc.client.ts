/**
 * POC #3 — cliente mínimo da API do Chatwoot v4.18.0 (Application API,
 * autenticada por `api_access_token` de usuário). Contratos confirmados na
 * execução real; ver docs/poc-chatwoot-notas.md.
 */
import { Injectable } from '@nestjs/common';

@Injectable()
export class ChatwootPocClient {
  private readonly baseUrl = process.env.CHATWOOT_API_URL ?? 'http://localhost:3000';
  private readonly accountId = process.env.CHATWOOT_ACCOUNT_ID ?? '1';
  private readonly inboxId = Number(process.env.CHATWOOT_INBOX_ID ?? 1);
  private readonly token = process.env.CHATWOOT_API_TOKEN ?? '';

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/v1/accounts/${this.accountId}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', api_access_token: this.token },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Chatwoot ${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** `identifier` = id interno do atendimento: reaproveita o mesmo contato em novos ciclos. */
  async createContact(identifier: string, name: string) {
    const res = await this.call<{ payload: { contact: { id: number }; contact_inbox: { source_id: string } } }>(
      'POST',
      '/contacts',
      { inbox_id: this.inboxId, name, identifier },
    );
    return { contactId: res.payload.contact.id, sourceId: res.payload.contact_inbox.source_id };
  }

  async createConversation(sourceId: string, contactId: number, attendanceId: string) {
    const res = await this.call<{ id: number }>('POST', '/conversations', {
      source_id: sourceId,
      inbox_id: this.inboxId,
      contact_id: contactId,
      custom_attributes: { attendance_id: attendanceId },
    });
    return res.id;
  }

  /** Mensagem do consumidor (incoming) ou nota interna com contexto (private). */
  async sendMessage(conversationId: number, content: string, opts: { private?: boolean } = {}) {
    return this.call<{ id: number }>('POST', `/conversations/${conversationId}/messages`, {
      content,
      message_type: opts.private ? 'outgoing' : 'incoming',
      private: opts.private ?? false,
    });
  }

  /** Usado só pelo teste automatizado para simular o atendente. */
  async setStatus(conversationId: number, status: 'open' | 'resolved') {
    return this.call('POST', `/conversations/${conversationId}/toggle_status`, { status });
  }

  async agentReply(conversationId: number, content: string) {
    return this.call('POST', `/conversations/${conversationId}/messages`, { content, message_type: 'outgoing' });
  }
}
