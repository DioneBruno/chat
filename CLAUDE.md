# CLAUDE.md — Plataforma SaaS de Atendimento Digital Protocolado

> Documento de contexto e especificação para Claude Code ou qualquer outra IA que implemente o projeto. Atualizado em 13/10/2026. **Distinguir decisões fechadas, recomendações e pontos pendentes.** Não presumir que provas de conceito ou integrações já foram validadas.

## 1. Objetivo do produto

Construir uma plataforma SaaS multitenant de atendimento digital protocolado para empresas brasileiras. O consumidor inicia por WhatsApp da empresa ou link público, recebe um protocolo e realiza toda a conversa em **chat web próprio**. O atendimento começa sempre em um **Typebot** configurado pela equipe operadora do SaaS; quando necessário, passa para um atendente no **Chatwoot**; após o humano finalizar, retorna ao Typebot para pós-atendimento. A plataforma controla identidade, autorização, histórico, protocolos, prazos, horários comerciais e integrações. Iniciar com **um cliente piloto**, sem impedir expansão para múltiplas empresas.

## 2. Princípios arquiteturais (decididos)

- **NestJS/TypeScript**: núcleo e autoridade de negócio, implementado como monólito modular. Preferir `import` no TypeScript.
- **PostgreSQL**: fonte da verdade para tenants, protocolos, conversas, mensagens, estados, sessões, eventos e notificações.
- **Centrifugo**: WebSocket/pub-sub de entrega em tempo real, sem substituir persistência e sem autorizar diretamente consumidores sem validação do NestJS.
- **Typebot self-hosted, instância única compartilhada**: editor visual e runtime dos bots. **Um workspace e fluxos separados por empresa**, acessíveis somente à equipe interna do SaaS. Consumidor nunca acessa o editor.
- **Chatwoot**: somente interface do atendimento humano; usar integração de inbox/API e webhooks, sem usar Chatwoot como base canônica do histórico.
- **Chat web próprio**: SDK JavaScript e frontend Vue 3; mesma interface para mensagens do bot e do humano. Não incorporar obrigatoriamente widgets nativos do Typebot/Chatwoot.
- **WhatsApp gateway intercambiável**: abstração `WhatsAppGateway`, possivelmente Evolution API ou provedor oficial. WhatsApp serve como **porta de entrada e canal de avisos**, não como interface principal de conversa. Avaliar conformidade e riscos de provedores não oficiais.
- **Sem n8n no MVP**: Typebot cobre conversação e NestJS cobre integrações. Reavaliar n8n para automações complexas, considerando licenciamento.
- **Sem RabbitMQ, IA generativa, S3/anexos e notificações de resposta do atendente offline no MVP**. Utilizar `outbox_events` + worker/polling PostgreSQL para confiabilidade; introduzir filas se escala exigir. Chatwoot/Typebot podem ter dependências próprias (Redis, banco etc.).

## 3. Papéis e limites de responsabilidade

| Componente | Responsabilidade | Não deve fazer |
|---|---|---|
| NestJS | Protocolos, tenant, identidade, ACL, mensagens, estado, roteamento, integração, prazo, notificações | Delegar regras centrais ao bot |
| Typebot | Fluxos de perguntas, menus, condições e automação | Autorizar tenant, fechar protocolo por conta própria, acessar indiscriminadamente APIs |
| Chatwoot | Painel de atendentes e respostas humanas | Ser fonte única de mensagens/estado |
| Centrifugo | Publicação realtime por canal privado | Persistência canônica ou autorização independente |
| PostgreSQL | Histórico, dados de negócio, outbox, deduplicação | — |
| Vue 3 SDK | Chat, menus, indicadores, reconexão | Escolher IDs externos de bot ou manipular estado de protocolo |

O NestJS é a **autoridade do tenant e responsável atual pela conversa**. Typebot e Chatwoot **não podem atuar simultaneamente** como responsáveis pelo mesmo atendimento.

## 4. Fluxo do consumidor e protocolo

