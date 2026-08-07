import { randomUUID } from 'node:crypto';
import { Pool, types, type PoolClient } from 'pg';
import { currentCorrelationId } from './logger';

// pg returns BIGINT as a string to avoid precision loss. Cent amounts are far
// below Number.MAX_SAFE_INTEGER, so read them as numbers and keep the maths
// in one representation.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgres://payments:payments@localhost:5432/payments',
});

/**
 * The clearing (suspense) account. Money in flight belongs to it: debited from
 * the sender on authorisation, credited to the receiver on settlement. Fixed
 * id so every service and script can refer to it without a lookup.
 */
export const CLEARING_ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';

/**
 * The funding account. Opening a wallet with $1,000 is not money appearing
 * from nowhere - it is DEBIT funding / CREDIT wallet, so the funding account
 * goes negative by exactly the amount issued into the system.
 *
 * This is what makes the ledger *complete*: every cent has a provenance, and
 * the balances of all accounts together must sum to precisely zero. Without
 * it, an account's opening balance would be an unauditable number on a row
 * and the reconciler would have nothing to check it against.
 */
export const FUNDING_ACCOUNT_ID = '00000000-0000-4000-8000-000000000002';

// Idempotent DDL run on boot. A real deployment would use a migration tool;
// for a single-developer demo, CREATE TABLE IF NOT EXISTS is enough.
const SCHEMA = `
-- No CHECK (balance_cents >= 0): the domain guards user accounts, and the
-- clearing account is allowed to hold whatever is in flight.
CREATE TABLE IF NOT EXISTS accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  balance_cents BIGINT NOT NULL,
  is_system     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_account_id  UUID NOT NULL REFERENCES accounts(id),
  to_account_id    UUID NOT NULL REFERENCES accounts(id),
  amount_cents     BIGINT NOT NULL CHECK (amount_cents > 0),
  note             TEXT,
  status           TEXT NOT NULL CHECK (status IN
                     ('PROCESSING','COMPLETED','FAILED','AWAITING_REFUND','REFUNDED')),
  failure_reason   TEXT,
  idempotency_key  TEXT UNIQUE,
  -- Demo affordance: makes the settle leg fail on purpose. TRANSIENT heals
  -- before the retries run out; PERMANENT ends in compensation.
  simulate_mode    TEXT NOT NULL DEFAULT 'NONE',
  -- Retry bookkeeping for leg 2. next_attempt_at is the single scheduling
  -- clock for both workers, so "when should this be looked at again" is one
  -- column rather than an implicit rule about updated_at.
  attempts         INT NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The request that created this payment. Background workers pick it up so
  -- a settlement hours later is still traceable to the original call.
  correlation_id   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_pending_idx
  ON payments (status, next_attempt_at) WHERE status IN ('PROCESSING','AWAITING_REFUND');
CREATE INDEX IF NOT EXISTS payments_from_idx ON payments (from_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_to_idx   ON payments (to_account_id, created_at DESC);

-- Append-only. Nothing in this service ever UPDATEs or DELETEs a ledger row.
--
-- entry_group is the journal entry these lines belong to: every group must
-- contain exactly one debit and one credit of the same amount. payment_id is
-- nullable because funding a new wallet is a journal entry with no payment.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id           BIGSERIAL PRIMARY KEY,
  entry_group  UUID NOT NULL,
  payment_id   UUID REFERENCES payments(id),
  account_id   UUID NOT NULL REFERENCES accounts(id),
  direction    TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  leg          TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_group_idx   ON ledger_entries (entry_group);
CREATE INDEX IF NOT EXISTS ledger_account_idx ON ledger_entries (account_id);

-- Every reconciliation pass is kept, so drift has a history and a first
-- sighting rather than just a red light on a dashboard.
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id               BIGSERIAL PRIMARY KEY,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  status           TEXT NOT NULL,
  checked_accounts INT NOT NULL DEFAULT 0,
  drift_cents      BIGINT NOT NULL DEFAULT 0,
  findings         JSONB NOT NULL DEFAULT '[]'::jsonb,
  duration_ms      INT
);

CREATE TABLE IF NOT EXISTS outbox (
  id           BIGSERIAL PRIMARY KEY,
  event_type   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS outbox_unpublished_idx
  ON outbox (id) WHERE published_at IS NULL;

INSERT INTO accounts (id, name, balance_cents, is_system) VALUES
  ('${CLEARING_ACCOUNT_ID}', 'Clearing account', 0, true),
  ('${FUNDING_ACCOUNT_ID}',  'Funding account',  0, true)
ON CONFLICT (id) DO NOTHING;
`;

// There is no migration tool here, so CREATE TABLE IF NOT EXISTS will not add
// a column to a table that already exists. These make an older volume usable
// without a `docker compose down -v`.
const UPGRADES = `
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
`;

export async function initSchema(): Promise<void> {
  await pool.query(SCHEMA);
  await pool.query(UPGRADES);
}

/** Run fn inside a single transaction; rollback on any throw. */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Transactional outbox write: the event goes into the same DB transaction as
 * the business data, so we can never publish an event for a rolled-back
 * payment (or commit a payment whose event was lost) - the dual-write problem.
 */
export async function enqueueEvent(
  client: PoolClient,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    'INSERT INTO outbox (event_type, payload) VALUES ($1, $2)',
    [
      eventType,
      // Publishing is at-least-once (a crash between the Kafka send and the
      // COMMIT re-sends the row), so every event carries a stable id and
      // consumers apply it once. Generated here, not at publish time, so a
      // re-publish carries the *same* id.
      // The correlation id rides along in the payload, so it survives the
      // trip through Kafka and the read side can log under the same id.
      JSON.stringify({
        eventId: randomUUID(),
        type: eventType,
        correlationId: currentCorrelationId(),
        ...payload,
      }),
    ],
  );
}
