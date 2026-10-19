-- Shared display language of a group, from the moment the bot joins; the order binding follows it.
CREATE TABLE IF NOT EXISTS production_group_settings (
  chat_id bigint PRIMARY KEY CHECK(chat_id<0),
  language text NOT NULL DEFAULT 'zh' CHECK(language IN ('zh','en')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO production_schema_versions(version) VALUES(16) ON CONFLICT DO NOTHING;
