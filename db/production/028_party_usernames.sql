-- Telegram usernames shown on role declarations and the deal card (display only; identity stays the numeric ID).
ALTER TABLE production_group_deals ADD COLUMN IF NOT EXISTS buyer_username text;
ALTER TABLE production_group_deals ADD COLUMN IF NOT EXISTS seller_username text;
INSERT INTO production_schema_versions(version) VALUES(28) ON CONFLICT DO NOTHING;
