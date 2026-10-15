-- Variáveis estáticas (não secretas) pré-preenchidas no startChat, definidas pela equipe
-- interna junto ao fluxo publicado (ex.: a ação que o bloco HTTP do fluxo solicita).
-- O navegador nunca escolhe nem altera estes valores (seção 8).
ALTER TABLE bot_flows ADD COLUMN prefilled_variables jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(prefilled_variables) = 'object');
