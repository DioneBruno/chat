# Etapa 5 — Confiabilidade (outbox, inbox, sessões, operações, realtime)

> **Estado:** implementada e validada. **90 testes de integração** contra PostgreSQL 16 real
> (`npm run test:int`, estáveis em execuções repetidas) + 4 unitários, e **roteiros ao vivo**
> contra Typebot 3.19.0, Chatwoot 4.18.0 e Centrifugo 6 reais (`apps/api/test/live/`):
> async, falha, reinício da API no meio da consulta e handoff completo
> (bot → humano → pós-atendimento → encerramento), 10/10 verificações.
> **Não validado:** o front Vue em navegador (compila e é servido, mas não foi exercitado
> manualmente), carga/volume, e o provedor WhatsApp (etapa 6 em diante).

As POCs #1–#3 em memória (`/poc/*`, `TypebotPocStore`, etc.) foram **removidas**: o chat agora
roda 100% sobre o banco `platform`. A lógica delas está no histórico do git e nas notas antigas.

## O que existe

Migrations `002_reliability.sql` e `003_flow_variables.sql`:

| Tabela | Papel |
|---|---|
| `outbox_events` | eventos gravados na **mesma transação** da mudança de estado; lease, backoff, `dead` |
| `integration_inbox` | webhooks recebidos, único por `(provider, chave)` |
| `bot_providers`, `tenant_bot_workspaces`, `bot_flows` | `tenant → workspace → fluxos publicados`; um fluxo padrão ativo por tipo e um por aplicação/tipo; `prefilled_variables` |
| `bot_sessions` | uma sessão **viva** por atendimento (índice único parcial); várias ao longo do tempo |
| `bot_operations` | uma operação **bloqueante** por sessão; idempotente por chave; lease; `resume_status` |
| `human_sessions` | um ciclo humano vivo por vez, vários por protocolo |
| `human_message_deliveries` | cada mensagem do consumidor é entregue ao Chatwoot no máximo uma vez |

Módulos (conforme a seção 17): `outbox`, `integration-inbox`, `bot` (orquestrador, resolvedor de
fluxo, token de execução, `TypebotProvider/Client/MessageMapper`), `bot-operations`
(serviço, worker, executores, endpoints internos), `human-support` (serviço, `ChatwootProvider`,
webhook), `realtime` (Centrifugo + handler do outbox).

## Como os eventos fluem

```
POST /public/attendances      -> attendance.created   -> startSession(initial)  [Typebot]
POST /public/attendance/messages -> message.received  -> bot.continueSession | human.relay_message
bloco HTTP do Typebot         -> bot_operations(pending) -> worker -> completed
                                 -> bot.operation.resume -> continueSession(resultado)
bloco HTTP "handoff"          -> handoff_pending + human_sessions -> human.conversation_requested
                                 -> Chatwoot (contato, conversa, nota de contexto) -> fase human
webhook Chatwoot              -> integration_inbox -> integration.chatwoot_webhook
                                 -> mensagem `agent` | resolved -> returning_to_bot
                                 -> bot.start_post_service -> NOVA sessão Typebot -> post_service (prazo)
toda mudança de estado        -> realtime.publish     -> Centrifugo (sinal; o banco é a verdade)
```

## Garantias (cada uma tem teste)

- **Publicação só depois da persistência**: o sinal realtime é um evento do outbox gravado junto da
  mensagem; Centrifugo fora do ar não perde o sinal (retry com backoff). Rollback não deixa evento órfão.
- **Um evento por atendimento por vez, em ordem** (`claim` com `SKIP LOCKED`, advisory lock por
  atendimento e recheck com snapshot novo). Achado durante a implementação: sem o recheck, uma réplica
  com snapshot antigo pulava o evento mais antigo e processava o seguinte do mesmo atendimento.
  Teste de concorrência (6 réplicas × 5 rodadas) estável.
- **Lease vencido = worker caiu**: evento/operação é retomado; contagem de tentativa; `dead` ao esgotar.
- **Idempotência**: mensagens (chave), operações (chave + 1 bloqueante/sessão), webhooks (inbox), eventos
  (`dedupe_key`), entrega ao humano (`human_message_deliveries`), pós-atendimento (uma sessão por resolução).
- **Não repetir às cegas**: falha/timeout no `continueChat` não reenvia; avisa o consumidor e aceita nova
  tentativa. Retomada pós-operação que falha entrega o resultado direto (`resume_status='fallback'`).
  Operação que muda estado externo (`mutating`) nunca é repetida. Reivindicação repetida de operação
  mutável (worker caiu) falha em vez de reexecutar.
- **Resultado tardio é descartado**: protocolo encerrado, handoff ou sessão trocada cancelam a operação.
- **Encerramento** (bot, expiração ou qualquer `close`): cancela operações, interrompe sessões
  bot/humano e sinaliza o realtime, na mesma transação.
- **Escolha de opção valida a etapa ativa**: o texto enviado ao bot vem do servidor, não do navegador.
- **Handoff recuperável**: `handoff_pending` repete pelo outbox (Chatwoot fora do ar, falha na nota de
  contexto); mensagens enviadas durante a espera são encaminhadas uma vez, em ordem, ao confirmar o humano.
- **Pós-atendimento**: resolver no Chatwoot **não fecha**; cria nova sessão, e o prazo (60 min padrão por
  tenant) começa quando a pergunta é persistida; resposta cancela; silêncio expira com `post_service_inactivity`.
- **Isolamento**: credencial do bot amarrada a tenant/protocolo/sessão/escopo e morre com a sessão;
  claims forjadas entre tenants falham; FKs compostas impedem sessão com fluxo de outro tenant.

