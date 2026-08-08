import type { Queryable } from '../db/pool';
import { pool } from '../db/pool';
import type {
  AccountSnapshot,
  LedgerTotals,
  ReconciliationReport,
  UnbalancedJournal,
} from '../domain/reconciliation';
import type { ReconciliationRunRow } from '../models/reconciliation.model';

export interface LedgerSnapshot {
  accounts: AccountSnapshot[];
  ledger: Map<string, LedgerTotals>;
  unbalancedJournals: UnbalancedJournal[];
  inFlightCents: number;
  /** True when unpublished events or in-flight payments could explain a lag. */
  hasPendingWork: boolean;
}

/**
 * Reads the raw numbers the control compares.
 *
 * Deliberately its own set of queries rather than reusing the repositories the
 * write path uses - a control that shares the write path's assumptions checks
 * nothing.
 *
 * Every aggregate is cast to bigint: sum() over bigint yields numeric, which
 * pg hands back as a *string*, and a string never equals a number. That
 * produced a false drift alarm before the cast was added.
 */
export async function snapshot(): Promise<LedgerSnapshot> {
  const [accountRows, ledgerRows, journalRows, inFlightRow, pendingRow] =
    await Promise.all([
      pool.query<{ id: string; name: string; balance_cents: number; is_system: boolean }>(
        'SELECT id, name, balance_cents, is_system FROM accounts',
      ),
      pool.query<{ account_id: string; credits: number; debits: number }>(
        `SELECT account_id,
                coalesce(sum(amount_cents) FILTER (WHERE direction = 'CREDIT'), 0)::bigint AS credits,
                coalesce(sum(amount_cents) FILTER (WHERE direction = 'DEBIT'),  0)::bigint AS debits
           FROM ledger_entries GROUP BY account_id`,
      ),
      // Any journal that is not exactly one debit and one credit netting zero.
      pool.query<{ entry_group: string; lines: number; net: number }>(
        `SELECT entry_group, count(*)::int AS lines,
                sum(CASE WHEN direction = 'CREDIT' THEN amount_cents ELSE -amount_cents END)::bigint AS net
           FROM ledger_entries
          GROUP BY entry_group
         HAVING count(*) <> 2
             OR sum(CASE WHEN direction = 'CREDIT' THEN amount_cents ELSE -amount_cents END) <> 0
          LIMIT 50`,
      ),
      pool.query<{ total: number }>(
        `SELECT coalesce(sum(amount_cents), 0)::bigint AS total FROM payments
          WHERE status IN ('PROCESSING','AWAITING_REFUND')`,
      ),
      pool.query<{ unpublished: number; in_flight: number }>(
        `SELECT (SELECT count(*) FROM outbox WHERE published_at IS NULL)::int AS unpublished,
                (SELECT count(*) FROM payments
                  WHERE status IN ('PROCESSING','AWAITING_REFUND'))::int AS in_flight`,
      ),
    ]);

  return {
    accounts: accountRows.rows.map((row) => ({
      id: row.id,
      name: row.name,
      balanceCents: row.balance_cents,
      isSystem: row.is_system,
    })),
    ledger: new Map(
      ledgerRows.rows.map((row) => [
        row.account_id,
        { creditsCents: row.credits, debitsCents: row.debits },
      ]),
    ),
    unbalancedJournals: journalRows.rows.map((row) => ({
      entryGroup: row.entry_group,
      lineCount: row.lines,
      netCents: row.net,
    })),
    inFlightCents: inFlightRow.rows[0].total,
    hasPendingWork:
      pendingRow.rows[0].unpublished > 0 || pendingRow.rows[0].in_flight > 0,
  };
}

export async function insertRun(
  db: Queryable,
  report: ReconciliationReport,
  durationMs: number,
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO reconciliation_runs
       (finished_at, status, checked_accounts, drift_cents, findings, duration_ms)
     VALUES (now(), $1, $2, $3, $4, $5) RETURNING id`,
    [
      report.status,
      report.checkedAccounts,
      report.driftCents,
      JSON.stringify(report.findings),
      durationMs,
    ],
  );
  return rows[0].id;
}

export async function listRuns(limit: number): Promise<ReconciliationRunRow[]> {
  const { rows } = await pool.query<ReconciliationRunRow>(
    'SELECT * FROM reconciliation_runs ORDER BY id DESC LIMIT $1',
    [limit],
  );
  return rows;
}
