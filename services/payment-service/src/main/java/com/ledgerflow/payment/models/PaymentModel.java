package com.ledgerflow.payment.models;

import com.ledgerflow.payment.domain.PaymentStatus;
import com.ledgerflow.payment.domain.Payments;
import com.ledgerflow.payment.domain.SimulateMode;
import com.ledgerflow.payment.lib.Iso;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class PaymentModel {

  private PaymentModel() {}

  /** @param holdReasons why the risk screen held this payment. Empty otherwise. */
  public record PaymentRow(
      String id,
      String fromAccountId,
      String toAccountId,
      long amountCents,
      String note,
      PaymentStatus status,
      String failureReason,
      SimulateMode simulateMode,
      int attempts,
      Instant nextAttemptAt,
      List<String> holdReasons,
      String correlationId,
      Instant createdAt,
      Instant updatedAt) {}

  public record PaymentDto(
      String id,
      String fromAccountId,
      String toAccountId,
      long amountCents,
      String note,
      PaymentStatus status,
      String failureReason,
      SimulateMode simulateMode,
      int attempts,
      int maxAttempts,
      Instant nextAttemptAt,
      List<String> holdReasons,
      Instant createdAt,
      Instant updatedAt) {}

  public static PaymentDto toPaymentDto(PaymentRow row) {
    return new PaymentDto(
        row.id(),
        row.fromAccountId(),
        row.toAccountId(),
        row.amountCents(),
        row.note(),
        row.status(),
        row.failureReason(),
        row.simulateMode(),
        row.attempts(),
        // Sent alongside the count so a client can render "attempt 2 of 3" without
        // hardcoding the policy.
        Payments.MAX_SETTLE_ATTEMPTS,
        row.nextAttemptAt(),
        row.holdReasons() == null ? List.of() : row.holdReasons(),
        row.createdAt(),
        row.updatedAt());
  }

  /** The event body every payment lifecycle event shares. */
  public static Map<String, Object> toEventBody(PaymentRow row, Instant occurredAt) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("paymentId", row.id());
    body.put("fromAccountId", row.fromAccountId());
    body.put("toAccountId", row.toAccountId());
    body.put("amountCents", row.amountCents());
    body.put("note", row.note());
    body.put("occurredAt", Iso.format(occurredAt));
    return body;
  }
}
