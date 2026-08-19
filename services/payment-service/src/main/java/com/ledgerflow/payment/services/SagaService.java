package com.ledgerflow.payment.services;

import com.ledgerflow.payment.config.Config;
import com.ledgerflow.payment.domain.Leg;
import com.ledgerflow.payment.domain.PaymentStatus;
import com.ledgerflow.payment.domain.Payments;
import com.ledgerflow.payment.domain.Payments.Account;
import com.ledgerflow.payment.domain.Payments.MoveResult;
import com.ledgerflow.payment.models.PaymentModel;
import com.ledgerflow.payment.models.PaymentModel.PaymentRow;
import com.ledgerflow.payment.repositories.AccountRepository;
import com.ledgerflow.payment.repositories.LedgerRepository;
import com.ledgerflow.payment.repositories.OutboxRepository;
import com.ledgerflow.payment.repositories.PaymentRepository;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;
import org.springframework.stereotype.Service;

/**
 * The two legs of the saga that run away from the request: settlement and its
 * compensating action.
 *
 * Both are called with a transaction already open - by a worker draining a
 * batch, or by the API when someone presses refund - so a leg and its outbox
 * event commit together.
 */
@Service
public class SagaService {

  private static final String CLEARING_ID = Config.SystemAccounts.CLEARING_ID;

  private final AccountRepository accounts;
  private final PaymentRepository payments;
  private final LedgerRepository ledger;
  private final OutboxRepository outbox;

  public SagaService(
      AccountRepository accounts,
      PaymentRepository payments,
      LedgerRepository ledger,
      OutboxRepository outbox) {
    this.accounts = accounts;
    this.payments = payments;
    this.ledger = ledger;
    this.outbox = outbox;
  }

  /**
   * Leg 2 of the saga: move the held funds from clearing to the receiver.
   *
   * Runs in its own transaction, some time after leg 1 - that separation is the
   * entire reason a payment can get stuck, and the reason a compensating action
   * has to exist at all.
   */
  public PaymentStatus settle(PaymentRow row) {
    if (!Payments.canSettle(row.status())) return row.status();

    if (Payments.shouldSimulateFailure(row.simulateMode(), row.attempts())) {
      return retryOrStrand(row, "SETTLEMENT_FAILED_SIMULATED");
    }

    Map<String, Account> locked = accounts.lockMany(List.of(CLEARING_ID, row.toAccountId()));
    Account clearing = locked.get(CLEARING_ID);
    Account receiver = locked.get(row.toAccountId());
    if (clearing == null || receiver == null) return retryOrStrand(row, "RECEIVER_UNAVAILABLE");

    MoveResult move = Payments.moveFunds(clearing, receiver, row.amountCents());
    if (!move.ok()) return retryOrStrand(row, move.failureReason());

    accounts.updateBalance(clearing.id(), move.fromBalanceCents());
    accounts.updateBalance(receiver.id(), move.toBalanceCents());
    ledger.postJournal(row.id(), Leg.SETTLE, move.entries());

    Instant updatedAt = payments.markCompleted(row.id(), row.attempts() + 1);
    Map<String, Object> event = PaymentModel.toEventBody(row, updatedAt);
    event.put("attempts", row.attempts() + 1);
    outbox.enqueue("payment.completed", event);
    return PaymentStatus.COMPLETED;
  }

  /**
   * A failure is not automatically fatal. Most things that break between two
   * services break briefly, so try again with a backoff and only give the money
   * back once the attempts are used up. Compensating on the first hiccup would
   * unwind perfectly good payments.
   */
  private PaymentStatus retryOrStrand(PaymentRow row, String reason) {
    int attempts = row.attempts() + 1;
    if (Payments.isExhausted(attempts)) return strand(row, reason);

    long delay = Payments.backoffMs(attempts, ThreadLocalRandom.current().nextDouble());
    Instant updatedAt = payments.scheduleRetry(row.id(), attempts, reason, delay);

    Map<String, Object> event = PaymentModel.toEventBody(row, updatedAt);
    event.put("failureReason", reason);
    event.put("attempts", attempts);
    event.put("maxAttempts", Payments.MAX_SETTLE_ATTEMPTS);
    event.put("retryInMs", delay);
    outbox.enqueue("payment.settlement_retrying", event);
    return PaymentStatus.PROCESSING;
  }

  /** Out of retries: the money stays in clearing, owed back to the sender. */
  private PaymentStatus strand(PaymentRow row, String reason) {
    Instant updatedAt =
        payments.markStranded(
            row.id(), reason, row.attempts() + 1, Config.Saga.COMPENSATE_DELAY_MS);

    Map<String, Object> event = PaymentModel.toEventBody(row, updatedAt);
    event.put("failureReason", reason);
    event.put("attempts", row.attempts() + 1);
    outbox.enqueue("payment.stuck", event);
    return PaymentStatus.AWAITING_REFUND;
  }

  public PaymentStatus compensate(PaymentRow row) {
    return compensate(row, null);
  }

  /**
   * The compensating action: return stranded funds from clearing to the sender.
   *
   * Shared by the automatic worker, the manual refund endpoint and a rejected
   * review, so all three take exactly the same path and cannot drift apart.
   */
  public PaymentStatus compensate(PaymentRow row, String reason) {
    if (!Payments.canCompensate(row.status())) return row.status();

    Map<String, Account> locked = accounts.lockMany(List.of(CLEARING_ID, row.fromAccountId()));
    Account clearing = locked.get(CLEARING_ID);
    Account sender = locked.get(row.fromAccountId());

    MoveResult move = Payments.moveFunds(clearing, sender, row.amountCents());
    if (!move.ok()) {
      // Clearing not holding the money means the ledger has been tampered with.
      // Refuse loudly rather than invent a balance.
      throw new IllegalStateException(
          "cannot compensate " + row.id() + ": clearing account " + move.failureReason());
    }

    accounts.updateBalance(clearing.id(), move.fromBalanceCents());
    accounts.updateBalance(sender.id(), move.toBalanceCents());
    ledger.postJournal(row.id(), Leg.COMPENSATE, move.entries());

    Instant updatedAt = payments.markRefunded(row.id(), reason);
    Map<String, Object> event = new LinkedHashMap<>(PaymentModel.toEventBody(row, updatedAt));
    if (reason != null) event.put("failureReason", reason);
    outbox.enqueue("payment.refunded", event);
    return PaymentStatus.REFUNDED;
  }
}
