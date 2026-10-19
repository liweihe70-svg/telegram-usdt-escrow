-- Telegram users allowed to open deals themselves inside an escrow group. Both parties must be listed.
CREATE TABLE IF NOT EXISTS production_allowlist (
  user_id bigint PRIMARY KEY CHECK(user_id>0),
  note text NOT NULL DEFAULT '' CHECK(length(note)<=100),
  added_by uuid NOT NULL REFERENCES production_admins(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- A group's deal before it becomes an order: roles, addresses, terms and both confirmations.
CREATE TABLE IF NOT EXISTS production_group_deals (
  id uuid PRIMARY KEY,
  chat_id bigint NOT NULL CHECK(chat_id<0),
  state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','ORDERED','CANCELLED')),
  buyer_id bigint,
  buyer_address text,
  seller_id bigint,
  seller_address text,
  principal text,
  description text CHECK(description IS NULL OR length(description) BETWEEN 1 AND 2000),
  buyer_confirmed boolean NOT NULL DEFAULT false,
  seller_confirmed boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  order_id uuid UNIQUE REFERENCES production_orders(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(buyer_id IS NULL OR seller_id IS NULL OR buyer_id<>seller_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS production_group_deal_draft ON production_group_deals(chat_id) WHERE state='DRAFT';
INSERT INTO production_schema_versions(version) VALUES(14) ON CONFLICT DO NOTHING;
