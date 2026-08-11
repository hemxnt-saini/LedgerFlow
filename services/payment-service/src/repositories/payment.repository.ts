import type { Queryable } from '../db/pool';
import type { PaymentStatus, SimulateMode } from '../domain/payment';
import type { PaymentRow } from '../models/payment.model';

export interface InsertPaymentParams {
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  note: string | null;
  status: PaymentStatus;
  failureReason: string | null;
  /** Only a client-supplied key is persisted - see the idempotency service. */
  idempotencyKey: string | null;
  simulateMode: SimulateMode;
  /** Why the risk screen held it, if it did. */
  holdReasons: string[];
  /** Milliseconds from now until leg 2 is due. */
  settleDelayMs: number;
  correlationId: string | null;
}

export async function insert(
  db: Queryable,
  params: InsertPaymentParams,
): Promise<PaymentRow> {
  const { rows } = await db.query<PaymentRow>(
    `INSERT INTO payments
       (from_account_id, to_account_id, amount_cents, note, status,
        failure_reason, idempotency_key, simulate_mode, hold_reasons,
        next_attempt_at, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             now() + ($10::int * interval '1 millisecond'), $11)
     RETURNING *`,
    [
      params.fromAccountId,
      params.toAccountId,
      params.amountCents,
      params.note,
      params.status,
      params.failureReason,
      params.idempotencyKey,
      params.simulateMode,
      params.holdReasons,
      params.settleDelayMs,
      params.correlationId,
    ],
  );
  return rows[0];
}

export async function findById(db: Queryable, id: string): Promise<PaymentRow | null> {
  const { rows } = await db.query<PaymentRow>('SELECT * FROM payments WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** Locks the row so two concurrent refunds cannot both read the same status. */
export async function findByIdForUpdate(
  db: Queryable,
  id: string,
): Promise<PaymentRow | null> {
  const { rows } = await db.query<PaymentRow>(
    'SELECT * FROM payments WHERE id = $1 FOR UPDATE',
    [id],
  );
  return rows[0] ?? null;
}

export async function findByIdempotencyKey(
  db: Queryable,
  key: string,
): Promise<PaymentRow | null> {
  const { rows } = await db.query<PaymentRow>(
    'SELECT * FROM payments WHERE idempotency_key = $1',
    [key],
  );
  return rows[0] ?? null;
}

export async function list(
  db: Queryable,
  accountId: string | null,
  limit: number,
): Promise<PaymentRow[]> {
  const { rows } = await db.query<PaymentRow>(
    `SELECT * FROM payments
      WHERE $1::uuid IS NULL OR from_account_id = $1 OR to_account_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [accountId, limit],
  );
  return rows;
}

/**
 * Claims a batch of payments that are due for work.
 *
 * One scheduling clock for both workers: a row is due when its
 * next_attempt_at has passed. The initial settle delay, each retry backoff and
 * the compensation delay are all just different values written into it.
 *
 * SKIP LOCKED means several instances of this service could run without ever
 * processing the same payment twice.
 */
export async function claimDue(
  db: Queryable,
  status: PaymentStatus,
  limit: number,
): Promise<PaymentRow[]> {
  const { rows } = await db.query<PaymentRow>(
    `SELECT * FROM payments
      WHERE status = $1 AND next_attempt_at <= now()
      ORDER BY next_attempt_at
        FOR UPDATE SKIP LOCKED
      LIMIT $2`,
    [status, limit],
  );
  return rows;
}

/** Every status change returns updated_at, which becomes the event timestamp. */
async function transition(db: Queryable, sql: string, params: unknown[]): Promise<Date> {
  const { rows } = await db.query<{ updated_at: Date }>(sql, params);
  return rows[0].updated_at;
}

export const markCompleted = (db: Queryable, id: string, attempts: number) =>
  transition(
    db,
    // Clear the reason: it recorded why an earlier attempt failed, and this
    // payment succeeded. A COMPLETED row must not carry a failure.
    `UPDATE payments SET status = 'COMPLETED', attempts = $2, failure_reason = NULL,
            updated_at = now()
      WHERE id = $1 RETURNING updated_at`,
    [id, attempts],
  );

export const markStranded = (
  db: Queryable,
  id: string,
  reason: string,
  attempts: number,
  compensateDelayMs: number,
) =>
  transition(
    db,
    `UPDATE payments
        SET status = 'AWAITING_REFUND', failure_reason = $2, attempts = $3,
            updated_at = now(),
            next_attempt_at = now() + ($4::int * interval '1 millisecond')
      WHERE id = $1 RETURNING updated_at`,
    [id, reason, attempts, compensateDelayMs],
  );

export const scheduleRetry = (
  db: Queryable,
  id: string,
  attempts: number,
  reason: string,
  delayMs: number,
) =>
  transition(
    db,
    `UPDATE payments
        SET attempts = $2, failure_reason = $3, updated_at = now(),
            next_attempt_at = now() + ($4::int * interval '1 millisecond')
      WHERE id = $1 RETURNING updated_at`,
    [id, attempts, reason, delayMs],
  );

/** `reason` distinguishes a rejected review from an ordinary stranded refund. */
export const markRefunded = (db: Queryable, id: string, reason?: string) =>
  transition(
    db,
    `UPDATE payments
        SET status = 'REFUNDED',
            failure_reason = coalesce($2, failure_reason),
            updated_at = now()
      WHERE id = $1 RETURNING updated_at`,
    [id, reason ?? null],
  );

/**
 * A reviewer released the funds: the payment rejoins the ordinary settlement
 * path rather than being settled here, so there is one route to COMPLETED.
 * `next_attempt_at` is set to now so the settle worker picks it up at once.
 */
export const markApproved = (db: Queryable, id: string) =>
  transition(
    db,
    `UPDATE payments
        SET status = 'PROCESSING', next_attempt_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'HELD_FOR_REVIEW' RETURNING updated_at`,
    [id],
  );

/** Payments waiting on a reviewer, oldest first - a queue, not a feed. */
export async function listHeld(db: Queryable, limit: number): Promise<PaymentRow[]> {
  const { rows } = await db.query<PaymentRow>(
    `SELECT * FROM payments WHERE status = 'HELD_FOR_REVIEW'
      ORDER BY created_at LIMIT $1`,
    [limit],
  );
  return rows;
}

/**
 * Has this sender ever successfully moved money to this payee before?
 *
 * A declined payment does not count as knowing someone: it moved nothing, and
 * treating it as a prior relationship would let a rejected attempt whitelist
 * the next one.
 */
export async function hasPaidBefore(
  db: Queryable,
  fromAccountId: string,
  toAccountId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM payments
        WHERE from_account_id = $1 AND to_account_id = $2
          AND status IN ('PROCESSING','HELD_FOR_REVIEW','COMPLETED','AWAITING_REFUND','REFUNDED')
     ) AS exists`,
    [fromAccountId, toAccountId],
  );
  return rows[0].exists;
}
