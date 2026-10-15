-- Fundação persistente (CLAUDE.md seções 9, 10 e 15).
-- Toda tabela de negócio carrega tenant_id; FKs compostas (tenant_id, id)
-- impedem associações entre tenants distintos.

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_settings (
  tenant_id                          uuid PRIMARY KEY REFERENCES tenants (id),
  timezone                           text NOT NULL DEFAULT 'America/Sao_Paulo',
  -- Decisão fechada (seção 6): 60 min por padrão, configurável por tenant.
  post_service_inactivity_minutes    integer NOT NULL DEFAULT 60 CHECK (post_service_inactivity_minutes > 0),
  -- Prazo geral de inatividade (distinto do pós-atendimento). Valor ainda pendente (seção 19.8).
  general_inactivity_minutes         integer NOT NULL DEFAULT 1440 CHECK (general_inactivity_minutes > 0),
  access_link_ttl_minutes            integer NOT NULL DEFAULT 1440 CHECK (access_link_ttl_minutes > 0),
  updated_at                         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE applications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  slug          text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  name          text NOT NULL,
  channel       text NOT NULL CHECK (channel IN ('public_link', 'whatsapp')),
  -- anonymous: o chat abre sem OTP; otp: exige OTP (canal de envio pendente, seção 19.3).
  auth_mode     text NOT NULL DEFAULT 'anonymous' CHECK (auth_mode IN ('anonymous', 'otp')),
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug),
  UNIQUE (tenant_id, id)
);

CREATE TABLE consumers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  name        text,
  provisional boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- Identidades/contatos externos. value_hash permite localizar sem expor o dado
-- (CPF/CNPJ nunca vai em link/token; aqui só hash, e só quando necessário).
CREATE TABLE consumer_identities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  consumer_id     uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('whatsapp', 'email', 'phone', 'external_user', 'cpf_cnpj', 'visitor')),
  value           text,
  value_hash      text NOT NULL,
  verified        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, consumer_id) REFERENCES consumers (tenant_id, id),
  UNIQUE (tenant_id, kind, value_hash)
);

CREATE TABLE attendance_counters (
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  year           integer NOT NULL,
  next_sequence  integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, year)
);

CREATE TABLE attendances (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id),
  application_id        uuid NOT NULL,
  consumer_id           uuid NOT NULL,
  protocol_year         integer NOT NULL,
  protocol_sequence     integer NOT NULL,
  protocol_number       text NOT NULL,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'expired')),
  phase                 text NOT NULL DEFAULT 'bot' CHECK (phase IN
                          ('bot', 'awaiting_business_hours', 'handoff_pending', 'human', 'returning_to_bot', 'post_service')),
  inactivity_deadline_at timestamptz,
  closed_reason         text,
  closed_by             text CHECK (closed_by IN ('consumer', 'bot', 'agent', 'system')),
  state_version         integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz,
  FOREIGN KEY (tenant_id, application_id) REFERENCES applications (tenant_id, id),
  FOREIGN KEY (tenant_id, consumer_id) REFERENCES consumers (tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, protocol_year, protocol_sequence),
  UNIQUE (tenant_id, protocol_number),
  CHECK (protocol_number = protocol_year || '-' || lpad(protocol_sequence::text, 6, '0')),
  CHECK ((status = 'open') = (closed_at IS NULL))
);

-- Um único atendimento aberto por consumidor/aplicação (reuso do mesmo protocolo).
CREATE UNIQUE INDEX attendances_one_open_per_consumer
  ON attendances (tenant_id, application_id, consumer_id) WHERE status = 'open';
CREATE INDEX attendances_deadline ON attendances (inactivity_deadline_at) WHERE status = 'open' AND inactivity_deadline_at IS NOT NULL;

-- closed/expired são terminais (seção 9).
CREATE FUNCTION attendances_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'attendance % is terminal (%)', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER attendances_guard BEFORE UPDATE ON attendances
  FOR EACH ROW EXECUTE FUNCTION attendances_guard();

CREATE TABLE conversations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  attendance_id  uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, attendance_id) REFERENCES attendances (tenant_id, id),
  UNIQUE (tenant_id, attendance_id),  -- 1:1 no MVP
  UNIQUE (tenant_id, id)
);

CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq              bigint GENERATED ALWAYS AS IDENTITY,  -- ordem total; cursor de sincronização
  tenant_id        uuid NOT NULL,
  attendance_id    uuid NOT NULL,
  conversation_id  uuid NOT NULL,
  sender_type      text NOT NULL CHECK (sender_type IN ('consumer', 'bot', 'agent', 'system')),
  content          jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object' AND content ? 'type'),
  external_ids     jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, attendance_id) REFERENCES attendances (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
);
CREATE INDEX messages_by_attendance ON messages (tenant_id, attendance_id, seq);
CREATE UNIQUE INDEX messages_idempotency ON messages (tenant_id, attendance_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Rede de segurança: protocolo encerrado é somente leitura.
CREATE FUNCTION messages_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM attendances WHERE tenant_id = NEW.tenant_id AND id = NEW.attendance_id;
  IF s <> 'open' THEN
    RAISE EXCEPTION 'attendance % is not open (%)', NEW.attendance_id, s USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER messages_guard BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_guard();
CREATE FUNCTION messages_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'messages are immutable' USING ERRCODE = 'check_violation'; END $$;
CREATE TRIGGER messages_immutable BEFORE UPDATE OR DELETE ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_immutable();

-- Somente hashes: o token em claro só existe no link entregue ao consumidor.
CREATE TABLE attendance_access_tokens (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  attendance_id  uuid NOT NULL,
  token_hash     text NOT NULL UNIQUE,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  last_used_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, attendance_id) REFERENCES attendances (tenant_id, id)
);
CREATE INDEX access_tokens_by_attendance ON attendance_access_tokens (tenant_id, attendance_id);

CREATE TABLE attendance_otp_challenges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  token_id      uuid NOT NULL REFERENCES attendance_access_tokens (id),
  code_hash     text NOT NULL,
  channel       text NOT NULL,
  expires_at    timestamptz NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 5,
  used_at       timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_by_token ON attendance_otp_challenges (token_id, created_at DESC);
