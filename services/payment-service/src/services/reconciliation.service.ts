import { config } from '../config';
import { withTransaction } from '../db/transaction';
import { reconcile, type ReconciliationReport } from '../domain/reconciliation';
import { HttpError } from '../lib/http-error';
import { log } from '../lib/logger';
import { redis } from '../lib/redis';
import {
  toReconciliationRunDto,
  type ReconciliationRunDto,
} from '../models/reconciliation.model';
import * as outbox from '../repositories/outbox.repository';
import * as runs from '../repositories/reconciliation.repository';

export type ReconciliationResult = ReconciliationReport & {
  id: number;
  durationMs: number;
};

/**
 * Reads the read model's view of every wallet, so the control can compare the
 * two stores. Best-effort: Redis being unreachable is not a ledger fault, so
 * the cross-store check is simply skipped.
 */
async function readModelBalances(
  accountIds: string[],
): Promise<Map<string, number> | undefined> {
  try {
    const pipeline = redis.pipeline();
    for (const id of accountIds) pipeline.hget(`account:${id}`, 'balanceCents');
    const results = (await pipeline.exec()) ?? [];

    const balances = new Map<string, number>();
    accountIds.forEach((id, index) => {
      const value = results[index]?.[1];
      if (typeof value === 'string') balances.set(id, Number(value));
    });
    return balances;
  } catch {
    return undefined;
  }
}

/**
 * Runs the control: pull the raw numbers, hand them to the pure `reconcile`,
 * record the verdict, and shout if the books do not agree with themselves.
 */
export async function runReconciliation(): Promise<ReconciliationResult> {
  const startedAt = Date.now();
  const snapshot = await runs.snapshot();

  const report = reconcile({
    accounts: snapshot.accounts,
    ledger: snapshot.ledger,
    unbalancedJournals: snapshot.unbalancedJournals,
    clearingAccountId: config.systemAccounts.clearingId,
    inFlightCents: snapshot.inFlightCents,
    readModel: await readModelBalances(
      snapshot.accounts.filter((a) => !a.isSystem).map((a) => a.id),
    ),
    // A disagreement only counts as a fault when there is no outstanding work
    // to explain it. Eventual consistency is the design, not a defect.
    readModelMayLag: snapshot.hasPendingWork,
  });

  const durationMs = Date.now() - startedAt;

  const runId = await withTransaction(async (client) => {
    const id = await runs.insertRun(client, report, durationMs);
    // Drift goes onto the topic like any other fact, so a future alerting
    // consumer learns about it the same way everything else does.
    if (report.status !== 'OK') {
      await outbox.enqueue(client, 'reconciliation.drift_detected', {
        runId: id,
        reconciliationStatus: report.status,
        driftCents: report.driftCents,
        findingCount: report.findings.length,
        codes: [...new Set(report.findings.map((finding) => finding.code))],
        occurredAt: new Date().toISOString(),
      });
    }
    return id;
  });

  const fields = {
    runId,
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

  return { ...report, id: runId, durationMs };
}

export interface RepairResult {
  repaired: { accountId: string; accountName: string; fromCents: number; toCents: number }[];
  /** Total absolute correction applied, in cents. */
  correctedCents: number;
}

/**
 * Remediation: recompute every cached balance from the journal.
 *
 * Detecting drift and fixing it are separate jobs, and this is the fix. It is
 * safe precisely because the journal is append-only - the ledger is never the
 * thing that needs repairing, only the balance cached alongside it, so the
 * correct value is always recoverable by adding the lines back up.
 *
 * Nothing is posted to the ledger here. Writing a correcting journal entry
 * would be wrong: no money moved, a number was simply stale.
 */
export async function repairBalances(): Promise<RepairResult> {
  return withTransaction(async (client) => {
    const drifted = await runs.findDrifted(client);
    for (const account of drifted) {
      await runs.setBalance(client, account.id, account.ledgerCents);
    }

    const result: RepairResult = {
      repaired: drifted.map((account) => ({
        accountId: account.id,
        accountName: account.name,
        fromCents: account.cachedCents,
        toCents: account.ledgerCents,
      })),
      correctedCents: drifted.reduce(
        (sum, account) => sum + Math.abs(account.cachedCents - account.ledgerCents),
        0,
      ),
    };

    if (drifted.length > 0) {
      log.warn('repaired cached balances from the journal', {
        accounts: drifted.length,
        correctedCents: result.correctedCents,
      });
    }
    return result;
  });
}

/**
 * Breaks the books on purpose, so the control can be watched catching it.
 *
 * Deliberately changes a balance without a journal entry, which is the one
 * thing the whole double-entry design is meant to make impossible through the
 * API. Reachable only when demo endpoints are enabled.
 */
export async function injectDrift(driftCents: number): Promise<{
  accountId: string;
  accountName: string;
  driftCents: number;
}> {
  const account = await withTransaction((client) => runs.injectDrift(client, driftCents));
  if (!account) throw new HttpError(409, 'NO_ACCOUNTS_TO_DRIFT');

  log.warn('DEMO: injected balance drift', {
    accountId: account.id,
    driftCents,
  });
  return { accountId: account.id, accountName: account.name, driftCents };
}

/** The latest verdict plus recent history, so drift has a first sighting. */
export async function listRuns(limit: number): Promise<{
  latest: ReconciliationRunDto | null;
  history: ReconciliationRunDto[];
}> {
  const rows = await runs.listRuns(limit);
  return {
    latest: rows[0] ? toReconciliationRunDto(rows[0]) : null,
    history: rows.map(toReconciliationRunDto),
  };
}
