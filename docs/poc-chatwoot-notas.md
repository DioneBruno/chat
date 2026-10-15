# POC #3 — Handoff Typebot → Chatwoot → Typebot (pós-atendimento)

> **Histórico:** o estado em memória do handoff foi substituído na etapa 5 ([etapa5-confiabilidade-notas.md](etapa5-confiabilidade-notas.md)): `human_sessions`, `integration_inbox`, outbox e recuperação de `handoff_pending`. `POST_SERVICE_INACTIVITY_MS` não existe mais (o prazo é `tenant_settings.post_service_inactivity_minutes`).

> **Estado: fluxo completo VALIDADO** com Typebot 3.19.0 + Chatwoot **4.18.0**
> (fixada) + Centrifugo 6.9.7, via `e2e` com atendente simulado pela API do
> Chatwoot (12 checks) e 5 testes unitários. **Não validado:** uso real da UI do
> Chatwoot pelo atendente, anexos, múltiplos agentes/filas, falhas do Chatwoot
> durante o handoff (só o ramo `handoff_pending` está escrito).

## Fluxo implementado

1. Fluxo `initial` (Typebot `poc-handoff`): escolha "Falar com atendente" → bloco
   HTTP `POST /internal/bot/handoff`.
2. Nest: fase `handoff_pending` → cria contato (`identifier` = id do atendimento)
   e conversa no inbox API do Chatwoot, envia o histórico como **nota privada** e
   encaminha mensagens enfileiradas → fase `human`.
3. Consumidor ↔ atendente: mensagens do consumidor vão ao Chatwoot como
   `incoming`; respostas do atendente chegam por webhook `message_created`
   (`outgoing`, não privada) e viram `from: 'agent'`.
4. Atendente resolve → webhook `conversation_status_changed` (`resolved`) →
   `returning_to_bot` → **nova sessão** do fluxo `post_service`
   (`poc-post-service`) → fase `post_service`, prazo de inatividade iniciado.
   O protocolo **não** é fechado pelo Chatwoot.
5. Pós-atendimento: "Não" → bot chama `/internal/bot/close`
   (`consumer_declined_more_help`); "Sim" → novo handoff, **mesmo protocolo**,
   **nova conversa** Chatwoot (id novo); silêncio → worker fecha com
   `post_service_inactivity` (autor `system`). Protocolo fechado devolve 409.

## Achados sobre os contratos reais (Chatwoot 4.18.0)

- **Webhook assinado**: o inbox API envia `X-Chatwoot-Signature: sha256=<hex>` +
  `X-Chatwoot-Timestamp`; HMAC-SHA256 de `"<timestamp>.<corpo bruto>"` com o
  campo `secret` do inbox (não confundir com `hmac_token`, que é da identidade
  do contato). Validado no Nest (precisa de `rawBody: true`) com janela de 5 min.
- **SSRF do Chatwoot**: o Sidekiq recusa webhook para `api` ("Hostname has no
  public ip addresses"). Único controle é global:
  `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true` (sem allowlist por host). Aceitável na
  POC porque só admins internos configuram webhooks; **registrar como risco**.
- Webhook de status: `conversation_status_changed` traz `status` e o id da
  conversa em `id`. Mensagens enviadas por nós voltam em `message_created`
  (`incoming` ou notas `private`) → ignorar evita loop.
- Criar contato: `POST /contacts` devolve `payload.contact.id` e
  `payload.contact_inbox.source_id`; conversa: `POST /conversations` com
  `source_id`, `inbox_id`, `contact_id`, `custom_attributes`.
- Seed sem UI: `rails runner` cria conta/usuário/token; imagem pesa ~2,7 GB.
  `db:chatwoot_prepare` imprime erro de "AI Agents SDK" antes de as tabelas
  existirem — inofensivo.

## Achados sobre o Typebot (valem também para a POC #2)

- **O bloco HTTP só usa o corpo configurado se `options.isCustomBody: true`.**
  Sem isso envia o corpo padrão (`submittedAt`, respostas do fluxo) + variáveis
  — por isso `reason`/`action` nunca chegavam ao Nest. Na POC #2 passou
  despercebido porque o serviço só usava `chatId`.
- Importar/publicar fluxo por API funciona (`POST /api/v1/typebots/import`,
  `PATCH` com `publicId`, `POST .../publish`); útil para versionar fluxos.

## Rodar

```bash
docker compose up -d                       # inclui Chatwoot em http://localhost:3000
# login: atendente@poc.local / Poc@12345678 (criado pelo seed; só POC)
TYPEBOT_ID=poc-handoff POST_SERVICE_INACTIVITY_MS=15000 docker compose up -d api
node <scratchpad>/e2e3.mjs                 # roteiro automatizado (não versionado)
```

## Limitações da POC

- Estado, dedupe de webhooks e fila em memória (sem `integration_inbox`,
  `human_sessions`, outbox); reinício do Nest perde tudo.
- `handoff_pending` não tem reprocessamento automático (a versão real usa outbox).
- Prazo de 60 min é o padrão; por tenant fica para a fundação persistente.
- Fluxos Typebot só existem no banco do Typebot (não versionados no repo).
