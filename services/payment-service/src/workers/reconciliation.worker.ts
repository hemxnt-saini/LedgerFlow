import { config } from '../config';
import { startPoller, type Poller } from '../lib/poller';
import { runReconciliation } from '../services/reconciliation.service';

/**
 * Re-checks the books on a schedule.
 *
 * Drift that is only detected when someone goes looking is drift that has
 * already been live for a while, so this runs whether anyone is watching or
 * not.
 */
export function startReconciliationWorker(): Poller {
  return startPoller('reconcile', config.reconciliation.intervalMs, async () => {
    await runReconciliation();
  });
}
