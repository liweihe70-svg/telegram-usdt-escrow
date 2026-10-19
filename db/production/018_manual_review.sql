-- A full refund of everything held at an order address (escrow plus irregular deposits), decided by an administrator.
ALTER TABLE production_payout_requests DROP CONSTRAINT IF EXISTS production_payout_requests_kind_check;
ALTER TABLE production_payout_requests ADD CONSTRAINT production_payout_requests_kind_check CHECK(kind IN ('RELEASE','REFUND','ARBITRATION','MANUAL_REFUND'));
-- Every manual-review decision, kept immutably with the balances it was based on.
CREATE TABLE IF NOT EXISTS production_manual_resolutions (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES production_orders(id),
  admin_id uuid NOT NULL REFERENCES production_admins(id),
  action text NOT NULL CHECK(action IN ('CONTINUE','REFUND_ALL','CLOSE')),
  escrow numeric(78,0) NOT NULL CHECK(escrow>=0),
  exception numeric(78,0) NOT NULL CHECK(exception>=0),
  payout_request_id uuid UNIQUE REFERENCES production_payout_requests(id),
  note text NOT NULL CHECK(length(note) BETWEEN 1 AND 1000),
  order_revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS production_manual_resolutions_immutable ON production_manual_resolutions;
CREATE TRIGGER production_manual_resolutions_immutable BEFORE UPDATE OR DELETE ON production_manual_resolutions FOR EACH ROW EXECUTE FUNCTION production_immutable_audit();
INSERT INTO production_schema_versions(version) VALUES(18) ON CONFLICT DO NOTHING;