1. Entrada pelo WhatsApp da empresa ou link público genérico do chat.
2. NestJS cria **imediatamente** um atendimento/protocolo com número **`ANO-SEQUENCIAL` por tenant**, ex.: `2026-000001` (controle concorrente transacional e unicidade por tenant/ano).
3. No WhatsApp, gateway envia **link individual seguro**; o atendimento continua **exclusivamente no chat web**. Se a pessoa enviar novas mensagens no WhatsApp enquanto existir atendimento aberto, reutilizar **o mesmo protocolo/link**. Após encerramento, criar novo protocolo.
4. Link individual usa **token aleatório revogável + OTP para entrar**. Não expor CPF/CNPJ no link; armazenar hashes de tokens, expiração, limites de tentativa e revogação. **Canal de envio do OTP ainda pendente**.
5. Ao abrir o chat, NestJS verifica autorização e recupera histórico. Fechar a página **não encerra** o atendimento.
6. **Todo atendimento inicia no Typebot**. O bot pode resolver, encaminhar ao Chatwoot ou tratar ausência de expediente.
7. Protocolo encerrado é **somente leitura**. Novo contato exige novo protocolo.

### Identificação do consumidor

- Pode ser autenticado no sistema existente da empresa ou visitante anônimo, conforme configuração da aplicação.
- Para visitante, Typebot pode solicitar CPF/CNPJ, consultar API empresarial e vincular cadastro; se inexistente, coletar nome/contato e criar cadastro provisório.
- **CPF/CNPJ não autentica**; só usar dados autorizados ao nível de confiança. Consultas sensíveis devem ir ao humano no MVP.
- Identidade do consumidor, canal e protocolo são entidades distintas. Evitar duplicação de protocolos para um mesmo contato aberto.

## 5. Fluxo do bot e do humano (decidido)

```text
WhatsApp ou link público
    -> NestJS cria/recupera protocolo
    -> autenticação/autorização no chat web
    -> Typebot (atendimento inicial)
       |-> resolve -> encerra segundo fluxo/regra
       |-> solicita humano -> NestJS handoff_pending
              -> Chatwoot (atendimento humano)
              -> atendente resolve conversa
              -> NestJS returning_to_bot
              -> NOVA sessão Typebot (pós-atendimento)
                    pergunta: "Posso ajudar com mais alguma coisa?"
                    |-> NÃO -> fecha protocolo
                    |-> SIM -> continua bot, pode voltar ao humano
                    |-> silêncio -> encerra após prazo configurável
```

- **Fluxos Typebot distintos**: `initial` e `post_service` (podem existir `business_hours` e `auxiliary`).
- O encerramento de conversa no Chatwoot **não fecha diretamente** o protocolo: aciona retorno controlado pelo NestJS ao Typebot.
- Usar webhook Chatwoot autenticado/deduplicado, mapear IDs externos e impedir loops de eventos. No handoff, criar/recuperar contato/conversa Chatwoot e fornecer contexto mínimo permitido.
- Persistir todas as mensagens do consumidor, bot, atendente e sistema no PostgreSQL, com idempotência. Publicar eventos pelo Centrifugo depois da persistência.
- Durante `handoff_pending`, guardar mensagens e encaminhar depois de confirmar o responsável; nunca perder mensagens.
- Cada ciclo de bot/humano pode gerar uma nova sessão; não presumir que sessão Typebot anterior continua válida.

## 6. Inatividade pós-atendimento humano (DECISÃO FECHADA)

- **Padrão: 60 minutos por empresa**, configurável por `tenant`.
- Contar a partir da **entrega/persistência da pergunta de pós-atendimento** ao consumidor.
- Se responder, cancelar deadline e continuar fluxo. Se não responder, NestJS encerra automaticamente o protocolo com motivo `post_service_inactivity` e autor `system`.
- Job/worker consulta vencimentos no PostgreSQL; usar condição transacional para impedir corrida entre resposta e expiração.
- Prazo de pós-atendimento **é diferente** do prazo geral de inatividade (também configurável por tenant).

## 7. Horário comercial e aviso (DECISÕES FECHADAS)

- Horário comercial configurável por empresa, com fuso, dias, feriados e exceções.
- Se consumidor pedir humano fora do expediente, Typebot informa que **não há atendentes humanos naquele momento** e pergunta se quer ser avisado na reabertura.
- Se aceitar, coleta **telefone e e-mail** (pode reaproveitar dados confirmados), registra consentimento por canal, vínculo ao protocolo e agendamento.
- Avisar na retomada do horário comercial por **WhatsApp e e-mail, quando disponíveis e autorizados**. Tratar falha dos canais independentemente, retries, deduplicação e regras de template/opt-in do WhatsApp. **Não prometer atendente específico ou disponibilidade imediata**.
- Protocolo permanece **aberto** na fase `awaiting_business_hours`, **sem expiração por inatividade enquanto aguarda a reabertura**.
- O aviso inclui **link seguro para retomar o mesmo protocolo**; não criar protocolo duplicado. Após retorno, Typebot retoma e pode transferir ao humano conforme horário/disponibilidade.
- Aviso não gera automaticamente uma conversa humana/posição de fila; consumidor retorna pelo link.
- Se consumidor recusar aviso, Typebot pode continuar atendimento automático ou encerrar conforme fluxo.

