# POC #2 — Consulta assíncrona (Typebot → Nest → Centrifugo)

> **Estado: código implementado, validação contra o Typebot real PENDENTE.**
> Testes unitários do Nest passam (idempotência, 1 operação por chat,
> descarte de resultado tardio, modo `continue`), mas o fluxo no builder, o
> bloco HTTP chamando o Nest e o Centrifugo ainda não foram executados.

## O que a POC testa

1. Bloco HTTP do Typebot chama `POST /internal/bot/operations` e recebe
   `{operationId, status:'pending'}` na hora.
2. Worker (em memória, 5 s simulados — `OP_SIMULATED_MS`) conclui a operação.
3. **Retomada** (`ASYNC_RESUME_MODE=continue`, padrão): o fluxo fica parado em
   um bloco de input; o Nest chama `continueChat` com o resultado, sem o
   consumidor digitar nada.
4. **Fallback** (`ASYNC_RESUME_MODE=direct`): Nest só publica o resultado como
   mensagem do bot (o fluxo seguinte seria um fluxo de continuação).
5. Vue recebe sinais pelo Centrifugo (`bot.operation.*`, `message.created`),
   remove o indicador e re-busca o estado na API (banco = verdade).

## Fluxo a montar no builder (publicar e usar o public ID em `TYPEBOT_ID`)

1. Variáveis: `chatId` (preenchida via `prefilledVariables` no startChat),
   `resultado`.
2. Texto: "Vou consultar suas solicitações."
3. **HTTP request** `POST http://host.docker.internal:3001/internal/bot/operations`,
   body JSON `{"chatId":"{{chatId}}","action":"customer.requests.list"}`
   (header `x-bot-secret` se `BOT_INTERNAL_SECRET` estiver definido).
4. **Input de texto** salvando em `resultado` (é a "pausa" — o Vue esconde
   esse input enquanto há operação pendente).
5. Texto: "{{resultado}}" e depois menu/fim.

## Subir

```bash
docker compose up -d   # inclui centrifugo (8000)
# apps/api/.env: PORT=3001 + TYPEBOT_* (ver README)
cd apps/api && npm run start:dev
cd apps/web-poc && npm run dev
```

Segredos do Centrifugo/Nest usam defaults da POC (`poc-hmac-secret`,
`poc-api-key`); sobrescreva com `CENTRIFUGO_HMAC_SECRET`,
`CENTRIFUGO_API_KEY`, `CENTRIFUGO_API_URL`.

## Perguntas que a execução precisa responder (seção 14 do CLAUDE.md)

- [ ] O Typebot v3.19.0 alcança `host.docker.internal` pelo bloco HTTP (ou
      bloqueia hosts privados/SSRF)?
- [ ] O bloco HTTP respeita resposta rápida e o fluxo realmente para no input?
- [ ] `continueChat` com texto avança o input parado e preenche `resultado`?
- [ ] `prefilledVariables` no startChat chega ao fluxo?
- [ ] Config do Centrifugo v6 (env vars de HMAC/API key/origens) está correta?
      Não validei os nomes das variáveis contra a imagem.
- [ ] Reload no meio da espera mantém o indicador (via `pendingOperationId`)?

## Limitações conhecidas (POC)

- Fila e estado em memória; sem lease/`SKIP LOCKED`, sem outbox (publica
  direto após alterar o store).
- Endpoint interno sem credencial de curta duração, só segredo estático.
- Falha da operação deixa o fluxo parado no input de retomada.
- Sem teste automatizado de Centrifugo/Typebot reais.
