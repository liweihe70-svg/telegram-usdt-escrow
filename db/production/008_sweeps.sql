CREATE TABLE IF NOT EXISTS production_fee_sweeps (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES production_orders(id),
  source_address text NOT NULL,
  target_address text NOT NULL,
  nonce bigint NOT NULL CHECK(nonce>=0),
  amount numeric(78,0) NOT NULL CHECK(amount>0),
  plan jsonb NOT NULL,
  plan_hash text NOT NULL,
  status text NOT NULL DEFAULT 'PREPARED' CHECK(status IN ('PREPARED','SIGNED','BROADCAST','CONFIRMED','REVERTED','ABANDONED')),
  signed_raw text,
  tx_hash text UNIQUE,
  block_number bigint,
  block_hash text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((signed_raw IS NULL)=(tx_hash IS NULL)),
  CHECK(status<>'ABANDONED' OR signed_raw IS NULL)
);
-- One open or confirmed sweep per order; an unsigned plan may be abandoned when the order address nonce moved.
CREATE UNIQUE INDEX IF NOT EXISTS production_fee_sweep_open ON production_fee_sweeps(order_id) WHERE status IN ('PREPARED','SIGNED','BROADCAST','CONFIRMED');
CREATE UNIQUE INDEX IF NOT EXISTS production_fee_sweep_nonce ON production_fee_sweeps(source_address,nonce) WHERE status<>'ABANDONED';
CREATE OR REPLACE FUNCTION production_fee_sweep_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Fee sweep cannot be deleted'; END IF;
  IF NEW.id<>OLD.id OR NEW.order_id<>OLD.order_id OR NEW.source_address<>OLD.source_address OR NEW.target_address<>OLD.target_address OR NEW.nonce<>OLD.nonce OR NEW.amount<>OLD.amount OR NEW.plan<>OLD.plan OR NEW.plan_hash<>OLD.plan_hash THEN RAISE EXCEPTION 'Fee sweep plan is immutable'; END IF;
  IF OLD.signed_raw IS NOT NULL AND (NEW.signed_raw IS DISTINCT FROM OLD.signed_raw OR NEW.tx_hash IS DISTINCT FROM OLD.tx_hash) THEN RAISE EXCEPTION 'Signed fee sweep is immutable'; END IF;
  IF OLD.status IN ('CONFIRMED','REVERTED','ABANDONED') AND NEW.status<>OLD.status THEN RAISE EXCEPTION 'Fee sweep is final'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS production_fee_sweep_guard ON production_fee_sweeps;
CREATE TRIGGER production_fee_sweep_guard BEFORE UPDATE OR DELETE ON production_fee_sweeps FOR EACH ROW EXECUTE FUNCTION production_fee_sweep_guard();
INSERT INTO production_schema_versions(version) VALUES(8) ON CONFLICT DO NOTHING;