## 8. Multitenancy do Typebot (DECISÃO FECHADA)

- **Uma única instalação self-hosted Typebot** para todos os tenants; **workspace separado por empresa**.
- Somente a equipe interna do SaaS configura/publica fluxos no editor Typebot; clientes não têm acesso ao editor no MVP.
- NestJS mantém vínculo `tenant -> workspace -> fluxos publicados -> sessões`; seleciona fluxo por tenant, aplicação e tipo, com fallback para fluxo padrão da empresa.
- Browser nunca escolhe `external_typebot_id`, `flowId` externo, workspace ou `sessionId`; NestJS resolve e valida.
- Integrações com APIs das empresas devem passar **preferencialmente pelo NestJS** usando ações explicitamente permitidas, credenciais segregadas, autorização por consumidor/tenant, filtragem de respostas, timeouts, rate limits, proteção SSRF e auditoria sanitizada.
- Não confiar apenas na segregação por workspace: testes automatizados de isolamento cruzado e controles no NestJS são obrigatórios.
- Infraestrutura compartilhada implica risco operacional compartilhado; definir backups, monitoramento, limites de carga e plano de evolução.
- **Pendência jurídica/operacional:** validar termos/licenciamento Typebot aplicáveis à oferta SaaS, mesmo com editor interno; também avaliar licenças do Chatwoot e de eventuais gateways.

## 9. Estados do domínio

Separar **status do protocolo** da **fase de atendimento**:

```typescript
type AttendanceStatus = 'open' | 'closed' | 'expired';
type AttendancePhase =
  | 'bot'
  | 'awaiting_business_hours'
  | 'handoff_pending'
  | 'human'
  | 'returning_to_bot'
  | 'post_service';
```

- `status=open` pode coexistir com qualquer fase ativa.
- `handoff_pending` e `returning_to_bot` são estados transitórios recuperáveis em caso de falha.
- Só o serviço de orquestração do NestJS altera fases/status.
- `closed` e `expired` são terminais; histórico somente leitura.
- Opcional: estado detalhado da sessão `starting | active | waiting_operation | completed | interrupted | failed`.

## 10. Modelo de dados sugerido

Todas as tabelas de negócio devem incluir `tenant_id` onde aplicável, índices e FKs que impeçam associações cruzadas. UUIDs internos, timestamps `timestamptz` e convenções consistentes. **Modelo proposto, não migrations finalizadas.**

### Núcleo

- `tenants`: empresa, nome, status.
- `tenant_settings`: timezone, `post_service_inactivity_minutes DEFAULT 60`, prazo geral, flags de handoff, configurações de aviso.
- `business_hours`, `business_hours_exceptions`: dias, intervalos, feriados/exceções.
- `applications`: canais/aplicações, identidade exigida, regras de autenticação.
- `consumers`, `consumer_identities`: pessoas, identidades externas/visitantes, canais/contatos e status de verificação.
- `attendances`: `id`, `tenant_id`, `application_id`, `consumer_id`, `protocol_year`, `protocol_sequence`, `protocol_number`, `status`, `phase`, `inactivity_deadline_at`, `closed_reason`, `closed_by`, `state_version`, timestamps.
- `attendance_counters`: (`tenant_id`, `year`) chave única; `next_sequence` gerado transacionalmente. Unique (`tenant_id`,`protocol_year`,`protocol_sequence`).
- `conversations`: conversa própria associada ao atendimento; pode modelar 1:1 no MVP.
- `messages`: `tenant_id`, `attendance_id`, `conversation_id`, `sender_type` (`consumer|bot|agent|system`), `content` estruturado, IDs externos, chave idempotente, timestamps.
- `attendance_access_tokens` e `attendance_otp_challenges`: hashes, expiração, uso, tentativas, revogação.

### Typebot

