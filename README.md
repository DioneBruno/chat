# Plataforma de Atendimento Digital Protocolado

SaaS multitenant de atendimento digital protocolado (Typebot → Chatwoot → Typebot), com NestJS como orquestrador. A especificação completa está no [CLAUDE.md](CLAUDE.md).

> **Estado atual:** POC #2 (consulta assíncrona + Centrifugo, ver [docs/poc-async-notas.md](docs/poc-async-notas.md); validação contra o Typebot real pendente) sobre a POC #1 (validação da API do Typebot self-hosted + chat em Vue 3). A API Nest **ainda não usa banco de dados** (o histórico do chat fica em memória). O único banco existente hoje é o PostgreSQL do próprio Typebot.

## Estrutura

```text
apps/api        API NestJS (porta 3000 por padrão)
apps/web-poc    Chat de teste em Vue 3 + Vite (porta 5173)
infra/typebot-poc  docker-compose do Typebot v3.19.0 + Postgres + Redis + Mailpit
docs/           Notas das POCs
```

## Pré-requisitos

- Docker + Docker Compose
- Node.js 20+ e npm
- `openssl` (para gerar o segredo do Typebot)

## Como subir

### 1. Infra do Typebot (Docker)

```bash
cd infra/typebot-poc
cp .env.example .env
# gere o segredo e cole em ENCRYPTION_SECRET no .env
openssl rand -base64 24 | tr -d '\n'; echo
docker compose up -d
docker compose ps        # aguarde db e redis ficarem "healthy"
```

| Serviço | URL / porta | Observação |
|---|---|---|
| Typebot builder (editor) | http://localhost:8080 | Login por magic link |
| Typebot viewer (API de chat) | http://localhost:8081 | A API é `/api/v1/...` |
| Mailpit (SMTP descartável) | http://localhost:8025 | Receba aqui o magic link de login |
| Mailpit SMTP | `localhost:1025` | |

### 2. Configurar o Typebot (primeira vez)

1. Abra http://localhost:8080, informe `admin@poc.local` (valor de `ADMIN_EMAIL`) e abra o link recebido no Mailpit (http://localhost:8025).
2. Crie e **publique** um fluxo simples (boas-vindas → input → escolha → mensagem final).
3. Copie o **public ID** do fluxo publicado (será o `TYPEBOT_ID`).
4. Em *Configurações da conta → API tokens*, crie um token (será o `TYPEBOT_API_TOKEN`).

### 3. API (NestJS)

Crie `apps/api/.env` (não versionado):

```env
PORT=3001
TYPEBOT_API_URL=http://localhost:8081/api
TYPEBOT_ID=<public-id-do-fluxo>
TYPEBOT_API_TOKEN=<token-criado-no-builder>
```

> `PORT=3001` é necessário: o front da POC aponta para `http://localhost:3001` (hardcoded em [App.vue](apps/web-poc/src/App.vue)). Sem `PORT`, a API sobe na 3000.

```bash
cd apps/api
npm install
npm run start:dev
```

Endpoints da POC: `POST /poc/chats`, `GET /poc/chats/:id`, `POST /poc/chats/:id/messages`.

### 4. Frontend (Vue 3)

```bash
cd apps/web-poc
npm install
npm run dev
```

Acesse http://localhost:5173. O chat guarda o `chatId` na URL (`?chat=<uuid>`), então recarregar a página mantém o histórico (enquanto a API não for reiniciada, pois o store é em memória).

### Parar / limpar

```bash
cd infra/typebot-poc
docker compose down        # mantém os dados (volumes)
docker compose down -v     # apaga banco e Redis do Typebot
```

## Bancos de dados

### PostgreSQL do Typebot (`typebot-db`)

Credenciais definidas no [docker-compose.yml](infra/typebot-poc/docker-compose.yml):

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
cd infra/typebot-poc
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
- **API retorna erro ao iniciar chat:** confira `TYPEBOT_ID` (fluxo precisa estar publicado) e `TYPEBOT_API_TOKEN` no `apps/api/.env`.
- **CORS / front não conecta:** verifique se a API está na porta 3001.

Notas detalhadas da POC: [docs/poc-typebot-notas.md](docs/poc-typebot-notas.md).
