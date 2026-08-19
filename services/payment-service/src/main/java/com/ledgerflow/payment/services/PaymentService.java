package com.ledgerflow.payment.services;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ledgerflow.payment.config.Config;
import com.ledgerflow.payment.db.Tx;
import com.ledgerflow.payment.domain.Leg;
import com.ledgerflow.payment.domain.Limits;
import com.ledgerflow.payment.domain.Limits.AccountLimits;
import com.ledgerflow.payment.domain.Limits.LimitDecision;
import com.ledgerflow.payment.domain.Limits.SpendSoFar;
import com.ledgerflow.payment.domain.PaymentStatus;
import com.ledgerflow.payment.domain.Payments;
import com.ledgerflow.payment.domain.Payments.Account;
import com.ledgerflow.payment.domain.Payments.MoveResult;
import com.ledgerflow.payment.domain.Risk;
import com.ledgerflow.payment.domain.Risk.RiskAssessment;
import com.ledgerflow.payment.domain.Risk.RiskFlag;
import com.ledgerflow.payment.domain.SimulateMode;
import com.ledgerflow.payment.lib.HttpError;
import com.ledgerflow.payment.lib.Log;
import com.ledgerflow.payment.models.LedgerModel;
import com.ledgerflow.payment.models.LedgerModel.LedgerEntryDto;
import com.ledgerflow.payment.models.PaymentModel;
import com.ledgerflow.payment.models.PaymentModel.PaymentDto;
import com.ledgerflow.payment.models.PaymentModel.PaymentRow;
import com.ledgerflow.payment.repositories.AccountRepository;
import com.ledgerflow.payment.repositories.LedgerRepository;
import com.ledgerflow.payment.repositories.OutboxRepository;
import com.ledgerflow.payment.repositories.PaymentRepository;
import com.ledgerflow.payment.repositories.PaymentRepository.InsertPaymentParams;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

@Service
public class PaymentService {

  private static final String CLEARING_ID = Config.SystemAccounts.CLEARING_ID;

  /** @param suppliedKey null when the caller sent no Idempotency-Key header. */
  public record InitiatePaymentInput(
      String fromAccountId,
      String toAccountId,
      long amountCents,
      String note,
      SimulateMode simulateMode,
      String suppliedKey) {}

  /**
   * @param idempotencyKey the key actually used - echoed back so a client can
   *     see a derived one.
   * @param replayed true when this request was answered from the cache, not
   *     executed.
   */
  public record InitiatePaymentResult(
      PaymentDto payment, String idempotencyKey, boolean replayed) {}

  private final Tx tx;
  private final AccountRepository accounts;
  private final PaymentRepository payments;
  private final LedgerRepository ledger;
  private final OutboxRepository outbox;
  private final IdempotencyService idempotency;
  private final SagaService saga;
  private final ObjectMapper mapper;

  public PaymentService(
      Tx tx,
      AccountRepository accounts,
      PaymentRepository payments,
      LedgerRepository ledger,
      OutboxRepository outbox,
      IdempotencyService idempotency,
      SagaService saga,
      ObjectMapper mapper) {
    this.tx = tx;
    this.accounts = accounts;
    this.payments = payments;
    this.ledger = ledger;
    this.outbox = outbox;
    this.idempotency = idempotency;
    this.saga = saga;
    this.mapper = mapper;
  }

  /**
   * Leg 1 of the saga: take the money off the sender and hold it in clearing.
   *
   * Returns as soon as the funds are held. The payment is PROCESSING, not
   * finished - the settlement worker moves it on to the receiver a moment later.
   */
  public InitiatePaymentResult initiatePayment(InitiatePaymentInput input) {
    String note = input.note() == null ? "" : input.note();

    // Every payment gets a key whether the caller sent one or not. No key at all
    // would mean no protection at all, and a randomly generated one would differ
    // on every retry and protect nobody - so an absent key is derived from the
    // request content instead.
    String idempotencyKey =
        input.suppliedKey() != null
            ? input.suppliedKey()
            : Payments.deriveIdempotencyKey(
                input.fromAccountId(), input.toAccountId(), input.amountCents(), note);
    String fingerprint =
        Payments.requestFingerprint(
            input.fromAccountId(), input.toAccountId(), input.amountCents(), note);

    PaymentDto replay = idempotency.findReplay(idempotencyKey, fingerprint);
    if (replay != null) return new InitiatePaymentResult(replay, idempotencyKey, true);

    PaymentDto payment;
    try {
      payment = tx.inTransaction(() -> authorise(input, note));
    } catch (DuplicateKeyException e) {
      // Second line of defence: the UNIQUE constraint on idempotency_key.
      // Catches two identical requests racing past the cache together - the
      // loser's INSERT blocks on the index until the winner commits, then fails,
      // so the row below is guaranteed to be visible.
      if (input.suppliedKey() != null) {
        PaymentRow existing = payments.findByIdempotencyKey(input.suppliedKey());
        if (existing != null) {
          return new InitiatePaymentResult(
              PaymentModel.toPaymentDto(existing), idempotencyKey, true);
        }
      }
      throw e;
    }

    idempotency.remember(idempotencyKey, fingerprint, payment);
    return new InitiatePaymentResult(payment, idempotencyKey, false);
  }

