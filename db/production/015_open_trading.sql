-- Whether anyone (not only the allowlist) may open group deals, and how many unfinished orders one person may hold.
CREATE TABLE IF NOT EXISTS production_trade_settings (
  id integer PRIMARY KEY CHECK(id=1),
  open_trading boolean NOT NULL DEFAULT false,
  max_open_orders_per_user integer NOT NULL DEFAULT 2 CHECK(max_open_orders_per_user BETWEEN 1 AND 20),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO production_trade_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
INSERT INTO production_schema_versions(version) VALUES(15) ON CONFLICT DO NOTHING;
