-- There is no migration tool here, so CREATE TABLE IF NOT EXISTS will not add
-- a column to a table that already exists. These make an older volume usable
-- without a `docker compose down -v` - including a volume written by the
-- TypeScript implementation of this service, which is the point.
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS entry_group UUID;
UPDATE ledger_entries SET entry_group = gen_random_uuid() WHERE entry_group IS NULL;
ALTER TABLE ledger_entries ALTER COLUMN entry_group SET NOT NULL;
ALTER TABLE ledger_entries ALTER COLUMN payment_id DROP NOT NULL;
ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_leg_check;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE payments ADD COLUMN IF NOT EXISTS simulate_mode TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE payments DROP COLUMN IF EXISTS simulate_failure;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS correlation_id TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS max_payment_cents BIGINT NOT NULL DEFAULT ${MAX_PAYMENT_CENTS};
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS daily_limit_cents BIGINT NOT NULL DEFAULT ${DAILY_LIMIT_CENTS};
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS velocity_max      INT    NOT NULL DEFAULT ${VELOCITY_MAX};
ALTER TABLE payments ADD COLUMN IF NOT EXISTS hold_reasons TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check CHECK (status IN
  ('PROCESSING','HELD_FOR_REVIEW','COMPLETED','FAILED','AWAITING_REFUND','REFUNDED'));
DROP INDEX IF EXISTS payments_spend_idx;