  /** Everything that has to commit together, inside one transaction. */
  private PaymentDto authorise(InitiatePaymentInput input, String note) {
    Map<String, Account> locked =
        accounts.lockMany(List.of(input.fromAccountId(), CLEARING_ID, input.toAccountId()));
    Account sender = locked.get(input.fromAccountId());
    Account clearing = locked.get(CLEARING_ID);
    Account receiver = locked.get(input.toAccountId());
    if (sender == null || receiver == null) throw HttpError.notFound("ACCOUNT_NOT_FOUND");
    if (clearing == null) throw new HttpError(500, "CLEARING_ACCOUNT_MISSING");

    // Spending controls, checked with the sender's row already locked.
    //
    // That ordering is the whole guarantee. Concurrent payments from one
    // account queue on that lock, so each one reads a spend total that
    // already includes every payment committed before it - twenty
    // simultaneous requests against a daily cap let exactly the right
    // number through instead of all of them slipping past a stale read.
    AccountLimits limits = accounts.findLimits(sender.id());
    if (limits == null) throw HttpError.notFound("ACCOUNT_NOT_FOUND");
    SpendSoFar spend =
        accounts.spendSoFar(sender.id(), Config.Controls.VELOCITY_WINDOW_SECONDS);
    LimitDecision decision = Limits.checkLimits(input.amountCents(), limits, spend);

    // A limit breach is a decline, not an error: recorded as a FAILED
    // payment the same way insufficient funds is, so it shows up in history
    // with a reason rather than vanishing into a 4xx.
    MoveResult authorise =
        decision.allowed()
            ? Payments.moveFunds(sender, clearing, input.amountCents())
            : MoveResult.refused(decision.breach().name());

    // Risk screening, after the limits and only if the money can actually
    // move. A hold is not a refusal - the funds are secured in clearing
    // first and a person then decides whether to release them. Reviewing
    // before securing would let the balance be spent elsewhere while
    // someone deliberates.
    RiskAssessment risk =
        authorise.ok()
            ? Risk.assessRisk(
                new Risk.RiskSignals(
                    input.amountCents(),
                    !payments.hasPaidBefore(sender.id(), receiver.id()),
                    spend.recentCount()),
                new Risk.RiskPolicy(
                    Config.Risk.LARGE_AMOUNT_CENTS,
                    Config.Risk.NEW_PAYEE_AMOUNT_CENTS,
                    Config.Risk.RAPID_FIRE_COUNT))
            : new RiskAssessment(false, List.of());

    PaymentStatus status =
        !authorise.ok()
            ? PaymentStatus.FAILED
            : risk.hold() ? PaymentStatus.HELD_FOR_REVIEW : PaymentStatus.PROCESSING;

    List<String> holdReasons = new ArrayList<>();
    for (RiskFlag flag : risk.flags()) holdReasons.add(flag.name());

    // Balances, the payment row, the ledger entries and the outbox event all
    // commit together - or none of them do.
    PaymentRow row =
        payments.insert(
            new InsertPaymentParams(
                sender.id(),
                receiver.id(),
                input.amountCents(),
                input.note(),
                status,
                authorise.ok() ? null : authorise.failureReason(),
                // Only a client-supplied key is persisted. A derived key is a content
                // hash, and the UNIQUE constraint would then permanently block the
                // same payer sending the same payee the same amount ever again.
                input.suppliedKey(),
                input.simulateMode(),
                holdReasons,
                Config.Saga.SETTLE_DELAY_MS,
                Log.currentCorrelationId()));

    Map<String, Object> body = PaymentModel.toEventBody(row, row.createdAt());

    if (!authorise.ok()) {
      Map<String, Object> failed = new LinkedHashMap<>(body);
      failed.put("failureReason", authorise.failureReason());
      outbox.enqueue("payment.failed", failed);
      return PaymentModel.toPaymentDto(row);
    }

    // The authorise leg is identical whether the payment is held or not -
    // the money is in clearing either way. Only what happens next differs.
    accounts.updateBalance(sender.id(), authorise.fromBalanceCents());
    accounts.updateBalance(clearing.id(), authorise.toBalanceCents());
    ledger.postJournal(row.id(), Leg.AUTHORISE, authorise.entries());

    if (risk.hold()) {
      Map<String, Object> held = new LinkedHashMap<>(body);
      held.put("holdReasons", holdReasons);
      outbox.enqueue("payment.held", held);
    } else {
      outbox.enqueue("payment.initiated", body);
    }
    return PaymentModel.toPaymentDto(row);
  }

