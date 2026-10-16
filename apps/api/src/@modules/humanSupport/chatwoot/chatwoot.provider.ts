import type {
  HumanConversation,
  HumanSupportProvider,
} from '@modules/humanSupport/humanSupportProvider.interface';
import { ChatwootClient } from '@modules/humanSupport/chatwoot/chatwoot.client';

export class ChatwootProvider implements HumanSupportProvider {
  constructor(private readonly client: ChatwootClient) {}

  async createOrGetConversation(input: {
    attendanceId: string;
    displayName: string;
    existingContact?: { externalContactId: string; externalSourceId: string };
  }): Promise<HumanConversation> {
    const contact = input.existingContact
      ? {
          contactId: input.existingContact.externalContactId,
          sourceId: input.existingContact.externalSourceId,
        }
      : await this.client.createContact(input.attendanceId, input.displayName);
    const conversationId = await this.client.createConversation(
      contact.sourceId,
      contact.contactId,
      input.attendanceId,
    );
    return {
      externalConversationId: conversationId,
      externalContactId: contact.contactId,
      externalSourceId: contact.sourceId,
      externalAccountId: this.client.accountId,
      externalInboxId: this.client.inboxId,
    };
  }

  async sendMessage(input: {
    externalConversationId: string;
    content: string;
    private?: boolean;
  }) {
    const externalMessageId = await this.client.sendMessage(
      input.externalConversationId,
      input.content,
      {
        private: input.private,
      },
    );
    return { externalMessageId };
  }
}
