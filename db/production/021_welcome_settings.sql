-- Optional welcome media and channel links for the /start card. Added columns only; existing settings stay as they are.
-- Length is checked separately: PostgreSQL regular expressions cannot repeat more than 255 times.
ALTER TABLE production_platform_settings ADD COLUMN IF NOT EXISTS welcome_media text;
ALTER TABLE production_platform_settings ADD COLUMN IF NOT EXISTS updates_url text;
ALTER TABLE production_platform_settings ADD COLUMN IF NOT EXISTS vouches_url text;
ALTER TABLE production_platform_settings DROP CONSTRAINT IF EXISTS production_platform_settings_welcome_media_check;
ALTER TABLE production_platform_settings DROP CONSTRAINT IF EXISTS production_platform_settings_updates_url_check;
ALTER TABLE production_platform_settings DROP CONSTRAINT IF EXISTS production_platform_settings_vouches_url_check;
ALTER TABLE production_platform_settings ADD CONSTRAINT production_platform_settings_welcome_media_check CHECK(welcome_media IS NULL OR welcome_media='' OR (welcome_media ~ '^https://[^\s"<>]+$' AND length(welcome_media)<=508));
ALTER TABLE production_platform_settings ADD CONSTRAINT production_platform_settings_updates_url_check CHECK(updates_url IS NULL OR updates_url='' OR (updates_url ~ '^https://[^\s"<>]+$' AND length(updates_url)<=308));
ALTER TABLE production_platform_settings ADD CONSTRAINT production_platform_settings_vouches_url_check CHECK(vouches_url IS NULL OR vouches_url='' OR (vouches_url ~ '^https://[^\s"<>]+$' AND length(vouches_url)<=308));
INSERT INTO production_schema_versions(version) VALUES(21) ON CONFLICT DO NOTHING;
