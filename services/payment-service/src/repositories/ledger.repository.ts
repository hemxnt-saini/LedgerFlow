import { randomUUID } from 'node:crypto';
import { pool, type Queryable } from '../db/pool';
import type { AccountTotals } from '../domain/ledger';
import type { EntryPair } from '../domain/payment';
import type {
  JournalLineRow,
  Leg,
  LedgerEntryRow,
  StatementLineRow,
} from '../models/ledger.model';

/**
 * Posts one journal entry.
 *
 * Both lines share an `entry_group`, so "every group is exactly one debit and
 * one credit of the same amount" is a property the reconciler can check
 * without knowing anything about payments. Nothing here ever updates or
 * deletes a row - a reversal is two new opposite lines.
 */
export async function postJournal(
  db: Queryable,
  paymentId: string | null,
  leg: Leg,
  entries: EntryPair,
): Promise<void> {
  const entryGroup = randomUUID();
  for (const entry of entries) {
    await db.query(
      `INSERT INTO ledger_entries
         (entry_group, payment_id, account_id, direction, amount_cents, leg)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [entryGroup, paymentId, entry.accountId, entry.direction, entry.amountCents, leg],
    );
  }
}

/** The audit trail behind one payment, oldest leg first. */
export async function findByPaymentId(
  db: Queryable,
  paymentId: string,
): Promise<LedgerEntryRow[]> {
  const { rows } = await db.query<LedgerEntryRow>(
    `SELECT l.leg, l.direction, l.amount_cents, l.account_id, a.name, l.created_at
       FROM ledger_entries l
       JOIN accounts a ON a.id = l.account_id
      WHERE l.payment_id = $1
      ORDER BY l.id`,
    [paymentId],
  );
  return rows;
}

/**
 * Debit and credit totals per account, for the trial balance.
 *
 * sum() over bigint returns numeric, which pg hands back as a string, and a
 * string never equals a number - hence the explicit ::bigint casts. Getting
 * this wrong produces a report that claims the books are broken when they
 * are not.
 */
export async function accountTotals(): Promise<Map<string, AccountTotals>> {
  const { rows } = await pool.query<{ account_id: string; debits: number; credits: number }>(
    `SELECT account_id,
            coalesce(sum(amount_cents) FILTER (WHERE direction = 'DEBIT'),  0)::bigint AS debits,
            coalesce(sum(amount_cents) FILTER (WHERE direction = 'CREDIT'), 0)::bigint AS credits
       FROM ledger_entries
      GROUP BY account_id`,
  );
  return new Map(
    rows.map((row) => [row.account_id, { debitsCents: row.debits, creditsCents: row.credits }]),
  );
}

/**
 * The general journal: the most recent `limit` entry groups, every line of
 * each one.
 *
 * Paginated by group rather than by row, because half a journal entry is not
 * a meaningful thing to show anyone - the subquery picks whole groups and the
 * outer query then fetches all their lines.
 */
export async function listJournal(
  limit: number,
  accountId: string | null,
): Promise<JournalLineRow[]> {
  const { rows } = await pool.query<JournalLineRow>(
    `SELECT l.id, l.entry_group, l.payment_id, l.leg, l.direction, l.amount_cents,
            l.created_at, l.account_id, a.name
       FROM ledger_entries l
       JOIN accounts a ON a.id = l.account_id
      WHERE l.entry_group IN (
        SELECT entry_group FROM ledger_entries
         WHERE $1::uuid IS NULL OR account_id = $1::uuid
         GROUP BY entry_group
         ORDER BY max(id) DESC
         LIMIT $2
      )
      ORDER BY l.id DESC`,
    [accountId, limit],
  );
  return rows;
}

/**
 * One account's lines, newest first, each carrying the name of the other side
 * of its journal entry so a row reads as a sentence rather than an amount.
 */
export async function statementLines(
  accountId: string,
  limit: number,
): Promise<StatementLineRow[]> {
  const { rows } = await pool.query<StatementLineRow>(
    `SELECT l.entry_group, l.payment_id, l.leg, l.direction, l.amount_cents, l.created_at,
            (SELECT a.name
               FROM ledger_entries other
               JOIN accounts a ON a.id = other.account_id
              WHERE other.entry_group = l.entry_group AND other.id <> l.id
              LIMIT 1) AS counterparty
       FROM ledger_entries l
      WHERE l.account_id = $1
      ORDER BY l.id DESC
      LIMIT $2`,
    [accountId, limit],
  );
  return rows;
}

/** Credits minus debits over every line an account has ever had. */
export async function ledgerBalanceOf(accountId: string): Promise<number> {
  const { rows } = await pool.query<{ balance: number }>(
    `SELECT coalesce(sum(CASE WHEN direction = 'CREDIT' THEN amount_cents
                              ELSE -amount_cents END), 0)::bigint AS balance
       FROM ledger_entries WHERE account_id = $1`,
    [accountId],
  );
  return rows[0].balance;
}
