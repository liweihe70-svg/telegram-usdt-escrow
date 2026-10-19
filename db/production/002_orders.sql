CREATE TABLE IF NOT EXISTS production_orders (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('PRODUCT','P2P')),
  buyer_id bigint NOT NULL CHECK(buyer_id>0),
  seller_id bigint NOT NULL CHECK(seller_id>0),
  principal numeric(78,0) NOT NULL CHECK(principal>0),
  fee numeric(78,0) NOT NULL CHECK(fee>=0),
  expected_deposit numeric(78,0) NOT NULL CHECK(expected_deposit=principal+fee),
  buyer_address text NOT NULL,
  seller_address text NOT NULL,
  deposit_address text UNIQUE,
  description text NOT NULL CHECK(length(description) BETWEEN 1 AND 2000),
  chain_id integer NOT NULL CHECK(chain_id IN (56,97)),
  token_contract text NOT NULL,
  decimals integer NOT NULL CHECK(decimals=18),
  state text NOT NULL DEFAULT 'AWAITING_ACCEPTANCE' CHECK(state IN ('AWAITING_ACCEPTANCE','AWAITING_DEPOSIT','FUNDED','AWAITING_CONFIRMATION','REFUND_REQUESTED','DISPUTED','PENDING_APPROVAL','APPROVED','MANUAL_REVIEW','COMPLETED','REFUNDED','ARBITRATED','CLOSED')),
  revision integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES production_admins,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(buyer_id<>seller_id)
);
CREATE TABLE IF NOT EXISTS production_order_acceptances (
  order_id uuid NOT NULL REFERENCES production_orders,
  user_id bigint NOT NULL,
  PRIMARY KEY(order_id,user_id)
);
CREATE TABLE IF NOT EXISTS production_deposits (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES production_orders,
  chain_id integer NOT NULL,
  token_contract text NOT NULL,
  tx_hash text NOT NULL,
  event_index integer NOT NULL CHECK(event_index>=0),
  amount numeric(78,0) NOT NULL CHECK(amount>0),
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  classification text NOT NULL CHECK(classification IN ('CREDITED','EXCEPTION')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(chain_id,tx_hash,event_index)
);
CREATE TABLE IF NOT EXISTS production_ledger_transactions (
  id uuid PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS production_ledger_entries (
  id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES production_ledger_transactions,
  account text NOT NULL,
  amount numeric(78,0) NOT NULL CHECK(amount<>0)
);
CREATE OR REPLACE FUNCTION production_check_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; total numeric; n integer;
BEGIN
  IF TG_TABLE_NAME='production_ledger_transactions' THEN target:=NEW.id; ELSE target:=NEW.transaction_id; END IF;
  SELECT coalesce(sum(amount),0),count(*) INTO total,n FROM production_ledger_entries WHERE transaction_id=target;
  IF total<>0 OR n<2 THEN RAISE EXCEPTION 'Unbalanced production journal'; END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS production_journal_balanced ON production_ledger_transactions;
CREATE CONSTRAINT TRIGGER production_journal_balanced AFTER INSERT ON production_ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION production_check_ledger();
DROP TRIGGER IF EXISTS production_entries_balanced ON production_ledger_entries;
CREATE CONSTRAINT TRIGGER production_entries_balanced AFTER INSERT ON production_ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION production_check_ledger();
DROP TRIGGER IF EXISTS production_journal_immutable ON production_ledger_transactions;
CREATE TRIGGER production_journal_immutable BEFORE UPDATE OR DELETE ON production_ledger_transactions FOR EACH ROW EXECUTE FUNCTION production_immutable_audit();
DROP TRIGGER IF EXISTS production_entries_immutable ON production_ledger_entries;
CREATE TRIGGER production_entries_immutable BEFORE UPDATE OR DELETE ON production_ledger_entries FOR EACH ROW EXECUTE FUNCTION production_immutable_audit();
CREATE TABLE IF NOT EXISTS production_payout_requests (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES production_orders,
  order_revision integer NOT NULL,
  kind text NOT NULL CHECK(kind IN ('RELEASE','REFUND','ARBITRATION')),
  allocations jsonb NOT NULL,
  fee numeric(78,0) NOT NULL CHECK(fee>=0),
  snapshot_hash text NOT NULL CHECK(length(snapshot_hash)=64),
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED','BLOCKED')),
  approved_by uuid REFERENCES production_admins,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS production_open_payout ON production_payout_requests(order_id) WHERE status IN ('PENDING','APPROVED');
INSERT INTO production_schema_versions(version) VALUES(2) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS production_chain_settings (
  id integer PRIMARY KEY CHECK(id=1),
  chain_id integer NOT NULL DEFAULT 97 CHECK(chain_id IN (56,97)),
  token_contract text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO production_chain_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