## Achados da validação ao vivo (corrigidos)

1. **Typebot 3.19.0 devolve os itens do `choice input` em `input.items`**, não em `input.options.items`
   (a POC #1 assumia o segundo). Sem a correção, o menu nunca aparecia. Há teste do mapper com o payload real.
2. O fluxo `poc-async` envia `{{acao}}` no bloco HTTP. A ação passou a vir de
   `bot_flows.prefilled_variables` (configurada pela equipe interna), nunca do navegador.
3. A API só repassa ao compose variáveis listadas em `environment` (`POC_BOT_ACTION` precisou entrar).
4. O Centrifugo não guarda histórico: um sinal emitido antes da assinatura se perde. Por isso o front
   relê a API ao assinar/reconectar (já era o desenho; agora é exercitado).
5. Chatwoot: `identifier` duplicado é recusado ("Identifier has already been taken"); a busca
   `GET /contacts/search?q=` devolve `contact_inboxes[].source_id` (usada na recuperação após queda).

## Decisões minhas (não vieram do CLAUDE.md — revisar)

- **Credencial do bot**: HMAC com `exp` de 24 h (`BOT_TOKEN_TTL_MINUTES`) **mais** conferência de que a
  sessão está viva a cada chamada. A seção 13 pede "curta duração", mas o Typebot guarda o token como
  variável e o consumidor pode clicar horas depois; sem renovação possível no `continueChat`, uma
  validade curta quebraria o fluxo. O token vai na variável `chatId` (nome usado pelos fluxos das POCs)
  e em `botToken`; `Authorization: Bearer` também é aceito.
- Pedir humano com consulta em andamento **cancela a consulta** (pendência 19.9 — provisório).
- Mensagens do consumidor durante `returning_to_bot` ficam só no histórico (não viram resposta à pergunta
  do pós-atendimento); durante operação pendente também só no histórico (o input fica oculto).
- Fluxo que termina sem fechar o protocolo **não** fecha: só `/internal/bot/close` (ou prazo) encerra
  (critério exato é a pendência 19.8).
- Contexto enviado ao atendente: só o texto das mensagens, como nota privada, com protocolo no nome do contato.
- Retenção: outbox concluído 7 dias (`OUTBOX_RETENTION_DAYS`), inbox processado 30 dias
  (`INBOX_RETENTION_DAYS`); `dead` não é removido.
- `bot_sessions.last_processed_seq` (além do `last_processed_message_id` da seção 10) ordena o roteamento.
- Webhook do Chatwoot sem `CHATWOOT_WEBHOOK_SECRET` só é aceito fora de produção.

## Janelas conhecidas (at-least-once, resultado desconhecido)

- Queda **entre** `continueChat` bem-sucedido e o commit do turno: a mensagem já está marcada como
  processada e o Typebot avançou, mas a resposta do bot não foi persistida (o consumidor reenvia).
- Queda entre criar a conversa no Chatwoot e gravar os ids: pode sobrar uma conversa órfã (o contato é
  recuperado pela busca). Queda entre enviar ao Chatwoot e marcar entregue: reenvio possível após o lease
  (o Chatwoot não tem idempotência de mensagem).
- Sessão `starting` cujo evento esgotou as tentativas (`dead`) deixa o atendimento sem bot; hoje só há o
  registro. Falta um monitor/reprocessamento manual para `dead` e sessões presas.
- Sessão perdida no Typebot (404/410) marca a sessão `failed` e avisa o consumidor, sem recuperação automática.

## Pendências / não feito

- Executores reais das APIs das empresas (allowlist, SSRF, credenciais segregadas, timeouts por ação);
  hoje só os simulados da POC #2. Autorização por ação/tenant.
- `awaiting_business_hours`, horário comercial e avisos (etapa 6). Mensagens nessa fase só ficam no histórico.
- `audit_events` (transições e ações sensíveis) — não implementado.
- Endpoints `/internal/bot/*` e `/webhooks/chatwoot` estão na mesma porta da API pública (protegidos por
  credencial/assinatura): em produção expor só pela rede interna / roteamento do proxy.
- Rate limit HTTP por IP nas rotas públicas; testes de carga; métricas e logs com correlation id.
- Front: abrir em navegador e testar reload no meio de operação/handoff; "Ver atendimentos anteriores" é só um chip.

## Rodar e validar

```bash
docker compose up -d                                  # infra completa
cd apps/api && npm run test:int                       # 90 testes (schema descartável por suíte)
TYPEBOT_ID=poc-async  docker compose up -d --build api && node apps/api/test/live/etapa5-e2e.mjs async
TYPEBOT_ID=poc-handoff docker compose up -d api       && node apps/api/test/live/etapa5-e2e.mjs handoff
POC_BOT_ACTION=customer.requests.fail OP_SIMULATED_MS=1500 docker compose up -d api
node apps/api/test/live/etapa5-falha-reinicio.mjs fail
```

Variáveis novas: `BOT_EXECUTION_SECRET`, `BOT_TOKEN_TTL_MINUTES`, `ASYNC_RESUME_MODE` (`continue`|`direct`),
`OUTBOX_WORKER`/`OPERATIONS_WORKER` (`false` desliga o worker na réplica), `OUTBOX_BATCH_SIZE`,
`OUTBOX_LEASE_MS`, `OUTBOX_RETENTION_DAYS`, `INBOX_RETENTION_DAYS`, `TYPEBOT_TIMEOUT_MS`, `POC_BOT_ACTION`.