  public List<PaymentDto> listPayments(String accountId, int limit) {
    List<PaymentDto> dtos = new ArrayList<>();
    for (PaymentRow row : payments.list(accountId, limit)) dtos.add(PaymentModel.toPaymentDto(row));
    return dtos;
  }

  /**
   * A payment plus the ledger legs it produced - the audit trail behind the
   * status. A completed payment shows AUTHORISE then SETTLE; a refunded one
   * shows AUTHORISE then COMPENSATE and never a SETTLE.
   */
  public Map<String, Object> getPaymentWithLedger(String id) {
    PaymentRow row = payments.findById(id);
    if (row == null) throw HttpError.notFound("PAYMENT_NOT_FOUND");

    List<LedgerEntryDto> entries = new ArrayList<>();
    for (LedgerModel.LedgerEntryRow entry : ledger.findByPaymentId(id)) {
      entries.add(LedgerModel.toLedgerEntryDto(entry));
    }

    // The payment's own fields, with the ledger alongside them - one flat
    // object, the shape the wallet's detail modal reads.
    @SuppressWarnings("unchecked")
    Map<String, Object> body =
        mapper.convertValue(PaymentModel.toPaymentDto(row), LinkedHashMap.class);
    body.put("ledger", entries);
    return body;
  }

  /** The review queue: payments whose funds are held pending a decision. */
  public List<PaymentDto> listHeldForReview(int limit) {
    List<PaymentDto> dtos = new ArrayList<>();
    for (PaymentRow row : payments.listHeld(limit)) dtos.add(PaymentModel.toPaymentDto(row));
    return dtos;
  }

  /**
   * Release held funds.
   *
   * Puts the payment back on the ordinary settlement path rather than settling
   * it here, so there is exactly one route to COMPLETED and the retry, backoff
   * and compensation behaviour is the same as for any other payment.
   */
  public PaymentDto approvePayment(String id) {
    return tx.inTransaction(
        () -> {
          PaymentRow row = payments.findByIdForUpdate(id);
          if (row == null) throw HttpError.notFound("PAYMENT_NOT_FOUND");
          if (!Payments.isUnderReview(row.status())) {
            throw HttpError.conflict("NOT_UNDER_REVIEW_FROM_" + row.status());
          }

          var updatedAt = payments.markApproved(id);
          outbox.enqueue("payment.approved", PaymentModel.toEventBody(row, updatedAt));

          return PaymentModel.toPaymentDto(payments.findById(id));
        });
  }

  /**
   * Refuse held funds: the same compensating action a stranded payment uses, so
   * both paths post an identical COMPENSATE journal and cannot drift apart.
   */
  public PaymentDto rejectPayment(String id) {
    return tx.inTransaction(
        () -> {
          PaymentRow row = payments.findByIdForUpdate(id);
          if (row == null) throw HttpError.notFound("PAYMENT_NOT_FOUND");
          if (!Payments.isUnderReview(row.status())) {
            throw HttpError.conflict("NOT_UNDER_REVIEW_FROM_" + row.status());
          }

          saga.compensate(row, Payments.REJECTED_IN_REVIEW);
          return PaymentModel.toPaymentDto(payments.findById(id));
        });
  }

  /**
   * Manual compensation. The worker does this automatically after a few seconds;
   * this only skips the wait. Only stranded money can be refunded - a completed
   * payment arrived, so there is nothing to recover.
   */
  public PaymentDto refundPayment(String id) {
    return tx.inTransaction(
        () -> {
          // Lock the row first so two concurrent refunds cannot both see
          // AWAITING_REFUND.
          PaymentRow original = payments.findByIdForUpdate(id);
          if (original == null) throw HttpError.notFound("PAYMENT_NOT_FOUND");
          if (!Payments.canRefund(original.status())) {
            throw HttpError.conflict("NOT_REFUNDABLE_FROM_" + original.status());
          }

          saga.compensate(original);
          return PaymentModel.toPaymentDto(payments.findById(id));
        });
  }
}
