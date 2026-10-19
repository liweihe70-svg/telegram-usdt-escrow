CREATE TABLE IF NOT EXISTS production_contacts (
  user_id bigint PRIMARY KEY CHECK(user_id>0),
  chat_id bigint NOT NULL CHECK(chat_id=user_id),
  language text NOT NULL DEFAULT 'zh' CHECK(language IN ('zh','en')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS production_telegram_updates (
  bot_username text NOT NULL,
  update_id bigint NOT NULL CHECK(update_id>=0),
  actor bigint NOT NULL,
  state text NOT NULL DEFAULT 'CLAIMED' CHECK(state IN ('CLAIMED','DONE')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(bot_username,update_id)
);
CREATE TABLE IF NOT EXISTS production_party_actions (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES production_orders,
  user_id bigint NOT NULL,
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS production_party_actions_immutable ON production_party_actions;
CREATE TRIGGER production_party_actions_immutable BEFORE UPDATE OR DELETE ON production_party_actions FOR EACH ROW EXECUTE FUNCTION production_immutable_audit();
CREATE TABLE IF NOT EXISTS production_notifications (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES production_orders,
  event text NOT NULL,
  order_revision integer NOT NULL,
  delivered_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS production_notification_receipts (
  job_id uuid NOT NULL REFERENCES production_notifications,
  user_id bigint NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id,user_id)
);
ALTER TABLE production_notifications ADD COLUMN IF NOT EXISTS order_revision integer;
UPDATE production_notifications n SET order_revision=o.revision FROM production_orders o WHERE n.order_id=o.id AND n.order_revision IS NULL;
ALTER TABLE production_notifications ALTER COLUMN order_revision SET NOT NULL;
INSERT INTO production_schema_versions(version) VALUES(3) ON CONFLICT DO NOTHING;
