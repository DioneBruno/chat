# POC #2 — Consulta assíncrona (Typebot → Nest → Centrifugo)

> **Estado: caminho feliz VALIDADO contra Typebot 3.19.0 + Centrifugo 6.9.7 reais
> (modo `continue`).** Pendentes: falha da operação, reload no meio da espera e
> modo `direct` (ver checklist).

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

## Resultado da validação (2026-10-14)

Fluxo criado/publicado via API do builder (`POST /api/v1/typebots/import`,
public ID `poc-async`, `TYPEBOT_ID=poc-async`). Medido: operação `pending`
em ~0,2 s; `bot.operation.completed` + `message.created` no Centrifugo em
~5,2 s; mensagem com o resultado no histórico sem nova entrada do consumidor.

Achados que viraram correção:
- **SSRF do Typebot**: o bloco HTTP recusa redes privadas (inclui o IP do
  container `api`). Solução: `SSRF_ALLOWED_HOSTS=api` no viewer (lista de
  hostnames). Em produção manter a lista mínima.
- **Centrifugo v6** devolvia `unknown channel`: canal `attendance:<id>` exige
  o namespace declarado (`CENTRIFUGO_CHANNEL_NAMESPACES='[{"name":"attendance"}]'`;
  `CENTRIFUGO_NAMESPACES` não existe na v6).
- **Corrida no startChat**: o bloco HTTP roda *dentro* do `startChat`, antes de
  o Nest saber o `sessionId`. O chat agora é registrado antes e o `sessionId`
  preenchido depois. No desenho real, criar `bot_sessions` antes de iniciar.
- Chat inexistente/encerrado no endpoint interno agora é 409 (era 500).

> **Atenção (descoberto na POC #3):** o bloco HTTP do Typebot só envia o corpo
> configurado com `options.isCustomBody: true`; sem isso `action` não chega ao
> Nest. O caminho de falha (`fail()` avançando o fluxo + variável `acao`) está
> escrito mas **não foi testado**.

## Fluxo a montar no builder (publicar e usar o public ID em `TYPEBOT_ID`)

1. Variáveis: `chatId` (preenchida via `prefilledVariables` no startChat),
   `resultado`.
2. Texto: "Vou consultar suas solicitações."
3. **HTTP request** `POST http://api:3001/internal/bot/operations`,
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

- [x] O Typebot v3.19.0 alcança o Nest pelo bloco HTTP? **Só com
      `SSRF_ALLOWED_HOSTS=api`**; sem isso bloqueia (erro só aparece em `logs` do startChat).
- [x] O bloco HTTP respeita resposta rápida e o fluxo realmente para no input?
- [x] `continueChat` com texto avança o input parado e preenche `resultado`?
- [x] `prefilledVariables` no startChat chega ao fluxo?
- [x] Config do Centrifugo v6 (env vars de HMAC/API key/origens) está correta?
      Não validei os nomes das variáveis contra a imagem.
- [ ] Reload no meio da espera mantém o indicador (via `pendingOperationId`)?

## Limitações conhecidas (POC)

- Fila e estado em memória; sem lease/`SKIP LOCKED`, sem outbox (publica
  direto após alterar o store).
- Endpoint interno sem credencial de curta duração, só segredo estático.
- Falha da operação deixa o fluxo parado no input de retomada.
- Sem teste automatizado de Centrifugo/Typebot reais.
