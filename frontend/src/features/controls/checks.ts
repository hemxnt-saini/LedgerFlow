import type { Finding, FindingCode, Severity } from '../../types/api';

/**
 * The five things the control actually proves, written out.
 *
 * The backend reports findings - which is the right shape for an alert, and
 * the wrong shape for a person trying to understand what is being checked. A
 * pass produces no finding at all, so without this list a healthy system
 * shows an empty page and you learn nothing about what it verified.
 */
export interface Check {
  /** Codes that indicate this check failed. */
  codes: FindingCode[];
  name: string;
  proves: string;
}

export const CHECKS: Check[] = [
  {
    codes: ['BALANCE_DRIFT'],
    name: 'Balances match the journal',
    proves:
      "Every account's balance is recomputed from its ledger lines and compared with the stored one. The balance column is a cache; the journal is the truth.",
  },
  {
    codes: ['SYSTEM_NOT_ZERO_SUM'],
    name: 'The books are closed',
    proves:
      'Opening a wallet is funded from the funding account, so every balance added together must come to zero. Any other number means money was created or destroyed.',
  },
  {
    codes: ['CLEARING_MISMATCH'],
    name: 'Clearing holds exactly what is in flight',
    proves:
      'Money between the two saga legs belongs to the clearing account. Its balance must equal the sum of every payment still processing or awaiting refund.',
  },
  {
    codes: ['UNBALANCED_JOURNAL'],
    name: 'Every journal entry is a balanced pair',
    proves:
      'One debit, one credit, same amount, netting to zero. A group that fails this is a half-written transaction.',
  },
  {
    codes: ['READ_MODEL_DRIFT', 'READ_MODEL_LAG'],
    name: 'The read model agrees with the write side',
    proves:
      'Postgres and Redis are compared directly. A disagreement is only a fault when there is no outstanding work to explain it - otherwise it is eventual consistency doing its job, and is reported as a warning.',
  },
];

export interface CheckState extends Check {
  status: Severity;
  findings: Finding[];
}

/** A check with no findings against it passed. */
export function evaluate(findings: Finding[]): CheckState[] {
  return CHECKS.map((check) => {
    const hits = findings.filter((finding) => check.codes.includes(finding.code));
    const status: Severity = hits.some((hit) => hit.severity === 'DRIFT')
      ? 'DRIFT'
      : hits.length > 0
        ? 'WARN'
        : 'OK';
    return { ...check, status, findings: hits };
  });
}
