CREATE TABLE IF NOT EXISTS production_schema_versions (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS production_admins (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-zA-Z0-9_]{3,32}$'),
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('OWNER','APPROVER','OPERATOR')),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS production_sessions (
  token_hash text PRIMARY KEY CHECK (length(token_hash)=64),
  csrf_hash text NOT NULL CHECK (length(csrf_hash)=64),
  admin_id uuid NOT NULL REFERENCES production_admins,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS production_auth_throttle (
  identity_hash text PRIMARY KEY,
  failed_count integer NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL DEFAULT now(),
  blocked_until timestamptz
);
CREATE TABLE IF NOT EXISTS production_admin_audit (
  id uuid PRIMARY KEY,
  actor_id uuid REFERENCES production_admins,
  action text NOT NULL,
  target_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION production_immutable_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Production audit is immutable'; END;
$$;
DROP TRIGGER IF EXISTS production_audit_immutable ON production_admin_audit;
CREATE TRIGGER production_audit_immutable BEFORE UPDATE OR DELETE ON production_admin_audit
  FOR EACH ROW EXECUTE FUNCTION production_immutable_audit();
INSERT INTO production_schema_versions(version) VALUES(1) ON CONFLICT DO NOTHING;
