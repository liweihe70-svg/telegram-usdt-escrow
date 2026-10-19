-- Platform options editable in the admin panel. NULL means "use the .env value or the built-in default".
CREATE TABLE IF NOT EXISTS production_platform_settings (
  id integer PRIMARY KEY CHECK(id=1),
  brand text CHECK(brand IS NULL OR length(brand) BETWEEN 1 AND 40),
  support_username text CHECK(support_username IS NULL OR support_username='' OR support_username ~ '^[a-zA-Z0-9_]{5,32}$'),
  default_language text CHECK(default_language IS NULL OR default_language IN ('zh','en')),
  max_order text CHECK(max_order IS NULL OR max_order='none' OR max_order ~ '^[0-9]{1,12}(\.[0-9]{1,6})?$'),
  max_custody text CHECK(max_custody IS NULL OR max_custody='none' OR max_custody ~ '^[0-9]{1,12}(\.[0-9]{1,6})?$'),
  fee_min text CHECK(fee_min IS NULL OR fee_min ~ '^[0-9]{1,9}(\.[0-9]{1,6})?$'),
  fee_bps integer CHECK(fee_bps IS NULL OR fee_bps BETWEEN 0 AND 10000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO production_platform_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
INSERT INTO production_schema_versions(version) VALUES(20) ON CONFLICT DO NOTHING;
