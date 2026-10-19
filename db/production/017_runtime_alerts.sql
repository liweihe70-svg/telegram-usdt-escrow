-- What the administrator last switched on, so a restart (or a reboot) resumes monitoring and the bot.
CREATE TABLE IF NOT EXISTS production_runtime_state (
  id integer PRIMARY KEY CHECK(id=1),
  monitor_enabled boolean NOT NULL DEFAULT false,
  bot_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO production_runtime_state(id) VALUES(1) ON CONFLICT DO NOTHING;
-- Telegram users who receive administrator alerts in their private chat with the bot.
CREATE TABLE IF NOT EXISTS production_alert_recipients (
  user_id bigint PRIMARY KEY CHECK(user_id>0),
  added_by uuid NOT NULL REFERENCES production_admins(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One row per alert actually delivered, so each event is sent once even across restarts.
CREATE TABLE IF NOT EXISTS production_alert_log (
  source_key text PRIMARY KEY CHECK(length(source_key) BETWEEN 1 AND 200),
  sent_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO production_schema_versions(version) VALUES(17) ON CONFLICT DO NOTHING;
