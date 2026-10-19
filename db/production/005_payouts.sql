CREATE TABLE IF NOT EXISTS production_payout_transactions (
  request_id uuid PRIMARY KEY REFERENCES production_payout_requests(id),
  order_id uuid NOT NULL REFERENCES production_orders(id),
  order_revision integer NOT NULL,
  source_address text NOT NULL,
  nonce bigint NOT NULL CHECK(nonce>=0),
  plan jsonb NOT NULL,
  plan_hash text NOT NULL,
  status text NOT NULL DEFAULT 'PREPARED' CHECK(status IN ('PREPARED','SIGNED','BROADCAST','CONFIRMED','REVERTED','BLOCKED')),
  signed_raw text,
  tx_hash text UNIQUE,
  block_number bigint,
  block_hash text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_address,nonce),
  CHECK((signed_raw IS NULL)=(tx_hash IS NULL))
);
CREATE OR REPLACE FUNCTION production_payout_tx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Payout transaction cannot be deleted'; END IF;
  IF NEW.request_id<>OLD.request_id OR NEW.order_id<>OLD.order_id OR NEW.order_revision<>OLD.order_revision OR NEW.source_address<>OLD.source_address OR NEW.nonce<>OLD.nonce OR NEW.plan<>OLD.plan OR NEW.plan_hash<>OLD.plan_hash THEN RAISE EXCEPTION 'Payout plan is immutable'; END IF;
  IF OLD.signed_raw IS NOT NULL AND (NEW.signed_raw IS DISTINCT FROM OLD.signed_raw OR NEW.tx_hash IS DISTINCT FROM OLD.tx_hash) THEN RAISE EXCEPTION 'Signed payout is immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS production_payout_tx_guard ON production_payout_transactions;
CREATE TRIGGER production_payout_tx_guard BEFORE UPDATE OR DELETE ON production_payout_transactions FOR EACH ROW EXECUTE FUNCTION production_payout_tx_guard();
ALTER TABLE production_payout_requests DROP CONSTRAINT IF EXISTS production_payout_requests_status_check;
ALTER TABLE production_payout_requests ADD CONSTRAINT production_payout_requests_status_check CHECK(status IN ('PENDING','APPROVED','REJECTED','BLOCKED','PAID'));
INSERT INTO production_schema_versions(version) VALUES(5) ON CONFLICT DO NOTHING;
