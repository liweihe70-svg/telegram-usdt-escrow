CREATE TABLE IF NOT EXISTS timeout_policy (
 id integer PRIMARY KEY CHECK(id=1), enabled boolean NOT NULL DEFAULT true,
 durations jsonb NOT NULL DEFAULT '{"AWAITING_ACCEPTANCE":60,"AWAITING_DEPOSIT":30,"FUNDED":1440,"AWAITING_CONFIRMATION":1440,"REFUND_REQUESTED":1440,"DISPUTED":1440}',
 reminder_minutes integer NOT NULL DEFAULT 60 CHECK(reminder_minutes BETWEEN 5 AND 10080)
);
INSERT INTO timeout_policy(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS order_timers (
 order_id uuid PRIMARY KEY REFERENCES orders(id), stage text NOT NULL, revision integer NOT NULL DEFAULT 1,
 entered_at timestamptz NOT NULL DEFAULT now(), deadline_at timestamptz,
 reminder_at timestamptz, timeout_minutes integer NOT NULL DEFAULT 60, reminder_minutes integer NOT NULL DEFAULT 60,
 manual_review boolean NOT NULL DEFAULT false, review_at timestamptz
);
-- Keep historical orders out of automatic expiry until they next change stage.
INSERT INTO order_timers(order_id,stage) SELECT id,state FROM orders ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS timeout_events (
 order_id uuid NOT NULL REFERENCES orders(id), revision integer NOT NULL, kind text NOT NULL,
 slot bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(order_id,revision,kind,slot)
);
ALTER TABLE outbox_jobs ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'PARTIES';
ALTER TABLE outbox_jobs ADD COLUMN IF NOT EXISTS timer_revision integer;
ALTER TABLE outbox_jobs ADD COLUMN IF NOT EXISTS retry_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE outbox_jobs ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
CREATE OR REPLACE FUNCTION update_order_timer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p timeout_policy; minutes integer;
BEGIN
 IF TG_OP='UPDATE' AND OLD.state=NEW.state THEN RETURN NEW; END IF;
 SELECT * INTO p FROM timeout_policy WHERE id=1;
 minutes := (p.durations->>NEW.state)::integer;
 INSERT INTO order_timers(order_id,stage,entered_at,deadline_at,reminder_at,timeout_minutes,reminder_minutes)
 VALUES(NEW.id,NEW.state,now(),CASE WHEN p.enabled AND minutes IS NOT NULL THEN now()+minutes*interval '1 minute' END,
 CASE WHEN p.enabled AND minutes IS NOT NULL THEN now()+p.reminder_minutes*interval '1 minute' END,coalesce(minutes,60),p.reminder_minutes)
 ON CONFLICT(order_id) DO UPDATE SET stage=excluded.stage,revision=order_timers.revision+1,entered_at=excluded.entered_at,
 deadline_at=excluded.deadline_at,reminder_at=excluded.reminder_at,timeout_minutes=excluded.timeout_minutes,
 reminder_minutes=excluded.reminder_minutes,manual_review=false,review_at=NULL;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS order_timer_stage ON orders;
CREATE TRIGGER order_timer_stage AFTER INSERT OR UPDATE OF state ON orders FOR EACH ROW EXECUTE FUNCTION update_order_timer();
