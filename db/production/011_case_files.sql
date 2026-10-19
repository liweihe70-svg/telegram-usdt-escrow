CREATE TABLE IF NOT EXISTS production_case_files (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES production_cases(id),
  order_id uuid NOT NULL REFERENCES production_orders(id),
  user_id bigint NOT NULL CHECK(user_id>0),
  filename text NOT NULL CHECK(length(filename) BETWEEN 1 AND 120),
  mime text NOT NULL CHECK(mime IN ('image/jpeg','image/png','application/pdf','text/plain')),
  note text NOT NULL DEFAULT '' CHECK(length(note)<=1000),
  bytes bytea NOT NULL,
  size integer NOT NULL CHECK(size BETWEEN 1 AND 5242880 AND size=length(bytes)),
  sha256 text NOT NULL CHECK(length(sha256)=64),
  telegram_unique_id text NOT NULL CHECK(length(telegram_unique_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A replayed Telegram update for the same file never stores a second copy.
  UNIQUE(case_id,user_id,telegram_unique_id)
);
CREATE INDEX IF NOT EXISTS production_case_files_order ON production_case_files(order_id,created_at);
DROP TRIGGER IF EXISTS production_case_files_immutable ON production_case_files;
CREATE TRIGGER production_case_files_immutable BEFORE UPDATE OR DELETE ON production_case_files FOR EACH ROW EXECUTE FUNCTION production_immutable_audit();
CREATE TABLE IF NOT EXISTS production_case_file_quota (id integer PRIMARY KEY CHECK(id=1));
INSERT INTO production_case_file_quota(id) VALUES(1) ON CONFLICT DO NOTHING;
INSERT INTO production_schema_versions(version) VALUES(11) ON CONFLICT DO NOTHING;
