ALTER TABLE bot_processed_updates ADD COLUMN IF NOT EXISTS chat_id bigint;
CREATE TABLE IF NOT EXISTS bot_group_bindings (
 order_id uuid PRIMARY KEY REFERENCES orders,
 chat_id bigint NOT NULL,
 owner_id bigint NOT NULL,
 state text NOT NULL CHECK(state IN ('PENDING','ACTIVE','PAUSED','REVOKED')),
 language text NOT NULL CHECK(language IN ('zh','en')),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes'
);
CREATE UNIQUE INDEX IF NOT EXISTS bot_group_live_chat ON bot_group_bindings(chat_id) WHERE state<>'REVOKED';
CREATE TABLE IF NOT EXISTS bot_group_consents (
 order_id uuid NOT NULL REFERENCES bot_group_bindings,
 user_id bigint NOT NULL,
 PRIMARY KEY(order_id,user_id)
);
CREATE TABLE IF NOT EXISTS bot_group_notification_receipts (
 job_id uuid NOT NULL REFERENCES outbox_jobs,
 chat_id bigint NOT NULL,
 sent_at timestamptz,
 attempts integer NOT NULL DEFAULT 0,
 retry_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(job_id,chat_id)
);
