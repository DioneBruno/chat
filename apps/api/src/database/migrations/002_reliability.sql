-- Confiabilidade (CLAUDE.md seções 10, 12, 13): outbox, inbox, Typebot, sessões do bot,
-- operações assíncronas e sessões humanas. Modelo proposto; ajustar conforme a operação real.

-- ---------------------------------------------------------------- outbox / inbox

-- Eventos gravados na mesma transação da mudança de estado e entregues ao menos uma vez
-- pelo worker (handlers idempotentes). Um evento por atendimento é processado por vez.
CREATE TABLE outbox_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq              bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id        uuid REFERENCES tenants (id),
  attendance_id    uuid,
  type             text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key       text,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'dead')),
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 10,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  FOREIGN KEY (tenant_id, attendance_id) REFERENCES attendances (tenant_id, id)
);
CREATE UNIQUE INDEX outbox_dedupe ON outbox_events (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX outbox_due ON outbox_events (next_attempt_at, seq) WHERE status = 'pending';
CREATE INDEX outbox_leases ON outbox_events (lease_expires_at) WHERE status = 'processing';
CREATE INDEX outbox_by_attendance ON outbox_events (attendance_id) WHERE status IN ('pending', 'processing');

-- Webhooks recebidos: deduplicação por (provider, chave idempotente).
CREATE TABLE integration_inbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         text NOT NULL,
  idempotency_key  text NOT NULL,
  payload_hash     text NOT NULL,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  detail           text,
  received_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  UNIQUE (provider, idempotency_key)
);

-- ---------------------------------------------------------------- Typebot (seção 8)

-- Credenciais ficam fora do banco: `credentials_ref` é só o nome da variável/segredo.
CREATE TABLE bot_providers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL DEFAULT 'typebot' CHECK (kind IN ('typebot')),
  name             text NOT NULL UNIQUE,
  endpoint         text NOT NULL,
  credentials_ref  text,
  enabled          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_bot_workspaces (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id),
  bot_provider_id       uuid NOT NULL REFERENCES bot_providers (id),
  external_workspace_id text NOT NULL,
  enabled               boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, bot_provider_id),
  UNIQUE (bot_provider_id, external_workspace_id),
  UNIQUE (tenant_id, id)
);

CREATE TABLE bot_flows (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  workspace_id        uuid NOT NULL,
  application_id      uuid,
  kind                text NOT NULL CHECK (kind IN ('initial', 'post_service', 'business_hours', 'auxiliary')),
  external_flow_id    text NOT NULL,  -- public ID do fluxo publicado
  published_revision  text,
  enabled             boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES tenant_bot_workspaces (tenant_id, id),
  FOREIGN KEY (tenant_id, application_id) REFERENCES applications (tenant_id, id),
  UNIQUE (tenant_id, id)
);
-- Um fluxo padrão ativo por tipo e um por aplicação/tipo.
CREATE UNIQUE INDEX bot_flows_default ON bot_flows (tenant_id, kind) WHERE application_id IS NULL AND enabled;
CREATE UNIQUE INDEX bot_flows_by_application ON bot_flows (tenant_id, application_id, kind)
  WHERE application_id IS NOT NULL AND enabled;

-- ---------------------------------------------------------------- sessões do bot

CREATE TABLE bot_sessions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL,
  attendance_id              uuid NOT NULL,
  bot_flow_id                uuid NOT NULL,
  kind                       text NOT NULL,
  provider_session_id        text,
  status                     text NOT NULL DEFAULT 'starting'
                               CHECK (status IN ('starting', 'active', 'waiting_operation', 'completed', 'interrupted', 'failed')),
  -- Etapa ativa (opções/entrada) para validar escolhas: opção antiga não vale.
  pending_input              jsonb,
  last_processed_message_id  uuid,
  last_processed_seq         bigint NOT NULL DEFAULT 0,
  state_version              integer NOT NULL DEFAULT 1,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  ended_at                   timestamptz,
  FOREIGN KEY (tenant_id, attendance_id) REFERENCES attendances (tenant_id, id),
  FOREIGN KEY (tenant_id, bot_flow_id) REFERENCES bot_flows (tenant_id, id),
  UNIQUE (tenant_id, id)
);
-- No máximo uma sessão viva por atendimento: bot e humano nunca atuam juntos.
CREATE UNIQUE INDEX bot_sessions_one_live ON bot_sessions (tenant_id, attendance_id)
  WHERE status IN ('starting', 'active', 'waiting_operation');
