import { WRITE_URL } from '../lib/config';
import type { ReconciliationResult, ReconciliationRun, RepairResult } from '../types/api';
import { jsonHeaders, request } from './client';

export const getReconciliation = (limit = 20) =>
  request<{ latest: ReconciliationRun | null; history: ReconciliationRun[] }>(
    `${WRITE_URL}/reconciliation?limit=${limit}`,
  );

/** Run the control now rather than waiting for the scheduled pass. */
export const runReconciliation = () =>
  request<ReconciliationResult>(`${WRITE_URL}/reconciliation/run`, { method: 'POST' });

/**
 * Recompute every cached balance from the journal.
 *
 * Separate from detection on purpose: a control that silently fixed what it
 * found would destroy the evidence of how the drift happened.
 */
export const repairBalances = () =>
  request<RepairResult>(`${WRITE_URL}/reconciliation/repair`, { method: 'POST' });

/** Demo only. Moves a balance without posting a journal entry for it. */
export const injectDrift = (driftCents: number) =>
  request<{ accountId: string; accountName: string; driftCents: number }>(
    `${WRITE_URL}/reconciliation/demo/inject-drift`,
    { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ driftCents }) },
  );
