import { BotOperationsPocService } from './bot-operations-poc.service';
import { TypebotPocStore } from '../bot/infrastructure/typebot/typebot-poc.store';

function setup(mode = 'direct') {
  process.env.ASYNC_RESUME_MODE = mode;
  process.env.OP_SIMULATED_MS = '0';
  const store = new TypebotPocStore();
  const client = { continueChat: jest.fn().mockResolvedValue({ messages: [], input: undefined }) };
  const realtime = { publish: jest.fn().mockResolvedValue(undefined) };
  const service = new BotOperationsPocService(store, client as any, realtime as any);
  const chat = store.create('sess');
  chat.input = { id: 'i', type: 'text input' };
  return { store, client, realtime, service, chat };
}

describe('BotOperationsPocService', () => {
  it('é idempotente: mesma chave não duplica operação nem resposta', async () => {
    const { service, chat } = setup();
    const a = await service.enqueue(chat.id, 'customer.requests.list', 'k1');
    const b = await service.enqueue(chat.id, 'customer.requests.list', 'k1');
    expect(b.id).toBe(a.id);
    await service.tick();
    await service.complete(a, { text: 'de novo' }); // evento repetido
    expect(chat.messages.filter((m) => m.from === 'bot')).toHaveLength(1);
  });

  it('só uma operação bloqueante por chat', async () => {
    const { service, chat } = setup();
    const a = await service.enqueue(chat.id, 'x', 'k1');
    const b = await service.enqueue(chat.id, 'x', 'k2');
    expect(b.id).toBe(a.id);
  });

  it('não publica resultado de atendimento encerrado', async () => {
    const { service, chat, realtime } = setup();
    const op = await service.enqueue(chat.id, 'x', 'k1');
    realtime.publish.mockClear();
    chat.isFinished = true;
    await service.tick();
    expect(op.status).toBe('cancelled');
    expect(chat.messages).toHaveLength(0);
    expect(realtime.publish).not.toHaveBeenCalled();
  });

  it('modo continue avança o Typebot com o resultado, sem nova mensagem do consumidor', async () => {
    const { service, chat, client } = setup('continue');
    await service.enqueue(chat.id, 'x', 'k1');
    await service.tick();
    expect(client.continueChat).toHaveBeenCalledWith('sess', expect.stringContaining('solicitações'));
    expect(chat.pendingOperationId).toBeNull();
  });
});
