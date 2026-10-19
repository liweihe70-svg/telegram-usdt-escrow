CREATE TABLE IF NOT EXISTS production_cases (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES production_orders(id),
  kind text NOT NULL CHECK(kind IN ('REFUND','DISPUTE')),
  status text NOT NULL CHECK(status IN ('OPEN','DISPUTED','AGREED','RESOLVED')),
  requested_user bigint NOT NULL,
  responded_user bigint,
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
  outcome text CHECK(outcome IN ('BUYER','SELLER')),
  resolved_by uuid REFERENCES production_admins(id),
  resolution_note text,
  payout_request_id uuid UNIQUE REFERENCES production_payout_requests(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS production_active_case ON production_cases(order_id) WHERE status IN ('OPEN','DISPUTED');
CREATE TABLE IF NOT EXISTS production_case_events (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES production_cases(id),
  user_id bigint,
  admin_id uuid REFERENCES production_admins(id),
  action text NOT NULL,
  message text NOT NULL CHECK(length(message) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((user_id IS NULL)<>(admin_id IS NULL))
);
DROP TRIGGER IF EXISTS production_case_event_immutable ON production_case_events;
CREATE TRIGGER production_case_event_immutable BEFORE UPDATE OR DELETE ON production_case_events FOR EACH ROW EXECUTE FUNCTION production_immutable_audit();
ALTER TABLE production_payout_transactions DROP CONSTRAINT IF EXISTS production_payout_transactions_source_address_nonce_key;
CREATE UNIQUE INDEX IF NOT EXISTS production_reserved_payout_nonce ON production_payout_transactions(source_address,nonce)
  WHERE signed_raw IS NOT NULL OR status IN ('PREPARED','SIGNED','BROADCAST','CONFIRMED','REVERTED');
INSERT INTO production_schema_versions(version) VALUES(6) ON CONFLICT DO NOTHING;
