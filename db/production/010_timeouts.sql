ALTER TABLE production_orders DROP CONSTRAINT IF EXISTS production_orders_state_check;
ALTER TABLE production_orders ADD CONSTRAINT production_orders_state_check CHECK(state IN ('AWAITING_ACCEPTANCE','AWAITING_DEPOSIT','FUNDED','AWAITING_CONFIRMATION','REFUND_REQUESTED','DISPUTED','PENDING_APPROVAL','APPROVED','MANUAL_REVIEW','TIMED_OUT','COMPLETED','REFUNDED','ARBITRATED','CLOSED'));
ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS stage_started_at timestamptz;
ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS deadline_at timestamptz;
ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS reminder_at timestamptz;
ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS timed_out_from text CHECK(timed_out_from IS NULL OR timed_out_from IN ('FUNDED','AWAITING_CONFIRMATION','REFUND_REQUESTED'));
CREATE TABLE IF NOT EXISTS production_timeout_settings (
  stage text PRIMARY KEY CHECK(stage IN ('AWAITING_ACCEPTANCE','AWAITING_DEPOSIT','FUNDED','AWAITING_CONFIRMATION','REFUND_REQUESTED')),
  minutes integer NOT NULL CHECK(minutes BETWEEN 5 AND 10080),
  reminder_minutes integer NOT NULL CHECK(reminder_minutes BETWEEN 0 AND 10080),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO production_timeout_settings(stage,minutes,reminder_minutes) VALUES
  ('AWAITING_ACCEPTANCE',60,15),('AWAITING_DEPOSIT',60,15),('FUNDED',1440,120),('AWAITING_CONFIRMATION',1440,120),('REFUND_REQUESTED',1440,120)
ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS production_timeout_control (
  id integer PRIMARY KEY CHECK(id=1),
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO production_timeout_control(id) VALUES(1) ON CONFLICT DO NOTHING;
-- Every state change, from any module, snapshots the new stage's deadline from the settings at that moment.
-- Orders that predate this migration start timing at their next state change.
CREATE OR REPLACE FUNCTION production_order_stage_timer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s production_timeout_settings%ROWTYPE; enabled boolean;
BEGIN
  IF TG_OP='UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NEW; END IF;
  NEW.stage_started_at:=now();NEW.deadline_at:=NULL;NEW.reminder_at:=NULL;
  IF NEW.state<>'TIMED_OUT' THEN NEW.timed_out_from:=NULL; END IF;
  SELECT c.enabled INTO enabled FROM production_timeout_control c WHERE c.id=1;
  SELECT * INTO s FROM production_timeout_settings WHERE stage=NEW.state;
  IF FOUND AND coalesce(enabled,false) THEN
    NEW.deadline_at:=now()+s.minutes*interval '1 minute';
    IF s.reminder_minutes>0 AND s.reminder_minutes<s.minutes THEN NEW.reminder_at:=NEW.deadline_at-s.reminder_minutes*interval '1 minute'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS production_order_stage_timer ON production_orders;
CREATE TRIGGER production_order_stage_timer BEFORE INSERT OR UPDATE OF state ON production_orders FOR EACH ROW EXECUTE FUNCTION production_order_stage_timer();
INSERT INTO production_schema_versions(version) VALUES(10) ON CONFLICT DO NOTHING;
