-- Same-nonce, higher-price replacements of a broadcast payout. Every attempt pays the same recipient
-- and amount; the shared nonce lets at most one of them, or the original, ever be mined.
CREATE TABLE IF NOT EXISTS production_payout_replacements (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES production_payout_transactions(request_id),
  attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 5),
  nonce bigint NOT NULL CHECK(nonce>=0),
  gas_price numeric(78,0) NOT NULL CHECK(gas_price>0),
  plan jsonb NOT NULL,
  plan_hash text NOT NULL,
  status text NOT NULL DEFAULT 'PREPARED' CHECK(status IN ('PREPARED','SIGNED','BROADCAST','CONFIRMED','REVERTED','SUPERSEDED','ABANDONED')),
  signed_raw text,
  tx_hash text UNIQUE,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(request_id,attempt),
  CHECK((signed_raw IS NULL)=(tx_hash IS NULL)),
  CHECK(status<>'ABANDONED' OR signed_raw IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS production_payout_replacement_unsent ON production_payout_replacements(request_id) WHERE status IN ('PREPARED','SIGNED');
CREATE OR REPLACE FUNCTION production_payout_replacement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Payout replacement cannot be deleted'; END IF;
  IF NEW.id<>OLD.id OR NEW.request_id<>OLD.request_id OR NEW.attempt<>OLD.attempt OR NEW.nonce<>OLD.nonce OR NEW.gas_price<>OLD.gas_price OR NEW.plan<>OLD.plan OR NEW.plan_hash<>OLD.plan_hash THEN RAISE EXCEPTION 'Payout replacement plan is immutable'; END IF;
  IF OLD.signed_raw IS NOT NULL AND (NEW.signed_raw IS DISTINCT FROM OLD.signed_raw OR NEW.tx_hash IS DISTINCT FROM OLD.tx_hash) THEN RAISE EXCEPTION 'Signed payout replacement is immutable'; END IF;
  IF OLD.status IN ('CONFIRMED','REVERTED','SUPERSEDED','ABANDONED') AND NEW.status<>OLD.status THEN RAISE EXCEPTION 'Payout replacement is final'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS production_payout_replacement_guard ON production_payout_replacements;
CREATE TRIGGER production_payout_replacement_guard BEFORE UPDATE OR DELETE ON production_payout_replacements FOR EACH ROW EXECUTE FUNCTION production_payout_replacement_guard();
-- Which signed transaction (original or a replacement) was finalized; the original tx_hash stays unchanged.
ALTER TABLE production_payout_transactions ADD COLUMN IF NOT EXISTS confirmed_tx_hash text;
INSERT INTO production_schema_versions(version) VALUES(9) ON CONFLICT DO NOTHING;
