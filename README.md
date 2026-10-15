# Plataforma de Atendimento Digital Protocolado

SaaS multitenant de atendimento digital protocolado (Typebot → Chatwoot → Typebot), com NestJS como orquestrador. A especificação completa está no [CLAUDE.md](CLAUDE.md).

> **Estado atual:** POC #2 (consulta assíncrona + Centrifugo, ver [docs/poc-async-notas.md](docs/poc-async-notas.md); validação contra o Typebot real pendente) sobre a POC #1 (validação da API do Typebot self-hosted + chat em Vue 3). A API Nest **ainda não usa banco de dados** (o histórico do chat fica em memória). O único banco existente hoje é o PostgreSQL do próprio Typebot.

## Estrutura

```text
apps/api        API NestJS (porta 3000 por padrão)
apps/web-poc    Chat de teste em Vue 3 + Vite (porta 5173)
docker-compose.yml  Infra completa: Typebot v3.19.0 + Postgres + Redis + Mailpit + Centrifugo + API + front
docs/           Notas das POCs
```

## Pré-requisitos

- Docker + Docker Compose
- Node.js 20+ e npm
- `openssl` (para gerar o segredo do Typebot)

## Como subir

```bash
docker compose up -d --build
```

Um único comando sobe toda a infra (Typebot, Postgres, Redis, Mailpit, Centrifugo, API e front). Não é preciso `.env` para a primeira subida; para sobrescrever defaults copie `.env.example` para `.env`.

| Serviço | URL / porta | Observação |
|---|---|---|
| Front (chat Vue 3) | http://localhost:5173 | |
| API NestJS | http://localhost:3001 | Endpoints `POST /poc/chats`, `GET /poc/chats/:id`, `POST /poc/chats/:id/messages` |
| Typebot builder (editor) | http://localhost:8080 | Login por magic link |
| Typebot viewer (API de chat) | http://localhost:8081 | A API é `/api/v1/...` |
| Centrifugo | http://localhost:8000 | |
| Mailpit (SMTP descartável) | http://localhost:8025 | Receba aqui o magic link de login |

### Configurar o Typebot (primeira vez)

1. Abra http://localhost:8080, informe `admin@poc.local` (valor de `ADMIN_EMAIL`) e abra o link recebido no Mailpit.
2. Crie e **publique** um fluxo simples (boas-vindas → input → escolha → mensagem final).
3. Copie o **public ID** do fluxo publicado (`TYPEBOT_ID`).
4. Em *Configurações da conta → API tokens*, crie um token (`TYPEBOT_API_TOKEN`).
5. Coloque os dois no `.env` da raiz e recrie a API: `docker compose up -d api`.

### Desenvolvimento local (sem containers para API/front)

```bash
docker compose up -d typebot-builder typebot-viewer centrifugo mailpit
cd apps/api && npm install && npm run start:dev    # precisa de apps/api/.env com PORT=3001, TYPEBOT_*
cd apps/web-poc && npm install && npm run dev      # http://localhost:5173
```

### Parar / limpar

```bash
docker compose down        # mantém os dados (volumes)
docker compose down -v     # apaga banco e Redis do Typebot
```

## Bancos de dados

### PostgreSQL do Typebot (`typebot-db`)

Credenciais definidas no [docker-compose.yml](docker-compose.yml):

| Item | Valor |
|---|---|
| Banco | `typebot` |
| Usuário | `postgres` |
| Senha | `typebot` |
| Porta | **5432 não é publicada no host** |
| URL interna (entre containers) | `postgresql://postgres:typebot@typebot-db:5432/typebot` |
| Volume | `db-data` |

Acesso via `psql` dentro do container:

```bash
docker compose exec typebot-db psql -U postgres -d typebot
```

Exemplos úteis:

```sql
\dt                                  -- lista tabelas
SELECT * FROM "ApiToken";            -- tokens de API (guardados em texto puro)
```

Para conectar com um cliente gráfico (DBeaver, DataGrip, etc.), publique a porta adicionando ao serviço `typebot-db` no compose:

```yaml
    ports:
      - "5433:5432"
```

Depois `docker compose up -d` e conecte em `localhost:5433` (usuário `postgres`, senha `typebot`, banco `typebot`). Use 5433 para não conflitar com um Postgres local.

### Redis do Typebot (`typebot-redis`)

Sem porta publicada; acesso via container:

```bash
docker compose exec typebot-redis redis-cli
```

### Banco da plataforma (NestJS)

Ainda não existe. Na etapa "Fundação persistente" (seção 18 do [CLAUDE.md](CLAUDE.md)) será criado um banco PostgreSQL próprio, separado do Typebot e do Chatwoot. Atualize esta seção quando for adicionado.

## Comandos úteis

```bash
# API
cd apps/api
npm run lint
npm test
npm run test:e2e
npm run build

# Frontend
cd apps/web-poc
npm run build
```

## Problemas comuns

- **Login por e-mail do Typebot não funciona:** `SMTP_AUTH_DISABLED` deve ser `false` (com `true` o login por magic link é desativado por completo).
- **API retorna erro ao iniciar chat:** confira `TYPEBOT_ID` (fluxo precisa estar publicado) e `TYPEBOT_API_TOKEN` no `.env` da raiz (ou `apps/api/.env` no modo local).
- **CORS / front não conecta:** verifique se a API está na porta 3001.

Notas detalhadas da POC: [docs/poc-typebot-notas.md](docs/poc-typebot-notas.md).