- `bot_providers`: configuração da instalação Typebot, endpoint e estado; credenciais em secret store, não plaintext.
- `tenant_bot_workspaces`: `tenant_id`, `bot_provider_id`, `external_workspace_id`, `enabled`; unicidade por tenant/provider e provider/workspace.
- `bot_flows`: `tenant_id`, workspace, `application_id NULLABLE`, `kind` (`initial|post_service|business_hours|auxiliary`), IDs externos de fluxo/publicação, `enabled`, revisão publicada. Garantir um fluxo padrão ativo por tipo e um por aplicação/tipo.
- `bot_sessions`: `tenant_id`, `attendance_id`, `bot_flow_id`, `provider_session_id`, `status`, `last_processed_message_id`, `state_version`, timestamps. Um atendimento pode ter múltiplas sessões.
- `bot_operations`: consultas empresariais assíncronas, detalhadas abaixo.

### Chatwoot e avisos

- `human_sessions`: `tenant_id`, `attendance_id`, IDs externos de account/inbox/contact/conversation, status, início/fim. Permitir múltiplos ciclos humanos por protocolo.
- `notification_requests`: `tenant_id`, `attendance_id`, telefone/e-mail, consentimentos e horários, próxima abertura, status.
- `notification_deliveries`: por solicitação e canal (`whatsapp|email`), status, tentativas, ID externo, erro sanitizado, idempotência.

### Confiabilidade

- `outbox_events`: eventos transacionais, payload mínimo, status, tentativas, `next_attempt_at`, lease, timestamps.
- `integration_inbox`: webhooks recebidos, provider, ID externo, hash/chave idempotente, processamento.
- `audit_events`: transições, ações sensíveis e operações; **não** guardar segredos, CPF/CNPJ ou respostas sensíveis sem necessidade.

## 11. Contratos de integração (abstrações internas)

```typescript
interface BotProvider {
  startSession(input: StartBotSessionInput): Promise<BotTurnResult>;
  continueSession(input: ContinueBotSessionInput): Promise<BotTurnResult>;
}
interface HumanSupportProvider {
  createOrGetConversation(input: {
    tenantId: string;
    attendanceId: string;
    consumerId: string;
  }): Promise<{ externalConversationId: string }>;
  sendMessage(input: {
    externalConversationId: string;
    messageId: string;
    content: unknown;
  }): Promise<void>;
}
```

- Implementações: `TypebotProvider`, `ChatwootProvider`, `WhatsAppGateway`.
- `BotOrchestratorService` controla fase e sessão; `BotFlowResolverService` resolve fluxo por tenant/aplicação/tipo; `TypebotMessageMapper` converte mensagens/inputs/choices para contrato próprio do chat.
- Formato de mensagem do chat: `sender=consumer|bot|agent|system`; conteúdos `text`, `options`, `input` inicialmente. Validar escolhas contra a etapa ativa; não confiar em opção antiga.
- **Os tipos acima são contratos próprios sugeridos, não formatos oficiais de API.** Confirmar contratos reais da versão Typebot/Chatwoot instalada.

## 12. Eventos internos sugeridos

| Evento | Efeito |
|---|---|
| `attendance.created` | Inicia sessão Typebot inicial |
| `message.received` | Persiste e roteia ao responsável |
| `bot.handoff_requested` | Marca `handoff_pending`, agenda integração Chatwoot |
| `human.conversation_created` | Confirma vínculo e fase `human` |
| `human.conversation_resolved` | Retorna ao bot pós-atendimento |
| `bot.post_service_started` | Registra pergunta e deadline configurável |
| `attendance.business_hours_wait_requested` | Marca `awaiting_business_hours` e suspende expiração |
| `business_hours.resumed` | Processa avisos autorizados |
| `attendance.inactivity_expired` | Encerra após verificação transacional |
| `attendance.closed` | Cancela operações e finaliza acessos/sessões |

São **eventos internos do NestJS**, não nomes oficiais de webhooks Typebot/Chatwoot.

## 13. Processamento assíncrono de consultas (DECISÃO FECHADA)

**Experiência desejada:** consumidor solicita consulta; chat exibe "Consultando suas informações..."; worker NestJS consulta API empresarial; resultado aparece automaticamente pelo Centrifugo, sem recarregar a página nem exigir nova mensagem do consumidor.

### Protocolo lógico

