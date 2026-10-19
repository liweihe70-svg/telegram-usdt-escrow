-- Who started a refund: both parties (request + agreement), the seller alone, or the delivery deadline.
ALTER TABLE production_cases ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'PARTIES';
ALTER TABLE production_cases DROP CONSTRAINT IF EXISTS production_cases_origin_check;
ALTER TABLE production_cases ADD CONSTRAINT production_cases_origin_check CHECK(origin IN ('PARTIES','SELLER','TIMEOUT'));
INSERT INTO production_schema_versions(version) VALUES(19) ON CONFLICT DO NOTHING;
