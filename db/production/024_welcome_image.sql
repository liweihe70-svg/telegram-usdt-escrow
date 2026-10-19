-- Optional picture uploaded in the panel for the /start welcome card (takes precedence over the media link).
CREATE TABLE IF NOT EXISTS production_welcome_image (
  id integer PRIMARY KEY CHECK(id=1),
  mime text NOT NULL CHECK(mime IN ('image/png','image/jpeg')),
  bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 5242880),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO production_schema_versions(version) VALUES(24) ON CONFLICT DO NOTHING;
