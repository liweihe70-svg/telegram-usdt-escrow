-- Arbitrators can review cases and decide disputes; nothing else.
ALTER TABLE production_admins DROP CONSTRAINT IF EXISTS production_admins_role_check;
ALTER TABLE production_admins ADD CONSTRAINT production_admins_role_check CHECK(role IN ('OWNER','APPROVER','OPERATOR','ARBITRATOR'));
-- Automatic payouts: off until the owner switches them on. The signing key itself is never stored.
CREATE TABLE IF NOT EXISTS production_automation (
  id integer PRIMARY KEY CHECK(id=1),
  enabled boolean NOT NULL DEFAULT false,
  paused_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO production_automation(id) VALUES(1) ON CONFLICT DO NOTHING;
INSERT INTO production_schema_versions(version) VALUES(22) ON CONFLICT DO NOTHING;
