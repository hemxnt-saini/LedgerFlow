import {
  ledgerBalance,
  reconcile,
  type AccountSnapshot,
  type LedgerTotals,
  type ReconciliationInput,
} from './reconciliation';

const CLEARING = 'clearing';
const FUNDING = 'funding';

const account = (
  id: string,
  balanceCents: number,
  isSystem = false,
): AccountSnapshot => ({ id, name: id, balanceCents, isSystem });

const totals = (creditsCents: number, debitsCents: number): LedgerTotals => ({
  creditsCents,
  debitsCents,
});

/**
 * A healthy world: funding issued 10,500 into two wallets, Alice then paid Bob
 * 2,500. Every balance is explained by the ledger and the books sum to zero.
 */
function healthy(): ReconciliationInput {
  return {
    accounts: [
      account('alice', 7_500),
      account('bob', 3_000),
      account(CLEARING, 0, true),
      account(FUNDING, -10_500, true),
    ],
    ledger: new Map([
      ['alice', totals(10_000, 2_500)],
      ['bob', totals(3_000, 0)],
      [CLEARING, totals(2_500, 2_500)],
      [FUNDING, totals(0, 10_500)],
    ]),
    unbalancedJournals: [],
    clearingAccountId: CLEARING,
    inFlightCents: 0,
    readModelMayLag: false,
  };
}

describe('a healthy ledger', () => {
  it('reports OK with nothing to say', () => {
    const report = reconcile(healthy());
    expect(report.status).toBe('OK');
    expect(report.findings).toEqual([]);
    expect(report.driftCents).toBe(0);
    expect(report.checkedAccounts).toBe(4);
  });

  it('is still OK mid-saga, with money sitting in clearing', () => {
    const input = healthy();
    // Alice authorised 1,000 that has not settled yet.
    input.accounts = [
      account('alice', 6_500),
      account('bob', 3_000),
      account(CLEARING, 1_000, true),
      account(FUNDING, -10_500, true),
    ];
    input.ledger = new Map([
      ['alice', totals(10_000, 3_500)],
      ['bob', totals(3_000, 0)],
      [CLEARING, totals(3_500, 2_500)],
      [FUNDING, totals(0, 10_500)],
    ]);
    input.inFlightCents = 1_000;

    expect(reconcile(input).status).toBe('OK');
  });
});

describe('ledgerBalance', () => {
  it('is credits minus debits, and zero for an account with no history', () => {
    expect(ledgerBalance(totals(500, 200))).toBe(300);
    expect(ledgerBalance(undefined)).toBe(0);
  });
});

describe('balance drift', () => {
  it('catches a balance edited without a matching ledger entry', () => {
    const input = healthy();
    // Somebody added 100 to Alice directly. The ledger does not know.
    input.accounts[0] = account('alice', 7_600);

    const report = reconcile(input);
    const finding = report.findings.find((f) => f.code === 'BALANCE_DRIFT');
    expect(finding).toMatchObject({
      severity: 'DRIFT',
      accountId: 'alice',
      expectedCents: 7_500,
      actualCents: 7_600,
      driftCents: 100,
    });
    expect(report.status).toBe('DRIFT');
  });

  it('catches a ledger entry written without updating the balance', () => {
    const input = healthy();
    input.ledger.set('bob', totals(4_000, 0));

    const finding = reconcile(input).findings.find((f) => f.code === 'BALANCE_DRIFT');
    expect(finding).toMatchObject({ accountId: 'bob', expectedCents: 4_000, actualCents: 3_000 });
  });

  it('reports drift for every affected account and sums the magnitude', () => {
    const input = healthy();
    input.accounts[0] = account('alice', 7_400); // -100
    input.accounts[1] = account('bob', 3_050); //  +50

    const report = reconcile(input);
    expect(report.findings.filter((f) => f.code === 'BALANCE_DRIFT')).toHaveLength(2);
    // Magnitudes, not a net that could cancel out to a comfortable zero.
    expect(report.driftCents).toBeGreaterThanOrEqual(150);
  });
});