1. Typebot solicita uma ação HTTP **rápida** ao NestJS, por exemplo `POST /internal/bot/operations`, com credencial de execução de curta duração e escopo limitado. Exemplo de `action`: `customer.requests.list`.
2. NestJS valida tenant, protocolo, sessão, identidade, ação autorizada, limites e idempotência; grava `bot_operations` e retorna `{operationId,status:'pending'}` imediatamente.
3. Typebot apresenta mensagem de processamento; NestJS registra sessão como `waiting_operation` ou estado equivalente.
4. Worker reivindica operações pendentes com `FOR UPDATE SKIP LOCKED` e lease, **sem manter transação aberta durante HTTP**; aplica timeout, retry/backoff e políticas por tipo de ação.
5. Worker persiste resultado **sanitizado**, conclui operação de forma idempotente e publica via outbox.
6. NestJS retoma fluxo Typebot se API suportar continuação programática; persiste mensagens resultantes e publica `message.created` pelo Centrifugo. Se não suportar, NestJS pode entregar resultado diretamente e iniciar um **fluxo de continuação** Typebot.
7. Vue 3 remove indicador ao concluir/falhar e recupera mensagens/operações pendentes pela API ao reconectar.

### Campos de `bot_operations`

`id`, `tenant_id`, `attendance_id`, `bot_session_id`, `action`, `parameters JSONB`, `result JSONB`, `status`, `idempotency_key`, `attempts`, `next_attempt_at`, `lease_expires_at`, `state_version`, `created_at`, `completed_at`. Status `pending|processing|completed|failed|cancelled`.

### Garantias

- Uma operação bloqueante por sessão, salvo desenho explícito para concorrência.
- Sessões avançam serialmente por atendimento, com lock curto ou versionamento; não manter lock durante chamada externa.
- Resultados tardios não alteram protocolos encerrados ou sessões que mudaram de estado.
- Não repetir cegamente chamada de avanço Typebot após timeout: pode ter sido processada; reconciliar estados.
- Chaves de idempotência para operações, eventos, mensagens e webhooks; publicação só após persistência.
- Retry de leitura é diferente de operações mutáveis; operações mutáveis exigem idempotência no sistema externo.
- Eventos de Centrifugo são sinais; banco é fonte da verdade.

### Eventos realtime sugeridos

`bot.operation.started`, `bot.operation.completed`, `bot.operation.failed`, `message.created`, `attendance.updated`. Canais privados por atendimento; autorizar assinatura via NestJS. Não incluir dados sensíveis em payload de notificação sem necessidade.

## 14. PONTO TÉCNICO NÃO VALIDADO: retomada assíncrona do Typebot

**Não afirmar que a API Typebot permite injetar arbitrariamente um resultado em uma sessão pausada.** Antes da implementação definitiva, validar com a versão self-hosted escolhida:

- Início de sessão e persistência de `sessionId`.
- Renderização e resposta a textos, menus e inputs no chat próprio.
- Como uma ação HTTP pode registrar operação e retornar imediatamente.
- Se é possível avançar a sessão automaticamente sem nova mensagem do consumidor e com variáveis de resultado.
- Como impedir o Typebot de seguir prematuramente após registrar a operação.
- Se a retomada não for possível, testar continuação por fluxo específico, com resultado publicado pelo NestJS.
- Handoff seguro, retorno ao pós-atendimento e deduplicação.

**Primeiro fazer POC pequena**, com consulta simulada de 5 segundos, antes de implementar infraestrutura completa. Fixar uma versão estável específica do Typebot em Docker e validar a API real. Versão **ainda não escolhida**.

## 15. Segurança e conformidade

- Isolamento multitenant em todas as consultas; FKs/índices compostos quando apropriado, testes de vazamento entre tenants.
- Tokens de link e OTP com hash, expiração, rate limiting e revogação; link não é autenticação suficiente para dados sensíveis.
- Tokens internos de execução do bot vinculados a tenant, protocolo, sessão e ações permitidas; validação de webhooks, assinatura quando suportada.
- Integrações HTTP empresariais com allowlist de domínios/hosts, bloqueio SSRF e endereços privados, controle de redirecionamentos, credenciais segregadas, limites de resposta e timeouts.
- Minimização e proteção de dados pessoais; LGPD, retenção, acesso, auditoria e política de descarte.
- Verificar consentimentos e templates necessários para mensagens WhatsApp iniciadas pela empresa.
- Acesso ao builder Typebot apenas pela equipe interna, com permissões mínimas; fluxo publicado e alterado com controle de revisão.
- Validar licenciamento/termos Typebot e demais serviços para SaaS comercial; não presumir autorização pela simples hospedagem interna.

## 16. Implantação sugerida

