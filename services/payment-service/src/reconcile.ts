/**
 * Pure reconciliation logic: the control that proves the books are intact.
 *
 * An account's `balance_cents` is a denormalised cache. The ledger is the
 * truth. Nothing stops the two drifting apart - a bug, a partial write, a
 * hand-edited row - and a payments system that cannot detect that is a
 * payments system that will one day be quietly wrong. So an independent pass
 * recomputes every balance from the ledger and compares.
 *
 * Zero imports of express/pg/ioredis/kafkajs. The caller does the querying and
 * hands over plain data; every rule below is a pure function of that data.
 */

export type Severity = 'OK' | 'WARN' | 'DRIFT';

export type FindingCode =
  /** An account's cached balance disagrees with its ledger history. */
  | 'BALANCE_DRIFT'
  /** All balances together no longer sum to zero: money entered or left. */
  | 'SYSTEM_NOT_ZERO_SUM'
  /** The clearing account is not holding exactly what is in flight. */
  | 'CLEARING_MISMATCH'
  /** A journal entry is not a balanced pair of lines. */
  | 'UNBALANCED_JOURNAL'
  /** The read model disagrees with the write side and cannot blame lag. */
  | 'READ_MODEL_DRIFT'
  /** The read model disagrees, but there is unfinished work to explain it. */
  | 'READ_MODEL_LAG';

export interface Finding {
  code: FindingCode;
  severity: Severity;
  detail: string;
  accountId?: string;
  accountName?: string;
  expectedCents?: number;
  actualCents?: number;
  driftCents?: number;
}

export interface AccountSnapshot {
  id: string;
  name: string;
  balanceCents: number;
  isSystem: boolean;
}

export interface LedgerTotals {
  creditsCents: number;
  debitsCents: number;
}

/** A journal entry that failed the "exactly one debit, one credit" rule. */
export interface UnbalancedJournal {
  entryGroup: string;
  lineCount: number;
  netCents: number;
}

export interface ReconciliationInput {
  accounts: AccountSnapshot[];
  /** accountId -> summed ledger lines. Absent means the account has none. */
  ledger: Map<string, LedgerTotals>;
  unbalancedJournals: UnbalancedJournal[];
  clearingAccountId: string;
  /** Sum of every payment still PROCESSING or AWAITING_REFUND. */
  inFlightCents: number;
  /** accountId -> balance according to Redis. Omit to skip the check. */
  readModel?: Map<string, number>;
  /**
   * True when there is unpublished or unsettled work, so a read model that
   * disagrees is merely behind rather than wrong. Eventual consistency is
   * the design, so it must not be reported as a fault.
   */
  readModelMayLag: boolean;
}

export interface ReconciliationReport {
  status: Severity;
  findings: Finding[];
  checkedAccounts: number;
  /** Total absolute disagreement found, in cents. Zero is the only good number. */
  driftCents: number;
}

/** Ledger truth for one account: what it received minus what it sent. */
export const ledgerBalance = (totals: LedgerTotals | undefined): number =>
  (totals?.creditsCents ?? 0) - (totals?.debitsCents ?? 0);

export function reconcile(input: ReconciliationInput): ReconciliationReport {
  const findings: Finding[] = [];
  let driftCents = 0;

  const drift = (finding: Finding) => {
    findings.push(finding);
    driftCents += Math.abs(finding.driftCents ?? 0);
  };

  // 1. Every account's cached balance must equal its ledger history.
  for (const account of input.accounts) {
    const expected = ledgerBalance(input.ledger.get(account.id));
    if (expected !== account.balanceCents) {
      drift({
        code: 'BALANCE_DRIFT',
        severity: 'DRIFT',
        detail: `${account.name} balance does not match its ledger history`,
        accountId: account.id,
        accountName: account.name,
        expectedCents: expected,
        actualCents: account.balanceCents,
        driftCents: account.balanceCents - expected,
      });
    }
  }

  // 2. Because opening a wallet is funded from the funding account, the whole
  //    system is a closed set of books: every balance added together is zero.
  //    Any other number means money was created or destroyed.
  const systemTotal = input.accounts.reduce((sum, a) => sum + a.balanceCents, 0);
  if (systemTotal !== 0) {
    drift({
      code: 'SYSTEM_NOT_ZERO_SUM',
      severity: 'DRIFT',
      detail: 'All balances together do not sum to zero - money was created or destroyed',
      expectedCents: 0,
      actualCents: systemTotal,
      driftCents: systemTotal,
    });
  }

  // 3. The clearing account holds in-flight money and nothing else.
  const clearing = input.accounts.find((a) => a.id === input.clearingAccountId);
  if (clearing && clearing.balanceCents !== input.inFlightCents) {
    drift({
      code: 'CLEARING_MISMATCH',
      severity: 'DRIFT',
      detail: 'Clearing account is not holding exactly the in-flight payments',
      accountId: clearing.id,
      accountName: clearing.name,
      expectedCents: input.inFlightCents,
      actualCents: clearing.balanceCents,
      driftCents: clearing.balanceCents - input.inFlightCents,
    });
  }

  // 4. Double entry itself: each journal is one debit and one credit, netting
  //    to zero. A group that fails this is a half-written transaction.
  for (const journal of input.unbalancedJournals) {
    drift({
      code: 'UNBALANCED_JOURNAL',
      severity: 'DRIFT',
      detail: `Journal ${journal.entryGroup} has ${journal.lineCount} lines netting ${journal.netCents}`,
      driftCents: journal.netCents,
    });
  }

  // 5. Cross-store: does the read model agree? Only a fault if nothing is
  //    still in flight to explain it.
  if (input.readModel) {
    for (const account of input.accounts) {
      if (account.isSystem) continue; // not projected into the read model
      const projected = input.readModel.get(account.id);
      if (projected === undefined || projected === account.balanceCents) continue;

      const lagging = input.readModelMayLag;
      findings.push({
        code: lagging ? 'READ_MODEL_LAG' : 'READ_MODEL_DRIFT',
        severity: lagging ? 'WARN' : 'DRIFT',
        detail: lagging
          ? `${account.name} read model is behind, with work still in flight`
          : `${account.name} read model disagrees with nothing left to explain it`,
        accountId: account.id,
        accountName: account.name,
        expectedCents: account.balanceCents,
        actualCents: projected,
        driftCents: projected - account.balanceCents,
      });
      if (!lagging) driftCents += Math.abs(projected - account.balanceCents);
    }
  }

  const status: Severity = findings.some((f) => f.severity === 'DRIFT')
    ? 'DRIFT'
    : findings.some((f) => f.severity === 'WARN')
      ? 'WARN'
      : 'OK';

  return { status, findings, checkedAccounts: input.accounts.length, driftCents };
}
