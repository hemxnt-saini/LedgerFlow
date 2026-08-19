-- Idempotent DDL run on boot. A real deployment would use a migration tool;
-- for a single-developer project, CREATE TABLE IF NOT EXISTS is enough.
--
-- ${...} tokens are filled in from Config before this runs, so the column
-- defaults and the system account ids have exactly one definition.

-- No CHECK (balance_cents >= 0): the domain guards user accounts, and the
-- clearing account is allowed to hold whatever is in flight.
CREATE TABLE IF NOT EXISTS accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  balance_cents BIGINT NOT NULL,
  is_system     BOOLEAN NOT NULL DEFAULT false,
  -- Spending controls, per account. Held here rather than in a side table
  -- because there is exactly one set per account and the authorise
  -- transaction already has this row locked when it needs them.
  max_payment_cents BIGINT NOT NULL DEFAULT ${MAX_PAYMENT_CENTS} CHECK (max_payment_cents >= 0),
  daily_limit_cents BIGINT NOT NULL DEFAULT ${DAILY_LIMIT_CENTS} CHECK (daily_limit_cents >= 0),
  velocity_max      INT    NOT NULL DEFAULT ${VELOCITY_MAX}     CHECK (velocity_max >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_account_id  UUID NOT NULL REFERENCES accounts(id),
  to_account_id    UUID NOT NULL REFERENCES accounts(id),
  amount_cents     BIGINT NOT NULL CHECK (amount_cents > 0),
  note             TEXT,
  status           TEXT NOT NULL CHECK (status IN
                     ('PROCESSING','HELD_FOR_REVIEW','COMPLETED','FAILED','AWAITING_REFUND','REFUNDED')),
  failure_reason   TEXT,
  idempotency_key  TEXT UNIQUE,
  -- Demo affordance: makes the settle leg fail on purpose. TRANSIENT heals
  -- before the retries run out; PERMANENT ends in compensation.
  simulate_mode    TEXT NOT NULL DEFAULT 'NONE',
  -- Why the risk screen stopped this payment. Empty for everything else.
  hold_reasons     TEXT[] NOT NULL DEFAULT '{}',
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
-- The limit check sums one sender's recent funds-taking payments on every
-- authorise, so it gets an index shaped like that query.
CREATE INDEX IF NOT EXISTS payments_spend_idx
  ON payments (from_account_id, created_at DESC)
  WHERE status IN ('PROCESSING','HELD_FOR_REVIEW','COMPLETED','AWAITING_REFUND');

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
  ('${CLEARING_ID}', 'Clearing account', 0, true),
  ('${FUNDING_ID}',  'Funding account',  0, true)
ON CONFLICT (id) DO NOTHING;
