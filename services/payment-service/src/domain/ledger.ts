/**
 * Pure ledger reporting: turning journal lines into the two documents an
 * accountant actually asks for.
 *
 * A trial balance is the oldest correctness check in double-entry bookkeeping
 * and it is still the right one - list every account's debit and credit
 * totals, add up each column, and the two columns must be equal. If they are
 * not, a journal was written with only one side and the books are broken.
 *
 * A statement is the same rows read down one account with a running balance,
 * which is how you answer "where did this money come from" for a single line.
 *
 * Zero imports of express/pg/ioredis. The caller does the querying.
 */

export type Leg = 'FUNDING' | 'AUTHORISE' | 'SETTLE' | 'COMPENSATE';
export type Direction = 'DEBIT' | 'CREDIT';

/** One account's summed lines. */
export interface AccountTotals {
  debitsCents: number;
  creditsCents: number;
}

export interface AccountRef {
  id: string;
  name: string;
  /** The denormalised cache on `accounts`, which the ledger must agree with. */
  balanceCents: number;
  isSystem: boolean;
}

export interface TrialBalanceRow {
  accountId: string;
  accountName: string;
  isSystem: boolean;
  debitsCents: number;
  creditsCents: number;
  /** Credits minus debits: what the ledger says this account holds. */
  ledgerBalanceCents: number;
  /** What the `accounts` row claims it holds. */
  cachedBalanceCents: number;
  /** False means this account is the reason the books are wrong. */
  matches: boolean;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebitsCents: number;
  totalCreditsCents: number;
  /** Debits minus credits. Zero is the only correct answer. */
  differenceCents: number;
  balanced: boolean;
  /** Sum of every cached balance. Also zero, because the books are closed. */
  systemTotalCents: number;
  zeroSum: boolean;
  /** Accounts whose cache disagrees with their own journal lines. */
  mismatchedAccounts: number;
}

/**
 * Builds the trial balance.
 *
 * Accounts with no journal lines still appear, at zero - an account missing
 * from the report is indistinguishable from an account that balances, and the
 * whole point is to be able to look down the column.
 */
export function trialBalance(
  accounts: AccountRef[],
  totals: Map<string, AccountTotals>,
): TrialBalance {
  const rows: TrialBalanceRow[] = accounts.map((account) => {
    const debitsCents = totals.get(account.id)?.debitsCents ?? 0;
    const creditsCents = totals.get(account.id)?.creditsCents ?? 0;
    const ledgerBalanceCents = creditsCents - debitsCents;
    return {
      accountId: account.id,
      accountName: account.name,
      isSystem: account.isSystem,
      debitsCents,
      creditsCents,
      ledgerBalanceCents,
      cachedBalanceCents: account.balanceCents,
      matches: ledgerBalanceCents === account.balanceCents,
    };
  });

  const totalDebitsCents = rows.reduce((sum, row) => sum + row.debitsCents, 0);
  const totalCreditsCents = rows.reduce((sum, row) => sum + row.creditsCents, 0);
  const systemTotalCents = rows.reduce((sum, row) => sum + row.cachedBalanceCents, 0);

  return {
    rows,
    totalDebitsCents,
    totalCreditsCents,
    differenceCents: totalDebitsCents - totalCreditsCents,
    balanced: totalDebitsCents === totalCreditsCents,
    systemTotalCents,
    zeroSum: systemTotalCents === 0,
    mismatchedAccounts: rows.filter((row) => !row.matches).length,
  };
}

export interface StatementLine {
  entryGroup: string;
  paymentId: string | null;
  leg: Leg;
  direction: Direction;
  amountCents: number;
  createdAt: Date;
  /** The other side of this journal entry, so a line reads as a sentence. */
  counterpartyName: string | null;
}

export type StatementLineWithBalance = StatementLine & {
  /** Signed effect of this line on the account: credits add, debits subtract. */
  changeCents: number;
  /** The account's balance immediately after this line was posted. */
  runningCents: number;
};

export interface Statement {
  lines: StatementLineWithBalance[];
  openingCents: number;
  closingCents: number;
}

/**
 * Walks an account's lines oldest-first and carries a running balance.
 *
 * `openingCents` is what the account held before the first line shown, so a
 * truncated window still reconciles: opening plus the movements below always
 * equals closing.
 */
export function statement(
  lines: StatementLine[],
  openingCents: number,
): Statement {
  let running = openingCents;
  const withBalance = lines.map((line) => {
    const changeCents = line.direction === 'CREDIT' ? line.amountCents : -line.amountCents;
    running += changeCents;
    return { ...line, changeCents, runningCents: running };
  });

  return { lines: withBalance, openingCents, closingCents: running };
}
