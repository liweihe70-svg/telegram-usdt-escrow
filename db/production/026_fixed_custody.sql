-- Fixed custody: group deals may show the owner's own wallet as their escrow address (manual payouts).
ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS fixed_custody boolean NOT NULL DEFAULT false;
-- Platform-generated deposit addresses stay unique; the fixed address is shared by its orders.
ALTER TABLE production_orders DROP CONSTRAINT IF EXISTS production_orders_deposit_address_key;
CREATE UNIQUE INDEX IF NOT EXISTS production_orders_deposit_address_unique ON production_orders(deposit_address) WHERE NOT fixed_custody;
CREATE TABLE IF NOT EXISTS production_fixed_custody (
  id integer PRIMARY KEY CHECK(id=1),
  address text CHECK(address IS NULL OR address ~ '^0x[0-9a-fA-F]{40}$'),
  next_block bigint,
  checkpoint_number bigint,
  checkpoint_hash text,
  scanned_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO production_fixed_custody(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS production_custody_transfers (
  id uuid PRIMARY KEY,
  chain_id integer NOT NULL,
  tx_hash text NOT NULL,
  event_index integer NOT NULL,
  direction text NOT NULL CHECK(direction IN ('IN','OUT')),
  custody_address text NOT NULL,
  counterparty text NOT NULL,
  amount numeric(78,0) NOT NULL CHECK(amount>0),
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  status text NOT NULL CHECK(status IN ('NEW','CREDITED','UNCLAIMED','CLAIM_PENDING','IGNORED','PAID','UNMATCHED')),
  order_id uuid REFERENCES production_orders(id),
  request_id uuid REFERENCES production_payout_requests(id),
  claimed_by bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(chain_id,tx_hash,event_index)
);
INSERT INTO production_schema_versions(version) VALUES(26) ON CONFLICT DO NOTHING;
