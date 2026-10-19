-- The wallet root may belong to either BNB Chain network; each instance only ever configures its own.
ALTER TABLE production_wallet_root DROP CONSTRAINT IF EXISTS production_wallet_root_chain_id_check;
ALTER TABLE production_wallet_root ADD CONSTRAINT production_wallet_root_chain_id_check CHECK(chain_id IN (56,97));
INSERT INTO production_schema_versions(version) VALUES(13) ON CONFLICT DO NOTHING;
