import type Redis from 'ioredis';
import { CLEARING_ACCOUNT_ID, enqueueEvent, pool, withTransaction } from './db';
import { startPoller, type Poller } from './poller';
import { log } from './logger';
import {
  reconcile,
  type AccountSnapshot,
  type LedgerTotals,
  type ReconciliationReport,
  type UnbalancedJournal,
} from './reconcile';

const INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS ?? 15_000);

/**
 * Runs the control: pull the raw numbers out of Postgres and Redis, hand them
 * to the pure `reconcile`, record the verdict, and shout if the books do not
 * agree with themselves.
 *
 * Deliberately queried independently of the code that writes the ledger - a
 * control that reuses the write path's assumptions checks nothing.
 */
export async function runReconciliation(
  redis?: Redis,
): Promise<ReconciliationReport & { id: number; durationMs: number }> {
  const startedAt = Date.now();

  const [accountRows, ledgerRows, journalRows, inFlightRow, pendingRow] =
    await Promise.all([
      pool.query<{ id: string; name: string; balance_cents: number; is_system: boolean }>(
        'SELECT id, name, balance_cents, is_system FROM accounts',
      ),
      // Every aggregate is cast: sum() over bigint yields numeric, which pg
      // hands back as a *string*, and a string never equals a number.
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

  const accounts: AccountSnapshot[] = accountRows.rows.map((row) => ({
    id: row.id,
    name: row.name,
    balanceCents: row.balance_cents,
    isSystem: row.is_system,
  }));

  const ledger = new Map<string, LedgerTotals>(
    ledgerRows.rows.map((row) => [
      row.account_id,
      { creditsCents: row.credits, debitsCents: row.debits },
    ]),
  );

  const unbalancedJournals: UnbalancedJournal[] = journalRows.rows.map((row) => ({
    entryGroup: row.entry_group,
    lineCount: row.lines,
    netCents: row.net,
  }));

  // Cross-store check. The reconciler is allowed to look at both sides -
  // that is the whole point of a control - but a disagreement only counts as
  // a fault when there is no outstanding work to explain it.
  let readModel: Map<string, number> | undefined;
  if (redis) {
    try {
      const wallets = accounts.filter((a) => !a.isSystem);
      const pipeline = redis.pipeline();
      for (const account of wallets) pipeline.hget(`account:${account.id}`, 'balanceCents');
      const results = (await pipeline.exec()) ?? [];
      readModel = new Map();
      wallets.forEach((account, index) => {
        const value = results[index]?.[1];
        if (typeof value === 'string') readModel!.set(account.id, Number(value));
      });
    } catch {
      // The read model being unreachable is not a ledger fault. Skip the check.
      readModel = undefined;
    }
  }

  const report = reconcile({
    accounts,
    ledger,
    unbalancedJournals,
    clearingAccountId: CLEARING_ACCOUNT_ID,
    inFlightCents: inFlightRow.rows[0].total,
    readModel,
    readModelMayLag:
      pendingRow.rows[0].unpublished > 0 || pendingRow.rows[0].in_flight > 0,
  });

  const durationMs = Date.now() - startedAt;

  const { rows } = await withTransaction(async (client) => {
    const inserted = await client.query<{ id: number }>(
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

    // Drift goes onto the topic like any other fact, so the monitoring UI and
    // any future alerting consumer learn about it the same way.
    if (report.status !== 'OK') {
      await enqueueEvent(client, 'reconciliation.drift_detected', {
        runId: inserted.rows[0].id,
        reconciliationStatus: report.status,
        driftCents: report.driftCents,
        findingCount: report.findings.length,
        codes: [...new Set(report.findings.map((f) => f.code))],
        occurredAt: new Date().toISOString(),
      });
    }
    return inserted;
  });

  const fields = {
    runId: rows[0].id,
    driftCents: report.driftCents,
    findings: report.findings.length,
    checkedAccounts: report.checkedAccounts,
    durationMs,
  };
  if (report.status === 'DRIFT') {
    log.error('BOOKS DO NOT BALANCE', { ...fields, detail: report.findings });
  } else if (report.status === 'WARN') {
    log.warn('reconciliation warnings (read model catching up)', fields);
  } else {
    log.info('reconciliation ok', fields);
  }

  return { ...report, id: rows[0].id, durationMs };
}

export function startReconciler(redis: Redis): Poller {
  return startPoller('reconcile', INTERVAL_MS, () => runReconciliation(redis).then());
}
