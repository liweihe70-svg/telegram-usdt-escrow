CREATE TABLE IF NOT EXISTS production_gas_topups (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES production_payout_requests(id),
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
  fee numeric(78,0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((signed_raw IS NULL)=(tx_hash IS NULL)),
  CHECK(status<>'ABANDONED' OR signed_raw IS NULL)
);
-- One open top-up per payout request; an unsigned plan may be abandoned when the station nonce moved.
CREATE UNIQUE INDEX IF NOT EXISTS production_gas_topup_open ON production_gas_topups(request_id) WHERE status IN ('PREPARED','SIGNED','BROADCAST');
CREATE UNIQUE INDEX IF NOT EXISTS production_gas_topup_nonce ON production_gas_topups(source_address,nonce) WHERE status<>'ABANDONED';
CREATE OR REPLACE FUNCTION production_gas_topup_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Gas top-up cannot be deleted'; END IF;
  IF NEW.id<>OLD.id OR NEW.request_id<>OLD.request_id OR NEW.order_id<>OLD.order_id OR NEW.source_address<>OLD.source_address OR NEW.target_address<>OLD.target_address OR NEW.nonce<>OLD.nonce OR NEW.amount<>OLD.amount OR NEW.plan<>OLD.plan OR NEW.plan_hash<>OLD.plan_hash THEN RAISE EXCEPTION 'Gas top-up plan is immutable'; END IF;
  IF OLD.signed_raw IS NOT NULL AND (NEW.signed_raw IS DISTINCT FROM OLD.signed_raw OR NEW.tx_hash IS DISTINCT FROM OLD.tx_hash) THEN RAISE EXCEPTION 'Signed gas top-up is immutable'; END IF;
  IF OLD.status IN ('CONFIRMED','REVERTED','ABANDONED') AND NEW.status<>OLD.status THEN RAISE EXCEPTION 'Gas top-up is final'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS production_gas_topup_guard ON production_gas_topups;
CREATE TRIGGER production_gas_topup_guard BEFORE UPDATE OR DELETE ON production_gas_topups FOR EACH ROW EXECUTE FUNCTION production_gas_topup_guard();
INSERT INTO production_schema_versions(version) VALUES(7) ON CONFLICT DO NOTHING;
