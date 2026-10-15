/**
 * Cliente da Application API do Chatwoot v4.18.0 (autenticada por `api_access_token`).
 * Contratos confirmados nas POCs (docs/poc-chatwoot-notas.md).
 */
import { Injectable } from '@nestjs/common';

interface ContactPayload {
  contact: { id: number };
  contact_inbox?: { source_id: string };
}

@Injectable()
export class ChatwootClient {
  readonly accountId = process.env.CHATWOOT_ACCOUNT_ID ?? '1';
  readonly inboxId = process.env.CHATWOOT_INBOX_ID ?? '1';
  private readonly baseUrl =
    process.env.CHATWOOT_API_URL ?? 'http://localhost:3000';
  private readonly token = process.env.CHATWOOT_API_TOKEN ?? '';

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/accounts/${this.accountId}${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          api_access_token: this.token,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `Chatwoot ${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`,
      );
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** `identifier` = id do atendimento: um contato por protocolo, reaproveitado entre ciclos. */
  async createContact(identifier: string, name: string) {
    try {
      const res = await this.call<{ payload: ContactPayload }>(
        'POST',
        '/contacts',
        {
          inbox_id: Number(this.inboxId),
          name,
          identifier,
        },
      );
      return {
        contactId: String(res.payload.contact.id),
        sourceId: res.payload.contact_inbox?.source_id ?? '',
      };
    } catch (error) {
      // Retentativa após queda entre criar o contato e gravar os ids: procura o existente.
      const found = await this.findContact(identifier);
      if (found) return found;
      throw error;
    }
  }

  private async findContact(identifier: string) {
    const res = await this.call<{
      payload: {
        id: number;
        identifier?: string;
        contact_inboxes?: { source_id: string; inbox: { id: number } }[];
      }[];
    }>('GET', `/contacts/search?q=${encodeURIComponent(identifier)}`);
    const contact = res.payload.find((c) => c.identifier === identifier);
    const inbox = contact?.contact_inboxes?.find(
      (i) => String(i.inbox.id) === this.inboxId,
    );
    return contact && inbox
      ? { contactId: String(contact.id), sourceId: inbox.source_id }
      : null;
  }

  async createConversation(
    sourceId: string,
    contactId: string,
    attendanceId: string,
  ) {
    const res = await this.call<{ id: number }>('POST', '/conversations', {
      source_id: sourceId,
      inbox_id: Number(this.inboxId),
      contact_id: Number(contactId),
      custom_attributes: { attendance_id: attendanceId },
    });
    return String(res.id);
  }

  /** Mensagem do consumidor (`incoming`) ou nota interna (`private`). */
  async sendMessage(
    conversationId: string,
    content: string,
    opts: { private?: boolean } = {},
  ) {
    const res = await this.call<{ id: number }>(
      'POST',
      `/conversations/${conversationId}/messages`,
      {
        content,
        message_type: opts.private ? 'outgoing' : 'incoming',
        private: opts.private ?? false,
      },
    );
    return String(res.id);
  }
}
