import { TypebotMessageMapper } from './typebot-message.mapper';

describe('TypebotMessageMapper', () => {
  const mapper = new TypebotMessageMapper();

  // Resposta real do startChat do Typebot 3.19.0 (fluxo poc-handoff), encurtada.
  const real = {
    sessionId: 'sess-1',
    messages: [
      {
        id: 'm1',
        type: 'text',
        content: {
          type: 'richText',
          richText: [
            { type: 'p', children: [{ text: 'Olá! Como posso ajudar?' }] },
          ],
        },
      },
    ],
    input: {
      id: 'c1',
      type: 'choice input',
      items: [
        { id: 'c10', outgoingEdgeId: 'e1', content: 'Falar com atendente' },
        { id: 'c11', outgoingEdgeId: 'e2', content: 'Encerrar' },
      ],
    },
  };

  it('converte texto rico e `choice input` (itens em input.items) para o contrato do chat', () => {
    expect(mapper.toTurn(real)).toEqual({
      messages: [{ type: 'text', text: 'Olá! Como posso ajudar?' }],
      input: {
        type: 'options',
        options: [
          { id: 'c10', label: 'Falar com atendente' },
          { id: 'c11', label: 'Encerrar' },
        ],
      },
      providerSessionId: 'sess-1',
    });
  });

  it('input de texto vira etapa `input`; fim de fluxo não tem etapa', () => {
    expect(
      mapper.toTurn({ messages: [], input: { id: 'i', type: 'text input' } })
        .input,
    ).toEqual({
      type: 'input',
      inputType: 'text input',
    });
    expect(mapper.toTurn({ messages: [] }).input).toBeNull();
  });

  it('markdown é aceito; tipos não suportados (imagem) são ignorados', () => {
    const turn = mapper.toTurn({
      messages: [
        {
          id: 'a',
          type: 'text',
          content: { type: 'markdown', markdown: '**oi**' },
        },
        { id: 'b', type: 'image', content: { url: 'x' } },
      ],
    });
    expect(turn.messages).toEqual([{ type: 'text', text: '**oi**' }]);
  });
});
