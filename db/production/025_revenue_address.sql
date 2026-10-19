-- Optional external wallet that platform fees are sent to directly (instead of the treasury child).
CREATE TABLE IF NOT EXISTS production_revenue_address (
  id integer PRIMARY KEY CHECK(id=1),
  address text CHECK(address IS NULL OR address ~ '^0x[0-9a-fA-F]{40}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO production_revenue_address(id) VALUES(1) ON CONFLICT DO NOTHING;
INSERT INTO production_schema_versions(version) VALUES(25) ON CONFLICT DO NOTHING;
