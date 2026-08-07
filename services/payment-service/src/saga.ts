import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  MAX_SETTLE_ATTEMPTS,
  backoffMs,
  canRefund,
  canSettle,
  isExhausted,
  moveFunds,
  shouldSimulateFailure,
  type Account,
  type EntryPair,
  type PaymentStatus,
  type SimulateMode,
} from './domain';
import { CLEARING_ACCOUNT_ID, enqueueEvent, withTransaction } from './db';
import { startPoller, type Poller } from './poller';
import { log, newCorrelationId, withContext } from './logger';

/**
 * How long a payment sits in PROCESSING before the settle leg runs. This is
 * an artificial pause: it makes the half-finished state long enough to see in
 * the UI, which is the whole point of modelling the saga instead of one
 * atomic transfer. Set it to 0 for a snappier demo.
 */
export const SETTLE_DELAY_MS = Number(process.env.SETTLE_DELAY_MS ?? 900);
/** How long stranded money sits visible before it is automatically returned. */
const COMPENSATE_DELAY_MS = Number(process.env.COMPENSATE_DELAY_MS ?? 4000);
const POLL_MS = Number(process.env.SAGA_POLL_MS ?? 300);
const BATCH = 20;

export interface PaymentRow {
  id: string;
  from_account_id: string;
  to_account_id: string;
  amount_cents: number;
  note: string | null;
  status: PaymentStatus;
  failure_reason: string | null;
  simulate_mode: SimulateMode;
  attempts: number;
  next_attempt_at: Date;
  correlation_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Locks accounts with SELECT ... FOR UPDATE, always in ascending id order.
 * Every leg of every saga acquires its locks the same way, so concurrent
 * payments queue instead of deadlocking on each other's rows.
 *
 * ponytail: every payment locks the single clearing row, so throughput is
 * bounded by one account. Shard the clearing account if that ever matters.
 */
export async function lockAccounts(
  client: PoolClient,
  ids: string[],
): Promise<Map<string, Account>> {
  const locked = new Map<string, Account>();
  for (const id of [...new Set(ids)].sort()) {
    const { rows } = await client.query<{ id: string; balance_cents: number }>(
      'SELECT id, balance_cents FROM accounts WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (rows[0]) locked.set(id, { id: rows[0].id, balanceCents: rows[0].balance_cents });
  }
  return locked;
}

export async function setBalance(client: PoolClient, id: string, balanceCents: number) {
  await client.query('UPDATE accounts SET balance_cents = $2 WHERE id = $1', [
    id,
    balanceCents,
  ]);
}

export type Leg = 'FUNDING' | 'AUTHORISE' | 'SETTLE' | 'COMPENSATE';

/**
 * Posts one journal entry: both lines share an `entry_group`, so "every group
 * is exactly one debit and one credit of the same amount" is a property the
 * reconciler can check without knowing anything about payments.
 */
export async function postJournal(
  client: PoolClient,
  paymentId: string | null,
  leg: Leg,
  entries: EntryPair,
) {
  const entryGroup = randomUUID();
  for (const entry of entries) {
    await client.query(
      `INSERT INTO ledger_entries (entry_group, payment_id, account_id, direction, amount_cents, leg)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [entryGroup, paymentId, entry.accountId, entry.direction, entry.amountCents, leg],
    );
  }
}

const eventBody = (row: PaymentRow, occurredAt: Date) => ({
  paymentId: row.id,
  fromAccountId: row.from_account_id,
  toAccountId: row.to_account_id,
  amountCents: row.amount_cents,
  note: row.note,
  occurredAt: occurredAt.toISOString(),
});

/**
 * Leg 2 of the saga: move the held funds from clearing to the receiver.
 *
 * Runs in its own transaction, minutes or milliseconds after leg 1 - that
 * separation is the entire reason a payment can get stuck, and the reason a
 * compensating action has to exist.
 */
async function settle(client: PoolClient, row: PaymentRow): Promise<PaymentStatus> {
  if (!canSettle(row.status)) return row.status;

  const strand = async (reason: string): Promise<PaymentStatus> => {
    // Out of retries. The sender's money stays in clearing - nothing is lost,
    // it is owed back, and the compensation worker will return it.
    const { rows } = await client.query<{ updated_at: Date }>(
      `UPDATE payments
          SET status = 'AWAITING_REFUND', failure_reason = $2, attempts = $3,
              updated_at = now(), next_attempt_at = now() + ($4::int * interval '1 millisecond')
        WHERE id = $1 RETURNING updated_at`,
      [row.id, reason, row.attempts + 1, COMPENSATE_DELAY_MS],
    );
    await enqueueEvent(client, 'payment.stuck', {
      ...eventBody(row, rows[0].updated_at),
      failureReason: reason,
      attempts: row.attempts + 1,
    });
    return 'AWAITING_REFUND';
  };

  /**
   * A failure is not automatically fatal. Most things that break between two
   * services break briefly - so try again, backing off, and only give the
   * money back once the attempts are used up. Compensating on the first
   * hiccup would unwind perfectly good payments.
   */
  const retryOrStrand = async (reason: string): Promise<PaymentStatus> => {
    const attempts = row.attempts + 1;
    if (isExhausted(attempts)) return strand(reason);

    const delay = backoffMs(attempts, { jitter: Math.random() });
    const { rows } = await client.query<{ updated_at: Date }>(
      `UPDATE payments
          SET attempts = $2, failure_reason = $3, updated_at = now(),
              next_attempt_at = now() + ($4::int * interval '1 millisecond')
        WHERE id = $1 RETURNING updated_at`,
      [row.id, attempts, reason, delay],
    );
    await enqueueEvent(client, 'payment.settlement_retrying', {
      ...eventBody(row, rows[0].updated_at),
      failureReason: reason,
      attempts,
      maxAttempts: MAX_SETTLE_ATTEMPTS,
      retryInMs: delay,
    });
    return 'PROCESSING';
  };

  if (shouldSimulateFailure(row.simulate_mode, row.attempts)) {
    return retryOrStrand('SETTLEMENT_FAILED_SIMULATED');
  }

  const accounts = await lockAccounts(client, [CLEARING_ACCOUNT_ID, row.to_account_id]);
  const clearing = accounts.get(CLEARING_ACCOUNT_ID);
  const receiver = accounts.get(row.to_account_id);
  if (!clearing || !receiver) return retryOrStrand('RECEIVER_UNAVAILABLE');

  const move = moveFunds(clearing, receiver, row.amount_cents);
  if (!move.ok) return retryOrStrand(move.failureReason);

  await setBalance(client, clearing.id, move.fromBalanceCents);
  await setBalance(client, receiver.id, move.toBalanceCents);
  await postJournal(client, row.id, 'SETTLE', move.entries);

  const { rows } = await client.query<{ updated_at: Date }>(
    // Clear the reason: it recorded why an earlier attempt failed, and this
    // payment succeeded. A COMPLETED row must not carry a failure.
    `UPDATE payments SET status = 'COMPLETED', attempts = $2, failure_reason = NULL,
            updated_at = now()
      WHERE id = $1 RETURNING updated_at`,
    [row.id, row.attempts + 1],
  );
  await enqueueEvent(client, 'payment.completed', {
    ...eventBody(row, rows[0].updated_at),
    attempts: row.attempts + 1,
  });
  return 'COMPLETED';
}

/**
 * The compensating action: return stranded funds from clearing to the sender.
 * Shared by the automatic worker and the manual refund endpoint, so both take
 * exactly the same path.
 */
export async function compensate(
  client: PoolClient,
  row: PaymentRow,
): Promise<PaymentStatus> {
  if (!canRefund(row.status)) return row.status;

  const accounts = await lockAccounts(client, [CLEARING_ACCOUNT_ID, row.from_account_id]);
  const clearing = accounts.get(CLEARING_ACCOUNT_ID)!;
  const sender = accounts.get(row.from_account_id)!;

  const move = moveFunds(clearing, sender, row.amount_cents);
  if (!move.ok) {
    // Clearing not holding the money means the ledger has been tampered with.
    // Refuse loudly rather than invent a balance.
    throw new Error(
      `cannot compensate ${row.id}: clearing account ${move.failureReason}`,
    );
  }

  await setBalance(client, clearing.id, move.fromBalanceCents);
  await setBalance(client, sender.id, move.toBalanceCents);
  await postJournal(client, row.id, 'COMPENSATE', move.entries);

  const { rows } = await client.query<{ updated_at: Date }>(
    `UPDATE payments SET status = 'REFUNDED', updated_at = now()
      WHERE id = $1 RETURNING updated_at`,
    [row.id],
  );
  await enqueueEvent(client, 'payment.refunded', eventBody(row, rows[0].updated_at));
  return 'REFUNDED';
}

/** Claims a batch of rows in one status, oldest first, and runs `step` on each. */
async function drain(
  status: PaymentStatus,
  step: (client: PoolClient, row: PaymentRow) => Promise<PaymentStatus>,
): Promise<void> {
  await withTransaction(async (client) => {
    // One scheduling clock for both workers: a row is due when its
    // next_attempt_at has passed. Backoff, the initial settle delay and the
    // compensation delay are all just different values written into it.
    const { rows } = await client.query<PaymentRow>(
      `SELECT * FROM payments
        WHERE status = $1 AND next_attempt_at <= now()
        ORDER BY next_attempt_at
          FOR UPDATE SKIP LOCKED
        LIMIT $2`,
      [status, BATCH],
    );
    for (const row of rows) {
      // Background work gets its own correlation id unless the row already
      // carries one, so a settlement is still traceable end to end even
      // though no HTTP request is in flight.
      await withContext(
        { correlationId: row.correlation_id ?? newCorrelationId(), paymentId: row.id },
        async () => {
          const next = await step(client, row);
          log.info('saga transition', {
            from: row.status,
            to: next,
            attempts: row.attempts,
          });
        },
      );
    }
  });
}

/** Leg 2 runner: PROCESSING -> COMPLETED, or -> AWAITING_REFUND. */
export function startSettlementWorker(): Poller {
  return startPoller('settle', POLL_MS, () => drain('PROCESSING', settle));
}

/**
 * Automatic compensation: AWAITING_REFUND -> REFUNDED. A stuck payment repays
 * itself without anyone pressing a button; the manual endpoint just skips the
 * wait.
 */
export function startCompensationWorker(): Poller {
  return startPoller('compensate', POLL_MS, () => drain('AWAITING_REFUND', compensate));
}
