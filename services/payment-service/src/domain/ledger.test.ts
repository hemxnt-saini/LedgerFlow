import {
  statement,
  trialBalance,
  type AccountRef,
  type AccountTotals,
  type StatementLine,
} from './ledger';

const account = (
  id: string,
  name: string,
  balanceCents: number,
  isSystem = false,
): AccountRef => ({ id, name, balanceCents, isSystem });

const totals = (
  entries: [string, number, number][],
): Map<string, AccountTotals> =>
  new Map(entries.map(([id, debits, credits]) => [id, { debitsCents: debits, creditsCents: credits }]));

describe('trialBalance', () => {
  // Opening two wallets from the funding account: the funding account is
  // debited twice, each wallet credited once. Columns must match.
  const funded = () =>
    trialBalance(
      [
        account('funding', 'Funding account', -15_000, true),
        account('alice', 'Alice', 10_000),
        account('bob', 'Bob', 5_000),
      ],
      totals([
        ['funding', 15_000, 0],
        ['alice', 0, 10_000],
        ['bob', 0, 5_000],
      ]),
    );

  it('adds each column and reports them equal', () => {
    const result = funded();
    expect(result.totalDebitsCents).toBe(15_000);
    expect(result.totalCreditsCents).toBe(15_000);
    expect(result.differenceCents).toBe(0);
    expect(result.balanced).toBe(true);
  });

  it('reports the closed books summing to zero', () => {
    const result = funded();
    expect(result.systemTotalCents).toBe(0);
    expect(result.zeroSum).toBe(true);
  });

  it('agrees with each cached balance when nothing has drifted', () => {
    const result = funded();
    expect(result.mismatchedAccounts).toBe(0);
    expect(result.rows.every((row) => row.matches)).toBe(true);
  });

  it('derives the ledger balance as credits minus debits', () => {
    const result = funded();
    const alice = result.rows.find((row) => row.accountId === 'alice');
    expect(alice?.ledgerBalanceCents).toBe(10_000);
    const funding = result.rows.find((row) => row.accountId === 'funding');
    expect(funding?.ledgerBalanceCents).toBe(-15_000);
  });

  // The failure this document exists to catch: a hand-edited balance.
  it('names the account whose cache no longer matches its journal', () => {
    const result = trialBalance(
      [account('alice', 'Alice', 999_999), account('bob', 'Bob', 5_000)],
      totals([
        ['alice', 0, 10_000],
        ['bob', 0, 5_000],
      ]),
    );
    expect(result.mismatchedAccounts).toBe(1);
    const alice = result.rows.find((row) => row.accountId === 'alice');
    expect(alice?.matches).toBe(false);
    expect(alice?.ledgerBalanceCents).toBe(10_000);
    expect(alice?.cachedBalanceCents).toBe(999_999);
  });

  // A half-written journal: the debit landed, the credit did not.
  it('shows the columns disagreeing when only one side was posted', () => {
    const result = trialBalance(
      [account('alice', 'Alice', -2_500), account('bob', 'Bob', 0)],
      totals([['alice', 2_500, 0]]),
    );
    expect(result.totalDebitsCents).toBe(2_500);
    expect(result.totalCreditsCents).toBe(0);
    expect(result.differenceCents).toBe(2_500);
    expect(result.balanced).toBe(false);
  });

  it('lists an account with no journal lines at zero rather than omitting it', () => {
    const result = trialBalance([account('new', 'Newcomer', 0)], new Map());
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      debitsCents: 0,
      creditsCents: 0,
      ledgerBalanceCents: 0,
      matches: true,
    });
  });

  it('is balanced and zero-sum on an empty system', () => {
    const result = trialBalance([], new Map());
    expect(result.balanced).toBe(true);
    expect(result.zeroSum).toBe(true);
    expect(result.mismatchedAccounts).toBe(0);
  });
});

describe('statement', () => {
  const line = (
    direction: 'DEBIT' | 'CREDIT',
    amountCents: number,
    leg: StatementLine['leg'],
    counterpartyName: string | null = null,
  ): StatementLine => ({
    entryGroup: `${leg}-${direction}-${amountCents}`,
    paymentId: leg === 'FUNDING' ? null : 'payment-1',
    leg,
    direction,
    amountCents,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    counterpartyName,
  });

  it('carries a running balance down the page', () => {
    const result = statement(
      [
        line('CREDIT', 10_000, 'FUNDING', 'Funding account'),
        line('DEBIT', 2_500, 'AUTHORISE', 'Clearing account'),
        line('CREDIT', 1_000, 'SETTLE', 'Clearing account'),
      ],
      0,
    );
    expect(result.lines.map((entry) => entry.runningCents)).toEqual([10_000, 7_500, 8_500]);
  });

  it('signs each movement by its direction', () => {
    const result = statement([line('DEBIT', 2_500, 'AUTHORISE')], 10_000);
    expect(result.lines[0].changeCents).toBe(-2_500);
    expect(result.lines[0].runningCents).toBe(7_500);
  });

  // The property that makes a truncated window trustworthy.
  it('closes at opening plus the sum of the movements shown', () => {
    const lines = [
      line('CREDIT', 4_000, 'SETTLE'),
      line('DEBIT', 1_500, 'AUTHORISE'),
      line('CREDIT', 700, 'COMPENSATE'),
    ];
    const result = statement(lines, 25_000);
    const movement = result.lines.reduce((sum, entry) => sum + entry.changeCents, 0);
    expect(result.closingCents).toBe(result.openingCents + movement);
    expect(result.closingCents).toBe(28_200);
  });

  it('returns the opening balance unchanged when there are no lines', () => {
    const result = statement([], 4_200);
    expect(result.lines).toEqual([]);
    expect(result.openingCents).toBe(4_200);
    expect(result.closingCents).toBe(4_200);
  });

  // An authorise followed by a compensate must leave the sender exactly where
  // they started - the refund path's whole promise, checked arithmetically.
  it('returns to the starting balance after an authorise is compensated', () => {
    const result = statement(
      [line('DEBIT', 3_300, 'AUTHORISE'), line('CREDIT', 3_300, 'COMPENSATE')],
      9_000,
    );
    expect(result.closingCents).toBe(9_000);
  });
});