Serviços lógicos na infraestrutura própria: `nestjs-api`, `nestjs-worker`, `centrifugo`, `typebot-builder`, `typebot-viewer`, `chatwoot`, Redis conforme dependências, PostgreSQL com bancos/usuários separados para plataforma, Typebot e Chatwoot. Podem compartilhar servidor PostgreSQL inicialmente, com isolamento lógico, backup e credenciais próprias. Implantação com Docker Compose é aceitável no MVP. Segredos fora do repositório. Observabilidade e logs com `tenant_id`, `attendance_id`, `operation_id` e correlation IDs, sem dados sensíveis.

## 17. Organização de módulos NestJS sugerida

```text
src/modules/
  tenants/
  applications/
  consumers/
  identity-access/
  attendances/
  conversations/
  messages/
  bot/
    domain/bot-provider.interface.ts
    application/bot-orchestrator.service.ts
    application/bot-flow-resolver.service.ts
    infrastructure/typebot/typebot.provider.ts
    infrastructure/typebot/typebot.client.ts
    infrastructure/typebot/typebot-message.mapper.ts
  bot-operations/
  human-support/infrastructure/chatwoot/
  whatsapp/
  business-hours/
  notifications/
  realtime/
  outbox/
  integration-inbox/
  audit/
```

## 18. Sequência de implementação

1. **POC Typebot:** instalar versão fixa, fluxo simples com pergunta/menu, sessão pela API e renderização no Vue 3.
2. **POC assíncrona:** simular ação de 5 segundos, exibir processamento, confirmar retomada ou fallback e entrega sem nova mensagem.
3. **POC Chatwoot:** handoff, mensagem bidirecional, webhook de resolução, novo fluxo Typebot de pós-atendimento.
4. **Fundação persistente:** tenants, applications, consumers, protocolos e sequenciais, tokens/OTP, conversas e mensagens.
5. **Confiabilidade:** bot_sessions, human_sessions, bot_operations, outbox, inbox, worker, locks/versionamento, realtime.
6. **Regras empresariais:** horário comercial, aviso WhatsApp/e-mail, `awaiting_business_hours`, expiração pós-humano de 60 min.
7. **Hardening:** testes de isolamento, autorização, concorrência, retries, segurança, observabilidade e licenciamento.

### Critérios mínimos da POC

- Criar sessão e avançar menu Typebot.
- Recarregar página sem perder histórico/sessão.
- Consulta de 5 segundos não bloqueia requisição HTTP e atualiza chat automaticamente.
- Não duplica resposta com retries ou eventos repetidos.
- Não publica resultados de protocolo encerrado.
- Transferência Chatwoot e retorno ao Typebot no mesmo protocolo.
- Expiração de 60 minutos no pós-atendimento (testar com prazo reduzido).
- Reabertura comercial preserva protocolo e envia avisos autorizados.

## 19. Pendências a resolver sem inventar requisitos

1. **Versão exata Typebot e contratos oficiais** de execução, ações HTTP, sessões e retomada programática.
2. **Mecanismo de continuação assíncrona** efetivamente suportado (retomar sessão vs. fluxo de continuação).
3. **Canal e regras de OTP**, identidade e vínculo de consumidor entre canais.
4. Detalhes de autenticação/segurança do Chatwoot e tipo de inbox adequado à versão instalada.
5. **Provedor WhatsApp** e conformidade com regras da Meta.
6. Licenciamento do Typebot para uso comercial SaaS; avaliar Chatwoot e gateway.
7. Políticas de retenção LGPD, backups e restauração.
8. Critérios exatos para bot encerrar protocolo sem humano e prazo geral de inatividade.
9. Comportamento de operação em andamento quando usuário tenta interromper ou pedir humano.
10. Limites e timeouts das APIs empresariais, retries e contratos de ações autorizadas.

## 20. Instruções para a IA implementadora

- **Respeitar decisões fechadas**, sobretudo: início sempre no Typebot; Chatwoot só humano; retorno ao Typebot pós-humano; **60 minutos padrão** configurável; espera fora do expediente sem expiração; avisos por WhatsApp e e-mail autorizados; Typebot único com workspace por tenant; processamento assíncrono e Centrifugo.
- Não substituir NestJS como orquestrador por Typebot/Chatwoot/n8n.
- Não inventar recursos de API de terceiros. Consultar documentação e testar versão instalada antes de codificar integração crítica.
- Preferir interfaces/adaptadores, serviços de domínio e testes de concorrência/isolamento.
- Diferenciar **recomendação técnica** de **regra já aprovada**. Perguntar somente quando uma pendência bloquear implementação.
- Começar com POC mínima e evoluir para persistência confiável; não adicionar infraestrutura desnecessária ao MVP.
