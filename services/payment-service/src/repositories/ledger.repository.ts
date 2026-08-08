import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/pool';
import type { EntryPair } from '../domain/payment';
import type { Leg, LedgerEntryRow } from '../models/ledger.model';

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
