-- Group deals without a preset amount: the order amount follows what actually arrives in escrow.
ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS open_amount boolean NOT NULL DEFAULT false;
ALTER TABLE production_orders DROP CONSTRAINT IF EXISTS production_orders_principal_check;
ALTER TABLE production_orders ADD CONSTRAINT production_orders_principal_check CHECK(principal>0 OR open_amount);
INSERT INTO production_schema_versions(version) VALUES(23) ON CONFLICT DO NOTHING;