CREATE INDEX bot_sessions_by_attendance ON bot_sessions (tenant_id, attendance_id, created_at);

-- ---------------------------------------------------------------- operações assíncronas (seção 13)

CREATE TABLE bot_operations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  attendance_id     uuid NOT NULL,
  bot_session_id    uuid NOT NULL,
  action            text NOT NULL,
  parameters        jsonb NOT NULL DEFAULT '{}'::jsonb,
  result            jsonb,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  idempotency_key   text NOT NULL,
  attempts          integer NOT NULL DEFAULT 0,
  max_attempts      integer NOT NULL DEFAULT 3,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  lease_expires_at  timestamptz,
  last_error        text,
  -- Retomada do Typebot: NULL (não iniciada) | resuming | resumed | fallback (entrega direta).
  resume_status     text CHECK (resume_status IN ('resuming', 'resumed', 'fallback')),
  state_version     integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  FOREIGN KEY (tenant_id, attendance_id) REFERENCES attendances (tenant_id, id),
  FOREIGN KEY (tenant_id, bot_session_id) REFERENCES bot_sessions (tenant_id, id),
  UNIQUE (tenant_id, attendance_id, idempotency_key),
  UNIQUE (tenant_id, id)
);
-- Uma operação bloqueante por sessão.
CREATE UNIQUE INDEX bot_operations_one_blocking ON bot_operations (bot_session_id)
  WHERE status IN ('pending', 'processing');
CREATE INDEX bot_operations_due ON bot_operations (next_attempt_at) WHERE status = 'pending';
CREATE INDEX bot_operations_leases ON bot_operations (lease_expires_at) WHERE status = 'processing';

-- ---------------------------------------------------------------- humano (Chatwoot)

CREATE TABLE human_sessions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL,
  attendance_id             uuid NOT NULL,
  status                    text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'ended', 'failed')),
  external_account_id       text,
  external_inbox_id         text,
  external_contact_id       text,
  external_source_id        text,
  external_conversation_id  text,
  -- Só mensagens do consumidor com seq maior que isto são encaminhadas ao humano.
  started_after_seq         bigint NOT NULL DEFAULT 0,
  context_sent_at           timestamptz,  -- nota interna com o histórico já enviada ao atendente
  end_reason                text,
  started_at                timestamptz NOT NULL DEFAULT now(),
  ended_at                  timestamptz,
  FOREIGN KEY (tenant_id, attendance_id) REFERENCES attendances (tenant_id, id),
  UNIQUE (tenant_id, id)
);
-- Vários ciclos humanos por protocolo, mas só um vivo por vez.
CREATE UNIQUE INDEX human_sessions_one_live ON human_sessions (tenant_id, attendance_id)
  WHERE status IN ('pending', 'active');
CREATE UNIQUE INDEX human_sessions_external ON human_sessions (external_account_id, external_conversation_id)
  WHERE external_conversation_id IS NOT NULL;

-- Controle de entrega ao humano: evita reenviar a mesma mensagem ao Chatwoot.
CREATE TABLE human_message_deliveries (
  tenant_id            uuid NOT NULL,
  message_id           uuid NOT NULL,
  human_session_id     uuid NOT NULL,
  external_message_id  text,
  claimed_until        timestamptz NOT NULL,
  delivered_at         timestamptz,
  PRIMARY KEY (message_id),
  FOREIGN KEY (tenant_id, human_session_id) REFERENCES human_sessions (tenant_id, id)
);
