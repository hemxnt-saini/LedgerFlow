package com.ledgerflow.payment.workers;

import com.ledgerflow.payment.lib.Log;
import com.ledgerflow.payment.services.ReconciliationService;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Re-checks the books on a schedule.
 *
 * Drift that is only detected when someone goes looking is drift that has
 * already been live for a while, so this runs whether anyone is watching or
 * not.
 */
@Component
public class ReconciliationWorker {

  private final ReconciliationService reconciliation;

  public ReconciliationWorker(ReconciliationService reconciliation) {
    this.reconciliation = reconciliation;
  }

  @Scheduled(fixedDelayString = "${RECONCILE_INTERVAL_MS:15000}")
  public void tick() {
    try {
      reconciliation.runReconciliation();
    } catch (Exception e) {
      Log.error("poller tick failed, retrying next beat", "poller", "reconcile", "err", e);
    }
  }
}
