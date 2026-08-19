package com.ledgerflow.payment.models;

import com.ledgerflow.payment.domain.Reconciliations.Finding;
import com.ledgerflow.payment.domain.Reconciliations.Severity;
import java.time.Instant;
import java.util.List;

public final class ReconciliationModel {

  private ReconciliationModel() {}

  public record ReconciliationRunRow(
      long id,
      Instant startedAt,
      Instant finishedAt,
      Severity status,
      int checkedAccounts,
      long driftCents,
      List<Finding> findings,
      Integer durationMs) {}

  public record ReconciliationRunDto(
      long id,
      Instant startedAt,
      Instant finishedAt,
      Severity status,
      int checkedAccounts,
      long driftCents,
      List<Finding> findings,
      Integer durationMs) {}

  public static ReconciliationRunDto toReconciliationRunDto(ReconciliationRunRow row) {
    return new ReconciliationRunDto(
        row.id(),
        row.startedAt(),
        row.finishedAt(),
        row.status(),
        row.checkedAccounts(),
        row.driftCents(),
        row.findings(),
        row.durationMs());
  }
}
