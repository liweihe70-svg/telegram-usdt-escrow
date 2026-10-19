-- Terms each party submits in the group with /terms after the deal exists; append-only, used in disputes.
CREATE TABLE IF NOT EXISTS production_deal_terms (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES production_orders(id),
  user_id bigint NOT NULL,
  text text NOT NULL CHECK(length(text) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS production_deal_terms_order ON production_deal_terms(order_id,created_at);
INSERT INTO production_schema_versions(version) VALUES(27) ON CONFLICT DO NOTHING;
