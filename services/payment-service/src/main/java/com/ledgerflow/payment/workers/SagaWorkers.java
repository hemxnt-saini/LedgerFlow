package com.ledgerflow.payment.workers;

import com.ledgerflow.payment.config.Config;
import com.ledgerflow.payment.db.Tx;
import com.ledgerflow.payment.domain.PaymentStatus;
import com.ledgerflow.payment.lib.Log;
import com.ledgerflow.payment.models.PaymentModel.PaymentRow;
import com.ledgerflow.payment.repositories.PaymentRepository;
import com.ledgerflow.payment.services.SagaService;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * The two background legs of the saga.
 *
 * Settlement moves PROCESSING to COMPLETED, or gives up and marks it
 * AWAITING_REFUND. Compensation then returns stranded money on its own - a
 * stuck payment repays itself without anyone pressing a button; the manual
 * endpoint just skips the wait.
 */
@Component
public class SagaWorkers {

  private final Tx tx;
  private final PaymentRepository payments;
  private final SagaService saga;

  public SagaWorkers(Tx tx, PaymentRepository payments, SagaService saga) {
    this.tx = tx;
    this.payments = payments;
    this.saga = saga;
  }

  /** Leg 2 runner: PROCESSING -> COMPLETED, or -> AWAITING_REFUND. */
  @Scheduled(fixedDelayString = "${SAGA_POLL_MS:300}")
  public void settleDue() {
    drain("settle", PaymentStatus.PROCESSING, saga::settle);
  }

  /** Automatic compensation: AWAITING_REFUND -> REFUNDED. */
  @Scheduled(fixedDelayString = "${SAGA_POLL_MS:300}")
  public void compensateDue() {
    drain("compensate", PaymentStatus.AWAITING_REFUND, saga::compensate);
  }

  /** Claims a batch of due payments in one status and runs `step` on each. */
  private void drain(
      String poller, PaymentStatus status, Function<PaymentRow, PaymentStatus> step) {
    try {
      tx.inTransaction(
          () -> {
            List<PaymentRow> rows = payments.claimDue(status, Config.Saga.BATCH_SIZE);

            for (PaymentRow row : rows) {
              // Background work adopts the correlation id the payment was created
              // with, so a settlement seconds or hours later is still traceable to
              // the request that started it - even though no HTTP request is in
              // flight.
              Map<String, Object> context = new LinkedHashMap<>();
              context.put(
                  "correlationId",
                  row.correlationId() == null ? Log.newCorrelationId() : row.correlationId());
              context.put("paymentId", row.id());

              Log.withContext(
                  context,
                  () -> {
                    PaymentStatus next = step.apply(row);
                    Log.info(
                        "saga transition",
                        "from",
                        row.status(),
                        "to",
                        next,
                        "attempts",
                        row.attempts());
                  });
            }
          });
    } catch (Exception e) {
      Log.error("poller tick failed, retrying next beat", "poller", poller, "err", e);
    }
  }
}
