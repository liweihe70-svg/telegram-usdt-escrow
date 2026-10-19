CREATE TABLE IF NOT EXISTS production_wallet_root (
  id integer PRIMARY KEY CHECK(id=1),
  root_id text NOT NULL UNIQUE,
  xpub text NOT NULL,
  chain_id integer NOT NULL CHECK(chain_id=97),
  token_contract text NOT NULL,
  next_index bigint NOT NULL DEFAULT 0 CHECK(next_index BETWEEN 0 AND 2147483648),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS production_wallet_allocations (
  order_id uuid PRIMARY KEY REFERENCES production_orders(id),
  root_id text NOT NULL REFERENCES production_wallet_root(root_id),
  child_index bigint NOT NULL CHECK(child_index BETWEEN 0 AND 2147483647),
  address text NOT NULL UNIQUE,
  start_block bigint NOT NULL CHECK(start_block>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(root_id,child_index)
);
CREATE TABLE IF NOT EXISTS production_wallet_cursors (
  order_id uuid PRIMARY KEY REFERENCES production_wallet_allocations(order_id),
  next_block bigint NOT NULL CHECK(next_block>=0),
  checkpoint_number bigint,
  checkpoint_hash text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((checkpoint_number IS NULL)=(checkpoint_hash IS NULL))
);
CREATE OR REPLACE FUNCTION production_wallet_root_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Wallet root cannot be deleted'; END IF;
  IF NEW.root_id<>OLD.root_id OR NEW.xpub<>OLD.xpub OR NEW.chain_id<>OLD.chain_id OR NEW.token_contract<>OLD.token_contract OR NEW.next_index<OLD.next_index THEN
    RAISE EXCEPTION 'Wallet root is immutable and indices cannot rewind';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS production_wallet_root_guard ON production_wallet_root;
CREATE TRIGGER production_wallet_root_guard BEFORE UPDATE OR DELETE ON production_wallet_root FOR EACH ROW EXECUTE FUNCTION production_wallet_root_guard();
CREATE OR REPLACE FUNCTION production_wallet_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Wallet allocation is immutable'; END $$;
DROP TRIGGER IF EXISTS production_wallet_allocation_guard ON production_wallet_allocations;
CREATE TRIGGER production_wallet_allocation_guard BEFORE UPDATE OR DELETE ON production_wallet_allocations FOR EACH ROW EXECUTE FUNCTION production_wallet_allocation_guard();
INSERT INTO production_schema_versions(version) VALUES(4) ON CONFLICT DO NOTHING;
