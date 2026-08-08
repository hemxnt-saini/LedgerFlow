import type { Queryable } from '../db/pool';
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
