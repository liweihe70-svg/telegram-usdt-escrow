-- Preserve records, but retire redundant pending startup notices from older versions.
UPDATE outbox_jobs SET delivered_at=now() WHERE id IN (
 SELECT id FROM (
  SELECT id,row_number() OVER(PARTITION BY order_id ORDER BY created_at,id) AS n
  FROM outbox_jobs WHERE event='BOT_RESUMED' AND delivered_at IS NULL
 ) pending WHERE n>1
);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_pending_resume ON outbox_jobs(order_id)
 WHERE event='BOT_RESUMED' AND delivered_at IS NULL;
