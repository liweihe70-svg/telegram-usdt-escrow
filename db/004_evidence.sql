CREATE TABLE IF NOT EXISTS bot_evidence_files (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id), user_id bigint NOT NULL,
 filename text NOT NULL, mime text NOT NULL CHECK(mime IN ('image/png','image/jpeg','application/pdf','text/plain')),
 note text NOT NULL, bytes bytea NOT NULL, size integer NOT NULL CHECK(size BETWEEN 1 AND 5242880),
 sha256 text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), CHECK(octet_length(bytes)=size)
);
CREATE TABLE IF NOT EXISTS bot_evidence_quota(id integer PRIMARY KEY CHECK(id=1));
INSERT INTO bot_evidence_quota VALUES(1) ON CONFLICT DO NOTHING;