describe('the system must sum to zero', () => {
  it('catches money invented out of nothing', () => {
    const input = healthy();
    // Consistent with its own ledger, but funding never issued it.
    input.accounts.push(account('mallory', 1_000_000));
    input.ledger.set('mallory', totals(1_000_000, 0));

    const report = reconcile(input);
    expect(report.findings.map((f) => f.code)).toContain('SYSTEM_NOT_ZERO_SUM');
    expect(report.findings.find((f) => f.code === 'SYSTEM_NOT_ZERO_SUM')).toMatchObject({
      actualCents: 1_000_000,
    });
  });

  it('is satisfied when funding covers exactly what exists', () => {
    expect(reconcile(healthy()).findings.map((f) => f.code)).not.toContain(
      'SYSTEM_NOT_ZERO_SUM',
    );
  });
});

describe('the clearing account', () => {
  it('catches money stranded in clearing with no payment to explain it', () => {
    const input = healthy();
    input.accounts[2] = account(CLEARING, 900, true);
    input.ledger.set(CLEARING, totals(3_400, 2_500));
    input.accounts[3] = account(FUNDING, -11_400, true);
    input.ledger.set(FUNDING, totals(0, 11_400));
    input.inFlightCents = 0; // nothing in flight, yet clearing holds 900

    const finding = reconcile(input).findings.find((f) => f.code === 'CLEARING_MISMATCH');
    expect(finding).toMatchObject({ expectedCents: 0, actualCents: 900, driftCents: 900 });
  });

  it('catches an in-flight payment whose money is not being held', () => {
    const input = healthy();
    input.inFlightCents = 2_000; // claims to be holding 2,000, holds 0

    expect(reconcile(input).findings.find((f) => f.code === 'CLEARING_MISMATCH')).toMatchObject({
      expectedCents: 2_000,
      actualCents: 0,
    });
  });
});

describe('double entry itself', () => {
  it('catches a journal that is not a balanced pair', () => {
    const input = healthy();
    input.unbalancedJournals = [{ entryGroup: 'j1', lineCount: 1, netCents: -500 }];

    const report = reconcile(input);
    expect(report.status).toBe('DRIFT');
    expect(report.findings.find((f) => f.code === 'UNBALANCED_JOURNAL')?.detail).toContain('j1');
    expect(report.driftCents).toBe(500);
  });
});

describe('the read model', () => {
  it('says nothing when it agrees', () => {
    const input = healthy();
    input.readModel = new Map([
      ['alice', 7_500],
      ['bob', 3_000],
    ]);
    expect(reconcile(input).status).toBe('OK');
  });

  it('is a warning, not a fault, while work is still in flight', () => {
    const input = healthy();
    input.readModel = new Map([['alice', 9_000]]);
    input.readModelMayLag = true;

    const report = reconcile(input);
    expect(report.status).toBe('WARN');
    expect(report.findings[0].code).toBe('READ_MODEL_LAG');
    // Lag is expected under CQRS, so it must not be counted as lost money.
    expect(report.driftCents).toBe(0);
  });

  it('is a fault once there is nothing left to explain it', () => {
    const input = healthy();
    input.readModel = new Map([['alice', 9_000]]);
    input.readModelMayLag = false;

    const report = reconcile(input);
    expect(report.status).toBe('DRIFT');
    expect(report.findings[0].code).toBe('READ_MODEL_DRIFT');
    expect(report.driftCents).toBe(1_500);
  });

  it('ignores system accounts, which are never projected', () => {
    const input = healthy();
    input.readModel = new Map([['alice', 7_500], ['bob', 3_000]]);
    // Clearing and funding are absent from the read model on purpose.
    expect(reconcile(input).status).toBe('OK');
  });

  it('is skipped entirely when no read model is supplied', () => {
    const input = healthy();
    delete input.readModel;
    expect(reconcile(input).status).toBe('OK');
  });
});

describe('severity', () => {
  it('lets a real fault outrank a mere warning', () => {
    const input = healthy();
    input.readModel = new Map([['alice', 9_000]]);
    input.readModelMayLag = true; // WARN
    input.unbalancedJournals = [{ entryGroup: 'j1', lineCount: 3, netCents: 1 }]; // DRIFT

    expect(reconcile(input).status).toBe('DRIFT');
  });
});
