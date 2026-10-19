-- An order is bound to at most one group, ever; a group shows at most one live order at a time.
CREATE TABLE IF NOT EXISTS production_group_bindings (
  order_id uuid PRIMARY KEY REFERENCES production_orders(id),
  chat_id bigint NOT NULL CHECK(chat_id<0),
  owner_id bigint NOT NULL CHECK(owner_id>0),
  state text NOT NULL CHECK(state IN ('PENDING','ACTIVE','PAUSED','REVOKED')),
  language text NOT NULL DEFAULT 'zh' CHECK(language IN ('zh','en')),
  pause_reason text,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS production_group_live_chat ON production_group_bindings(chat_id) WHERE state<>'REVOKED';
CREATE TABLE IF NOT EXISTS production_group_consents (
  order_id uuid NOT NULL REFERENCES production_group_bindings(order_id),
  user_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(order_id,user_id)
);
CREATE TABLE IF NOT EXISTS production_group_receipts (
  job_id uuid NOT NULL REFERENCES production_notifications(id),
  chat_id bigint NOT NULL,
  sent_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id,chat_id)
);
INSERT INTO production_schema_versions(version) VALUES(12) ON CONFLICT DO NOTHING;
