import { TypebotPocClient } from '../../../bot/infrastructure/typebot/typebot-poc.client';
import { TypebotPocStore } from '../../../bot/infrastructure/typebot/typebot-poc.store';
import { CentrifugoService } from '../../../realtime/centrifugo.service';
import { ChatwootPocClient } from './chatwoot-poc.client';
import { ChatwootPocService } from './chatwoot-poc.service';

function setup() {
  const store = new TypebotPocStore();
  const typebot = {
    startChat: jest.fn().mockResolvedValue({
      sessionId: 'sess-2',
      messages: [{ id: 'm', type: 'text', content: { type: 'richText', richText: [{ type: 'p', children: [{ text: 'Posso ajudar?' }] }] } }],
      input: { id: 'i', type: 'choice input' },
    }),
  } as unknown as jest.Mocked<TypebotPocClient>;
  const chatwoot = {
    createContact: jest.fn().mockResolvedValue({ contactId: 5, sourceId: 'src' }),
    createConversation: jest.fn().mockResolvedValue(77),
    sendMessage: jest.fn().mockResolvedValue({ id: 1 }),
  } as unknown as jest.Mocked<ChatwootPocClient>;
  const realtime = { publish: jest.fn() } as unknown as CentrifugoService;
  const service = new ChatwootPocService(store, typebot, chatwoot, realtime);
  const chat = store.create('sess-1', 'chat-1');
  return { store, typebot, chatwoot, service, chat };
}

describe('ChatwootPocService', () => {
  it('handoff é idempotente e leva as mensagens enfileiradas ao humano', async () => {
    const { service, chatwoot, chat } = setup();
    chat.queuedForHuman.push('oi, ainda aí?');
    await service.handoff('chat-1');
    await service.handoff('chat-1');
    expect(chat.phase).toBe('human');
    expect(chatwoot.createConversation).toHaveBeenCalledTimes(1);
    expect(chatwoot.sendMessage).toHaveBeenCalledWith(77, 'oi, ainda aí?');
  });

  it('ignora eco das próprias mensagens (incoming/privadas) e duplicatas', async () => {
    const { service, chat } = setup();
    await service.handoff('chat-1');
    const echo = { event: 'message_created', id: 1, message_type: 'incoming', conversation: { id: 77 } };
    expect(await service.handleWebhook(echo)).toEqual({ ignored: 'not_agent_message' });
    const note = { event: 'message_created', id: 2, message_type: 'outgoing', private: true, conversation: { id: 77 } };
    expect(await service.handleWebhook(note)).toEqual({ ignored: 'not_agent_message' });
    const reply = { event: 'message_created', id: 3, message_type: 'outgoing', content: 'olá', conversation: { id: 77 } };
    await service.handleWebhook(reply);
    expect(await service.handleWebhook(reply)).toEqual({ ignored: 'duplicate' });
    expect(chat.messages.filter((m) => m.from === 'agent')).toHaveLength(1);
  });

  it('resolved abre NOVA sessão do bot, mantém o protocolo aberto e define prazo', async () => {
    const { service, typebot, chat } = setup();
    await service.handoff('chat-1');
    await service.handleWebhook({ event: 'conversation_status_changed', status: 'resolved', id: 77 } as never);
    expect(typebot.startChat).toHaveBeenCalledTimes(1);
    expect(chat.typebotSessionId).toBe('sess-2');
    expect(chat.phase).toBe('post_service');
    expect(chat.isFinished).toBe(false);
    expect(chat.inactivityDeadlineAt).not.toBeNull();
  });

  it('resolved repetido (outro dedupe key) não reinicia o bot fora da fase human', async () => {
    const { service, typebot, chat } = setup();
    await service.handoff('chat-1');
    await service.handleWebhook({ event: 'conversation_status_changed', status: 'resolved', id: 77 } as never);
    await service.handleWebhook({ event: 'conversation_updated', status: 'resolved', id: 77 } as never);
    chat.phase = 'post_service';
    expect(typebot.startChat).toHaveBeenCalledTimes(1);
  });

  it('webhook de atendimento encerrado não muda nada', async () => {
    const { service, typebot, chat } = setup();
    await service.handoff('chat-1');
    await service.close('chat-1', 'x');
    await service.handleWebhook({ event: 'conversation_status_changed', status: 'resolved', id: 77 } as never);
    expect(typebot.startChat).not.toHaveBeenCalled();
    expect(chat.closedReason).toBe('x');
  });
});
