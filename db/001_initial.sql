CREATE TABLE users (
  telegram_id bigint PRIMARY KEY CHECK (telegram_id > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE orders (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('PRODUCT', 'P2P')),
  buyer_id bigint NOT NULL REFERENCES users,
  seller_id bigint NOT NULL REFERENCES users,
  principal bigint NOT NULL CHECK (principal > 0),
  fee bigint NOT NULL CHECK (fee >= 0),
  expected_deposit bigint NOT NULL CHECK (expected_deposit = principal + fee),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  buyer_address text NOT NULL,
  seller_address text NOT NULL,
  deposit_address text NOT NULL UNIQUE,
  terms_version integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'AWAITING_ACCEPTANCE' CHECK (state IN (
    'AWAITING_ACCEPTANCE','AWAITING_DEPOSIT','FUNDED','AWAITING_CONFIRMATION',
    'REFUND_REQUESTED','DISPUTED','SETTLING','COMPLETED','REFUNDED','ARBITRATED','CLOSED')),
  resume_state text,
  refund_requester bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (buyer_id <> seller_id)
);
CREATE TABLE order_acceptances (
  order_id uuid NOT NULL REFERENCES orders,
  user_id bigint NOT NULL REFERENCES users,
  terms_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, user_id, terms_version)
);
CREATE TABLE deposits (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders,
  network text NOT NULL,
  tx_hash text NOT NULL,
  event_index integer NOT NULL CHECK (event_index >= 0),
  amount bigint NOT NULL CHECK (amount > 0),
  classification text NOT NULL CHECK (classification IN ('CREDITED','EXCEPTION')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (network, tx_hash, event_index)
);
CREATE TABLE settlements (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES orders,
  kind text NOT NULL CHECK (kind IN ('RELEASE','REFUND','ARBITRATION')),
  fee bigint NOT NULL CHECK (fee >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payouts (
  id uuid PRIMARY KEY,
  settlement_id uuid NOT NULL REFERENCES settlements,
  recipient text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','BROADCAST','CONFIRMED')),
  tx_hash text UNIQUE,
  signed_payload text,
  CHECK ((status = 'QUEUED' AND tx_hash IS NULL AND signed_payload IS NULL)
    OR (status <> 'QUEUED' AND tx_hash IS NOT NULL AND signed_payload IS NOT NULL))
);
CREATE TABLE ledger_transactions (
  id uuid PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES ledger_transactions,
  account text NOT NULL,
  amount bigint NOT NULL CHECK (amount <> 0)
);
CREATE FUNCTION check_balanced_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; total numeric; n integer;
BEGIN
  IF TG_TABLE_NAME = 'ledger_transactions' THEN
    target := NEW.id;
  ELSE
    target := NEW.transaction_id;
  END IF;
  SELECT coalesce(sum(amount),0), count(*) INTO total,n FROM ledger_entries WHERE transaction_id = target;
  IF total <> 0 OR n < 2 THEN RAISE EXCEPTION 'Unbalanced ledger transaction'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ledger_header_balanced AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_balanced_ledger();
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_balanced_ledger();
CREATE FUNCTION immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Append-only record cannot be modified'; END;
$$;
CREATE TRIGGER immutable_ledger_entries BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_ledger_transactions BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TABLE disputes (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES orders,
  opened_by bigint NOT NULL REFERENCES users,
  reason text NOT NULL,
  decision text,
  decided_by bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders,
  actor text NOT NULL,
  event text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TABLE outbox_jobs (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders,
  event text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
