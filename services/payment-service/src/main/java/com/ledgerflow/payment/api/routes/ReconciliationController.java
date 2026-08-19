package com.ledgerflow.payment.api.routes;

import com.ledgerflow.payment.api.JsonBody;
import com.ledgerflow.payment.api.Validation;
import com.ledgerflow.payment.config.Config;
import com.ledgerflow.payment.domain.Payments;
import com.ledgerflow.payment.lib.HttpError;
import com.ledgerflow.payment.services.ReconciliationService;
import com.ledgerflow.payment.services.ReconciliationService.InjectedDrift;
import com.ledgerflow.payment.services.ReconciliationService.ReconciliationResult;
import com.ledgerflow.payment.services.ReconciliationService.RepairResult;
import com.ledgerflow.payment.services.ReconciliationService.Runs;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ReconciliationController {

  private final ReconciliationService reconciliation;
  private final JsonBody jsonBody;

  public ReconciliationController(ReconciliationService reconciliation, JsonBody jsonBody) {
    this.reconciliation = reconciliation;
    this.jsonBody = jsonBody;
  }

  /** The latest verdict plus recent history, so drift has a first sighting. */
  @GetMapping("/reconciliation")
  public Runs list(@RequestParam(required = false) String limit) {
    return reconciliation.listRuns(
        Validation.clampLimit(limit, 20, Config.Limits.RECONCILIATION_PAGE_SIZE));
  }

  /** Run the control now rather than waiting for the next scheduled pass. */
  @PostMapping("/reconciliation/run")
  public ReconciliationResult run() {
    return reconciliation.runReconciliation();
  }

  /**
   * Remediation: recompute every cached balance from the journal.
   *
   * Detection and repair are separate operations on purpose. A control that
   * silently fixed what it found would destroy the evidence of how the drift
   * happened, so this is a decision someone makes after reading the findings.
   */
  @PostMapping("/reconciliation/repair")
  public RepairResult repair() {
    return reconciliation.repairBalances();
  }

  /**
   * Breaks a balance on purpose so the control can be seen catching it.
   * 404s unless demo endpoints are enabled - see `Config.Demo`.
   */
  @PostMapping("/reconciliation/demo/inject-drift")
  public InjectedDrift injectDrift(HttpServletRequest request) {
    if (!Config.Demo.ENABLED) throw HttpError.notFound("NOT_FOUND");
    Long wanted = asNumber(jsonBody.read(request).get("driftCents"));
    long driftCents = wanted != null && wanted != 0 ? wanted : 5_000;
    return reconciliation.injectDrift(driftCents);
  }

  /** `Number(value)`, so a numeric string counts - this endpoint always did. */
  private static Long asNumber(Object value) {
    if (value instanceof String text) {
      try {
        return Payments.asSafeInteger(Double.parseDouble(text.trim()));
      } catch (NumberFormatException e) {
        return null;
      }
    }
    return Payments.asSafeInteger(value);
  }
}
