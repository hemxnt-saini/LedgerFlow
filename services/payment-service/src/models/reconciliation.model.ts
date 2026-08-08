import type { Finding, Severity } from '../domain/reconciliation';

export interface ReconciliationRunRow {
  id: number;
  started_at: Date;
  finished_at: Date | null;
  status: Severity;
  checked_accounts: number;
  drift_cents: number;
  findings: Finding[];
  duration_ms: number | null;
}

export interface ReconciliationRunDto {
  id: number;
  startedAt: Date;
  finishedAt: Date | null;
  status: Severity;
  checkedAccounts: number;
  driftCents: number;
  findings: Finding[];
  durationMs: number | null;
}

export const toReconciliationRunDto = (
  row: ReconciliationRunRow,
): ReconciliationRunDto => ({
  id: row.id,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  status: row.status,
  checkedAccounts: row.checked_accounts,
  driftCents: row.drift_cents,
  findings: row.findings,
  durationMs: row.duration_ms,
});
