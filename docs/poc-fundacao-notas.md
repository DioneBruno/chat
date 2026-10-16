# POC #4 — Fundação persistente (PostgreSQL da plataforma)

> **Atualização:** a integração com as POCs (etapa 5) foi feita; ver [etapa5-confiabilidade-notas.md](etapa5-confiabilidade-notas.md).

> **Estado:** núcleo persistente implementado e validado por 34 testes de
> integração contra PostgreSQL 16 real (`npm run test:int`) + smoke HTTP no
> Docker. **Ainda não integrado** às POCs #1–#3: o chat do Typebot/Chatwoot
> continua em memória (isso é a etapa 5 — `bot_sessions`, `human_sessions`,
> `bot_operations`, outbox, inbox).

## O que existe

- Banco `platform` (serviço `platform-db`, usuário/credenciais próprios, porta
  `127.0.0.1:5434` só para dev/testes), separado do Typebot e do Chatwoot.
- Migrations SQL em `apps/api/src/@modules/shared/database/migrations`, aplicadas na subida com
  advisory lock (seguro com mais de uma réplica). SQL puro com `pg`, sem ORM.
- Tabelas: `tenants`, `tenant_settings` (pós-atendimento **60 min** padrão),
  `applications`, `consumers`, `consumer_identities`, `attendance_counters`,
  `attendances`, `conversations` (1:1), `messages`, `attendance_access_tokens`,
  `attendance_otp_challenges`.
- Módulos: `tenants`, `consumers`, `attendances`, `messages`, `identity-access`.
  `AttendancesService` é o único que altera status/fase.

## Garantias (cada uma tem teste)

- Protocolo `ANO-SEQUENCIAL` por tenant, único e sem buracos sob concorrência
  (40 aberturas paralelas); reinicia por ano (no fuso do tenant).
- Um atendimento aberto por consumidor/aplicação: aberturas concorrentes
  reutilizam o mesmo protocolo (índice único parcial + advisory lock).
- Fase com versão otimista e mapa de transições; `closed`/`expired` terminais
  (trigger no banco: nem SQL direto reabre).
- Mensagens: idempotentes por chave (12 reenvios paralelos → 1 linha),
  imutáveis, ordem por `seq`, somente leitura após o encerramento (serviço **e**
  trigger).
- Expiração: `UPDATE` condicional com `SKIP LOCKED`; corrida resposta × expiração
  tem um único vencedor; `awaiting_business_hours` nunca expira.
- Isolamento: FKs compostas `(tenant_id, id)`; testes de leitura/escrita cruzada.
- Link individual: só hash do token, expiração, revogação (derruba sessões);
  OTP com HMAC, máx. 5 tentativas (vale sob concorrência), expiração, uso único,
  máx. 3 emissões/15 min. CPF/CNPJ só como hash.

## API pública (`/public`)

`POST /attendances` (visitante anônimo → protocolo + sessão), `POST /access/exchange`,
`POST /access/otp/request|verify`, `GET /attendance?after=<seq>`,
`POST /attendance/messages`, `POST /attendance/restart` (novo protocolo após
encerrado). Tenant/aplicação/atendimento vêm sempre da sessão, nunca do browser.

## Decisões minhas (não vieram do CLAUDE.md — revisar)

- `pg` + SQL puro em vez de ORM.
- Expiração por inatividade grava `status='expired'` (e `closed` fica para
  encerramento deliberado). O CLAUDE.md diz só "encerra com motivo X, autor system".
- Prazo geral de inatividade: placeholder de 24 h (pendência 19.8).
- Tokens de link continuam válidos após o encerramento (para ver histórico
  somente leitura e abrir novo protocolo); expiram em 24 h por padrão.
- Mapa de transições de fase (`PHASE_TRANSITIONS`) é derivado do diagrama.

## Pendências / não feito

- **Canal de envio do OTP** (19.3): só a interface `OtpSender` + implementação
  de log (`OTP_DEV_LOG=true`). Aplicações `auth_mode=otp` ainda não têm entrada
  (virá com o gateway WhatsApp).
- Rate limit HTTP por IP nas rotas públicas (só há limites de OTP no banco).
- Integração com as POCs (persistir mensagens do bot/atendente, reload sem
  perder histórico no front) → etapa 5. Hoje o front da POC não usa `/public`.
- Sem `audit_events`, `outbox_events`, `integration_inbox`, `business_hours*`,
  `notification_*`, tabelas do Typebot/Chatwoot (etapas 5 e 6).
- Sem papel de banco com RLS; isolamento é por FK composta + escopo nas queries.
- `npm run lint` já acusava ruído antes (regras `no-unsafe-*`); código novo está
  formatado com prettier mas não zerou o eslint.

## Rodar

```bash
docker compose up -d platform-db
cd apps/api && npm run test:int      # schema descartável por suíte
docker compose up -d --build api     # migra e cria seed tenant "poc"/app "chat"
```
