# Notas da POC #1 — Typebot self-hosted (validação de API)

> Observações de uma execução real, não especificação. Alimenta as
> pendências da seção 19 do CLAUDE.md. Plano original:
> `/home/dione/.claude/plans/shimmering-puzzling-wave.md`.

## Ambiente usado

- Typebot **v3.19.0** (release oficial de 2026-09-14), imagens
  `baptistearno/typebot-builder:3.19.0` e `baptistearno/typebot-viewer:3.19.0`.
- O compose oficial atual **exige Redis** além do Postgres — não é opcional
  como algumas fontes de terceiros sugeriam.
- Login do builder via magic link; usamos Mailpit como SMTP descartável.

## Armadilha encontrada

- `SMTP_AUTH_DISABLED=true` **desativa o login por e-mail inteiro** (não é
  "desativa só a autenticação SMTP para notificações", como o nome sugere).
  Precisa ficar `false` para usar magic link de login.

## Confirmado sobre a API

- A **API de chat é servida pelo serviço `typebot-viewer`** (porta 8081 no
  nosso compose), não pelo builder. `http://<viewer>/api/v1/...`.
- `POST /api/v1/typebots/{publicId}/startChat` e
  `POST /api/v1/sessions/{sessionId}/continueChat` funcionam exatamente como
  a documentação descreve, autenticados com `Authorization: Bearer <token>`.
- O token de API é criado em Configurações da conta → API tokens no builder;
  fica salvo em texto puro na tabela `ApiToken` (sem hash).
- **Resposta a bloco de escolha (`choice input`) usa o mesmo formato de texto
  livre**: `{"message": {"type": "text", "text": "<content da opção>"}}`,
  onde `<content>` é o texto exato do item escolhido. A documentação oficial
  não confirmava isso explicitamente — testamos e funcionou.
- Fluxo de 3 blocos (boas-vindas → input de texto → escolha → mensagem final)
  validado de ponta a ponta via curl e depois via navegador.

## Sobre reload sem perder sessão

- Não identificamos um endpoint do Typebot para recuperar o histórico de uma
  sessão existente a partir do zero — então o Nest guarda esse histórico.
- Decisão revisada após o primeiro teste: a versão inicial cacheava tudo em
  `localStorage` no Vue, mas isso faz o cliente ser a fonte da verdade (quebra
  entre abas/navegadores, e não é o padrão do resto do projeto). Trocamos
  para: o Nest mantém um **store em memória do chat, endereçado por um UUID
  próprio** (`chatId`, gerado com `crypto.randomUUID()`), distinto do
  `sessionId` do Typebot. Esse `chatId` vai pra URL do Vue (`?chat=<uuid>`);
  ao montar, o frontend busca `GET /poc/chats/:chatId` no Nest em vez de ler
  `localStorage`. Isso já é mais parecido com o padrão real do projeto
  (servidor como fonte da verdade), ainda que em memória — a persistência de
  verdade em Postgres só vem na "Fundação persistente" (seção 18).

## Explicitamente não testado aqui (fica para a POC #2)

- Bloco **Webhook** do Typebot como mecanismo de retomada assíncrona sem nova
  mensagem do consumidor (timeout padrão curto, comportamento relatado como
  inconsistente em WhatsApp pela comunidade — não validamos nada disso
  ainda).
- Qualquer coisa envolvendo `bot_operations`, outbox, Centrifugo.

## Infra usada (descartável, não é a infra de produto)

- `docker-compose.yml` (raiz) — sobe toda a infra da POC com `docker compose up`;
  ainda não é o compose "de produto" da seção 16 do CLAUDE.md.
- Endpoints temporários em
  `apps/api/src/modules/bot/infrastructure/typebot/typebot-poc.*`
  — sem tenant/protocolo, store em memória (não Postgres). Substituir pelos
  serviços reais (`BotOrchestratorService`, `TypebotProvider`) nas próximas
  etapas.
- Frontend em `apps/web-poc/` — protótipo, não é o SDK/chat final.
- Estrutura movida para o padrão monorepo (`apps/api` + `apps/web-poc`) depois
  da primeira versão, que tinha o Nest direto na raiz do repositório.
