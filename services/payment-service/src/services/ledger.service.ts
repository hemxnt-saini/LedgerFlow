import { pool } from '../db/pool';
import { statement, trialBalance, type Statement, type TrialBalance } from '../domain/ledger';
import { notFound } from '../lib/http-error';
import { toJournalEntries, type JournalEntryDto } from '../models/ledger.model';
import * as accounts from '../repositories/account.repository';
import * as ledger from '../repositories/ledger.repository';

/**
 * The ledger, read rather than written.
 *
 * Nothing in this file touches a row. The journal is append-only, so every
 * question about the past is answered by reading it back - there is no
 * summary table to fall out of date, and no cached figure that could be
 * wrong in a way the ledger is not.
 */

/**
 * The oldest correctness check in bookkeeping: add up the debit column, add up
 * the credit column, and the two must be equal.
 *
 * System accounts are included deliberately. Leaving out the funding account
 * would make the columns disagree by exactly the amount of money issued, and
 * a trial balance you have to explain away is not a trial balance.
 */
export async function getTrialBalance(): Promise<TrialBalance> {
  const [accountRows, totals] = await Promise.all([
    accounts.findAll(pool, true),
    ledger.accountTotals(),
  ]);

  return trialBalance(
    accountRows.map((row) => ({
      id: row.id,
      name: row.name,
      balanceCents: row.balance_cents,
      isSystem: row.is_system,
    })),
    totals,
  );
}

/** The general journal, newest entry first, optionally for one account. */
export async function getJournal(
  limit: number,
  accountId: string | null,
): Promise<{ entries: JournalEntryDto[] }> {
  const rows = await ledger.listJournal(limit, accountId);
  return { entries: toJournalEntries(rows) };
}

export interface AccountStatement extends Statement {
  accountId: string;
  accountName: string;
  /** What the `accounts` row claims, for comparison with `closingCents`. */
  cachedBalanceCents: number;
  matches: boolean;
}

/**
 * One account's statement, oldest line first with a running balance.
 *
 * Only the most recent `limit` lines are shown, so the opening figure is
 * derived by subtracting the movements on this page from the account's full
 * ledger balance. That keeps the page self-proving: opening plus the column
 * of movements always equals closing, however far back the window starts.
 */
export async function getStatement(
  accountId: string,
  limit: number,
): Promise<AccountStatement> {
  const account = await accounts.findById(pool, accountId);
  if (!account) throw notFound('ACCOUNT_NOT_FOUND');

  const [rows, ledgerBalanceCents] = await Promise.all([
    ledger.statementLines(accountId, limit),
    ledger.ledgerBalanceOf(accountId),
  ]);

  // The query returns newest first for the LIMIT to mean "most recent".
  const chronological = [...rows].reverse().map((row) => ({
    entryGroup: row.entry_group,
    paymentId: row.payment_id,
    leg: row.leg,
    direction: row.direction,
    amountCents: row.amount_cents,
    createdAt: row.created_at,
    counterpartyName: row.counterparty,
  }));

  const movementShown = chronological.reduce(
    (sum, line) => sum + (line.direction === 'CREDIT' ? line.amountCents : -line.amountCents),
    0,
  );

  return {
    ...statement(chronological, ledgerBalanceCents - movementShown),
    accountId: account.id,
    accountName: account.name,
    cachedBalanceCents: account.balance_cents,
    matches: ledgerBalanceCents === account.balance_cents,
  };
}
