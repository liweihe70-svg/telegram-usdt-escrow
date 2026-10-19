CREATE TABLE IF NOT EXISTS bot_contacts (
  user_id bigint PRIMARY KEY,
  chat_id bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bot_sessions (
  user_id bigint PRIMARY KEY,
  draft jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_notification_receipts (
  job_id uuid NOT NULL REFERENCES outbox_jobs,
  user_id bigint NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id,user_id)
);
CREATE TABLE IF NOT EXISTS bot_processed_updates (
  bot_username text NOT NULL,
  update_id bigint NOT NULL,
  actor bigint NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(bot_username,update_id)
);
CREATE TABLE IF NOT EXISTS bot_admin_proposals (
  id uuid PRIMARY KEY,
  admin_id bigint NOT NULL,
  order_id uuid NOT NULL REFERENCES orders,
  buyer_amount text NOT NULL,
  seller_amount text NOT NULL,
  reason text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE TABLE IF NOT EXISTS bot_dispute_requests (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL,
  order_id uuid NOT NULL REFERENCES orders,
  reason text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE TABLE IF NOT EXISTS bot_evidence_notes (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL,
  order_id uuid NOT NULL REFERENCES orders,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bot_languages (
  user_id bigint PRIMARY KEY,
  language text NOT NULL CHECK(language IN ('zh','en')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
