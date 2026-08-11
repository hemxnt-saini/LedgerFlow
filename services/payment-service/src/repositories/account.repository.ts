import type { Queryable } from '../db/pool';
import type { AccountLimits, SpendSoFar } from '../domain/limits';
import type { Account } from '../domain/payment';
import type { AccountRow } from '../models/account.model';

const COLUMNS = 'id, name, balance_cents, is_system, created_at';

export async function insert(
  db: Queryable,
  name: string,
  balanceCents: number,
): Promise<AccountRow> {
  const { rows } = await db.query<AccountRow>(
    `INSERT INTO accounts (name, balance_cents) VALUES ($1, $2) RETURNING ${COLUMNS}`,
    [name, balanceCents],
  );
  return rows[0];
}

export async function findAll(
  db: Queryable,
  includeSystem: boolean,
): Promise<AccountRow[]> {
  const { rows } = await db.query<AccountRow>(
    `SELECT ${COLUMNS} FROM accounts
      WHERE $1::boolean OR NOT is_system
      ORDER BY is_system, created_at`,
    [includeSystem],
  );
  return rows;
}

export async function findById(db: Queryable, id: string): Promise<AccountRow | null> {
  const { rows } = await db.query<AccountRow>(
    `SELECT ${COLUMNS} FROM accounts WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Locks accounts with SELECT ... FOR UPDATE, always in ascending id order.
 *
 * Every leg of every saga acquires its locks through this function, so
 * concurrent payments queue instead of deadlocking on each other's rows. The
 * ordering is the entire point - two payments touching the same pair in
 * opposite directions would otherwise each hold what the other needs.
 *
 * ponytail: every payment locks the single clearing row, so throughput is
 * bounded by one account. Shard the clearing account if that ever matters.
 */
export async function lockMany(
  db: Queryable,
  ids: string[],
): Promise<Map<string, Account>> {
  const locked = new Map<string, Account>();
  for (const id of [...new Set(ids)].sort()) {
    const { rows } = await db.query<{ id: string; balance_cents: number }>(
      'SELECT id, balance_cents FROM accounts WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (rows[0]) locked.set(id, { id: rows[0].id, balanceCents: rows[0].balance_cents });
  }
  return locked;
}

export async function updateBalance(
  db: Queryable,
  id: string,
  balanceCents: number,
): Promise<void> {
  await db.query('UPDATE accounts SET balance_cents = $2 WHERE id = $1', [
    id,
    balanceCents,
  ]);
}

export async function findLimits(
  db: Queryable,
  id: string,
): Promise<AccountLimits | null> {
  const { rows } = await db.query<{
    max_payment_cents: number;
    daily_limit_cents: number;
    velocity_max: number;
  }>(
    'SELECT max_payment_cents, daily_limit_cents, velocity_max FROM accounts WHERE id = $1',
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    maxPaymentCents: row.max_payment_cents,
    dailyLimitCents: row.daily_limit_cents,
    velocityMax: row.velocity_max,
  };
}

export async function updateLimits(
  db: Queryable,
  id: string,
  limits: AccountLimits,
): Promise<AccountRow | null> {
  const { rows } = await db.query<AccountRow>(
    `UPDATE accounts
        SET max_payment_cents = $2, daily_limit_cents = $3, velocity_max = $4
      WHERE id = $1 AND NOT is_system
      RETURNING ${COLUMNS}`,
    [id, limits.maxPaymentCents, limits.dailyLimitCents, limits.velocityMax],
  );
  return rows[0] ?? null;
}

/**
 * What this account has already spent, for the limit check.
 *
 * Counts only payments that actually took funds. A declined payment moved
 * nothing and must not consume an allowance, and a refunded one gave the money
 * back. Velocity counts the same set rather than every attempt, so a run of
 * insufficient-funds declines cannot rate-limit someone out of their own
 * wallet.
 *
 * Must be called with the sender's row already locked. Under READ COMMITTED
 * this sees everything committed before the statement began, and the row lock
 * is what guarantees no concurrent payment from the same sender can commit
 * between this read and ours.
 */
export async function spendSoFar(
  db: Queryable,
  accountId: string,
  velocityWindowSeconds: number,
): Promise<SpendSoFar> {
  const { rows } = await db.query<{ today_cents: number; recent_count: number }>(
    `SELECT
       coalesce(sum(amount_cents)
         FILTER (WHERE created_at >= date_trunc('day', now())), 0)::bigint AS today_cents,
       count(*)
         FILTER (WHERE created_at >= now() - make_interval(secs => $2))::int AS recent_count
       FROM payments
      WHERE from_account_id = $1
        AND status IN ('PROCESSING','HELD_FOR_REVIEW','COMPLETED','AWAITING_REFUND')`,
    [accountId, velocityWindowSeconds],
  );
  return { todayCents: rows[0].today_cents, recentCount: rows[0].recent_count };
}
