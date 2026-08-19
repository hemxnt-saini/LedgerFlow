package com.ledgerflow.payment.domain;

import static com.ledgerflow.payment.domain.Payments.MAX_SETTLE_ATTEMPTS;
import static com.ledgerflow.payment.domain.Payments.backoffMs;
import static com.ledgerflow.payment.domain.Payments.canRefund;
import static com.ledgerflow.payment.domain.Payments.canSettle;
import static com.ledgerflow.payment.domain.Payments.canTransition;
import static com.ledgerflow.payment.domain.Payments.deriveIdempotencyKey;
import static com.ledgerflow.payment.domain.Payments.isDerivedKey;
import static com.ledgerflow.payment.domain.Payments.isExhausted;
import static com.ledgerflow.payment.domain.Payments.isTerminal;
import static com.ledgerflow.payment.domain.Payments.isValidAmount;
import static com.ledgerflow.payment.domain.Payments.moveFunds;
import static com.ledgerflow.payment.domain.Payments.requestFingerprint;
import static com.ledgerflow.payment.domain.Payments.shouldSimulateFailure;
import static org.assertj.core.api.Assertions.assertThat;

import com.ledgerflow.payment.domain.Payments.Account;
import com.ledgerflow.payment.domain.Payments.LedgerEntry;
import com.ledgerflow.payment.domain.Payments.MoveResult;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.IntStream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.junit.jupiter.params.provider.ValueSource;

class PaymentsTest {

  private static Account account(String id, long balanceCents) {
    return new Account(id, balanceCents);
  }

  private static Account alice() {
    return account("alice", 10_000);
  }

  private static Account bob() {
    return account("bob", 500);
  }

  private static Account clearing() {
    return account("clearing", 0);
  }

  private static MoveResult applied(MoveResult result) {
    if (!result.ok()) {
      throw new AssertionError("expected a successful move, got " + result.failureReason());
    }
    return result;
  }

  @Nested
  @DisplayName("moveFunds")
  class MoveFunds {

    @Test
    @DisplayName("moves money and writes one debit + one credit")
    void movesMoney() {
      assertThat(moveFunds(alice(), bob(), 2_500))
          .isEqualTo(
              new MoveResult(
                  true,
                  7_500,
                  3_000,
                  List.of(
                      new LedgerEntry("alice", Direction.DEBIT, 2_500),
                      new LedgerEntry("bob", Direction.CREDIT, 2_500)),
                  null));
    }

    @Test
    @DisplayName("conserves total money")
    void conservesMoney() {
      MoveResult result = applied(moveFunds(alice(), bob(), 2_500));
      assertThat(result.fromBalanceCents() + result.toBalanceCents()).isEqualTo(10_500);
    }

    @Test
    @DisplayName("refuses to spend money that is not there")
    void refusesOverspend() {
      assertThat(moveFunds(bob(), alice(), 501))
          .isEqualTo(MoveResult.refused(Payments.INSUFFICIENT_FUNDS));
    }

    @Test
    @DisplayName("allows spending the exact balance down to zero")
    void allowsExactBalance() {
      MoveResult result = applied(moveFunds(bob(), alice(), 500));
      assertThat(result.fromBalanceCents()).isZero();
      assertThat(result.toBalanceCents()).isEqualTo(10_500);
    }

    @Test
    @DisplayName("rejects a self-transfer")
    void rejectsSelfTransfer() {
      assertThat(moveFunds(alice(), alice(), 100))
          .isEqualTo(MoveResult.refused(Payments.SAME_ACCOUNT));
    }

    @ParameterizedTest(name = "rejects amount {0}")
    @ValueSource(longs = {0, -1, Long.MIN_VALUE, Payments.MAX_SAFE_INTEGER + 2})
    void rejectsInvalidAmounts(long amount) {
      assertThat(moveFunds(alice(), bob(), amount))
          .isEqualTo(MoveResult.refused(Payments.INVALID_AMOUNT));
    }

    @Test
    @DisplayName("rejects amounts that are not whole numbers, or not numbers at all")
    void rejectsNonIntegerAmounts() {
      // The wire-facing overload: a JSON value that is not a whole number in
      // the safe range is not an amount, whatever type it arrived as.
      assertThat(isValidAmount((Object) "100")).isFalse();
      assertThat(isValidAmount((Object) 1.5)).isFalse();
      assertThat(isValidAmount((Object) Double.NaN)).isFalse();
      assertThat(isValidAmount((Object) Double.POSITIVE_INFINITY)).isFalse();
      assertThat(isValidAmount((Object) null)).isFalse();
      assertThat(isValidAmount((Object) (Payments.MAX_SAFE_INTEGER + 2))).isFalse();
      assertThat(isValidAmount((Object) 1)).isTrue();
      // 2500.0 is the same JSON number as 2500, so it is a valid amount.
      assertThat(isValidAmount((Object) 2_500.0)).isTrue();
    }
  }

  // The saga is three applications of moveFunds. These tests walk each path end
  // to end and assert the thing that actually matters: the books balance and
  // nobody's money vanishes.
  @Nested
  @DisplayName("the payment saga")
  class Saga {

    private static final long AMOUNT = 2_500;

    @Test
    @DisplayName("happy path: sender -> clearing -> receiver, clearing left empty")
    void happyPath() {
      MoveResult authorise = applied(moveFunds(alice(), clearing(), AMOUNT));
      assertThat(authorise.fromBalanceCents()).isEqualTo(7_500);
      assertThat(authorise.toBalanceCents()).isEqualTo(AMOUNT); // held in clearing

      MoveResult settle =
          applied(moveFunds(account("clearing", authorise.toBalanceCents()), bob(), AMOUNT));
      assertThat(settle.fromBalanceCents()).isZero(); // clearing drained
      assertThat(settle.toBalanceCents()).isEqualTo(3_000);

      // Money is conserved across the whole saga.
      assertThat(authorise.fromBalanceCents() + settle.toBalanceCents()).isEqualTo(10_500);
    }

    @Test
    @DisplayName("mid-saga, the money is in clearing - not lost")
    void midSagaMoneyIsInClearing() {
      MoveResult authorise = applied(moveFunds(alice(), clearing(), AMOUNT));
      long total =
          authorise.fromBalanceCents() + authorise.toBalanceCents() + bob().balanceCents();
      assertThat(total).isEqualTo(10_500);
    }

    @Test
    @DisplayName("every leg writes a balanced debit/credit pair")
    void everyLegIsBalanced() {
      List<MoveResult> legs =
          List.of(
              applied(moveFunds(alice(), clearing(), AMOUNT)),
              applied(moveFunds(account("clearing", AMOUNT), bob(), AMOUNT)),
              applied(moveFunds(account("clearing", AMOUNT), alice(), AMOUNT)));
      for (MoveResult leg : legs) {
        LedgerEntry debit = leg.entries().get(0);
        LedgerEntry credit = leg.entries().get(1);
        assertThat(debit.direction()).isEqualTo(Direction.DEBIT);
        assertThat(credit.direction()).isEqualTo(Direction.CREDIT);
        assertThat(debit.amountCents()).isEqualTo(credit.amountCents());
      }
    }

    @Test
    @DisplayName("compensation returns the sender to exactly where they started")
    void compensationRestoresSender() {
      Account start = alice();
      MoveResult authorise = applied(moveFunds(start, clearing(), AMOUNT));
      // Settlement fails, so instead of clearing -> receiver we run
      // clearing -> sender.
      MoveResult compensate =
          applied(
              moveFunds(
                  account("clearing", authorise.toBalanceCents()),
                  account("alice", authorise.fromBalanceCents()),
                  AMOUNT));

      assertThat(compensate.fromBalanceCents()).isZero(); // clearing drained
      assertThat(compensate.toBalanceCents()).isEqualTo(start.balanceCents());
    }

    @Test
    @DisplayName("a refunded payment leaves the receiver untouched")
    void refundLeavesReceiverUntouched() {
      Account receiver = bob();
      applied(moveFunds(alice(), clearing(), AMOUNT));
      applied(moveFunds(account("clearing", AMOUNT), alice(), AMOUNT));
      assertThat(receiver.balanceCents()).isEqualTo(500);
    }

    @Test
    @DisplayName("cannot authorise more than the sender has, so nothing enters clearing")
    void cannotAuthoriseMoreThanHeld() {
      assertThat(moveFunds(bob(), clearing(), 999_999))
          .isEqualTo(MoveResult.refused(Payments.INSUFFICIENT_FUNDS));
    }
  }

  @Nested
  @DisplayName("lifecycle")
  class Lifecycle {

    @Test
    @DisplayName("only a PROCESSING payment can be settled")
    void onlyProcessingSettles() {
      assertThat(canSettle(PaymentStatus.PROCESSING)).isTrue();
      for (PaymentStatus status :
          List.of(
              PaymentStatus.COMPLETED,
              PaymentStatus.FAILED,
              PaymentStatus.AWAITING_REFUND,
              PaymentStatus.REFUNDED)) {
        assertThat(canSettle(status)).isFalse();
      }
    }

    @Test
    @DisplayName("only stranded money can be refunded")
    void onlyStrandedRefunds() {
      assertThat(canRefund(PaymentStatus.AWAITING_REFUND)).isTrue();
      // A completed payment arrived. There is nothing to recover.
      assertThat(canRefund(PaymentStatus.COMPLETED)).isFalse();
      assertThat(canRefund(PaymentStatus.PROCESSING)).isFalse();
      assertThat(canRefund(PaymentStatus.FAILED)).isFalse();
      assertThat(canRefund(PaymentStatus.REFUNDED)).isFalse();
    }

    @Test
    @DisplayName("knows which states are the end of the road")
    void knowsTerminalStates() {
      assertThat(isTerminal(PaymentStatus.COMPLETED)).isTrue();
      assertThat(isTerminal(PaymentStatus.FAILED)).isTrue();
      assertThat(isTerminal(PaymentStatus.REFUNDED)).isTrue();
      assertThat(isTerminal(PaymentStatus.PROCESSING)).isFalse();
      assertThat(isTerminal(PaymentStatus.AWAITING_REFUND)).isFalse();
    }

    @Test
    @DisplayName("allows exactly the legal transitions")
    void allowsLegalTransitions() {
      assertThat(canTransition(PaymentStatus.PROCESSING, PaymentStatus.COMPLETED)).isTrue();
      assertThat(canTransition(PaymentStatus.PROCESSING, PaymentStatus.AWAITING_REFUND)).isTrue();
      assertThat(canTransition(PaymentStatus.AWAITING_REFUND, PaymentStatus.REFUNDED)).isTrue();
    }

    @Test
    @DisplayName("refuses everything else, including going backwards")
    void refusesEverythingElse() {
      List<PaymentStatus> all =
          List.of(
              PaymentStatus.PROCESSING,
              PaymentStatus.COMPLETED,
              PaymentStatus.FAILED,
              PaymentStatus.AWAITING_REFUND,
              PaymentStatus.REFUNDED);
      Set<String> legal =
          new HashSet<>(
              List.of(
                  "PROCESSING->COMPLETED",
                  "PROCESSING->AWAITING_REFUND",
                  "AWAITING_REFUND->REFUNDED"));
      for (PaymentStatus from : all) {
        for (PaymentStatus to : all) {
          assertThat(canTransition(from, to)).isEqualTo(legal.contains(from + "->" + to));
        }
      }
    }

    @ParameterizedTest
    @EnumSource(
        value = PaymentStatus.class,
        names = {"COMPLETED", "FAILED", "REFUNDED"})
    @DisplayName("never lets a terminal payment move again")
    void terminalNeverMoves(PaymentStatus status) {
      assertThat(canSettle(status)).isFalse();
      assertThat(canRefund(status)).isFalse();
    }
  }

  @Nested
  @DisplayName("the retry policy")
  class RetryPolicy {

    @Test
    @DisplayName("backs off exponentially")
    void backsOffExponentially() {
      assertThat(IntStream.of(1, 2, 3, 4).mapToLong(attempt -> backoffMs(attempt, 1)).toArray())
          .containsExactly(500, 1_000, 2_000, 4_000);
    }

    @Test
    @DisplayName("never waits longer than the cap")
    void capsTheDelay() {
      assertThat(backoffMs(50, 1)).isEqualTo(30_000);
      assertThat(backoffMs(50, 500, 5_000, 1)).isEqualTo(5_000);
    }

    @Test
    @DisplayName("spreads the herd: jitter moves the delay without changing its scale")
    void jitterSpreadsTheHerd() {
      // Full jitter puts the delay somewhere in [half, full] - so retries from
      // many workers do not land on the dependency at the same instant.
      assertThat(backoffMs(3, 0)).isEqualTo(1_000);
      assertThat(backoffMs(3, 0.5)).isEqualTo(1_500);
      assertThat(backoffMs(3, 1)).isEqualTo(2_000);
    }

    @Test
    @DisplayName("clamps a nonsense jitter instead of producing a nonsense delay")
    void clampsJitter() {
      assertThat(backoffMs(1, -5)).isEqualTo(250);
      assertThat(backoffMs(1, 99)).isEqualTo(500);
    }

    @Test
    @DisplayName("returns nothing for a zeroth attempt")
    void zerothAttempt() {
      assertThat(backoffMs(0)).isZero();
      assertThat(backoffMs(-1)).isZero();
    }

    @Test
    @DisplayName("gives up only after the configured number of attempts")
    void givesUpAfterMaxAttempts() {
      assertThat(isExhausted(MAX_SETTLE_ATTEMPTS - 1)).isFalse();
      assertThat(isExhausted(MAX_SETTLE_ATTEMPTS)).isTrue();
      assertThat(isExhausted(MAX_SETTLE_ATTEMPTS + 1)).isTrue();
    }
  }

  @Nested
  @DisplayName("simulated faults")
  class SimulatedFaults {

    @Test
    @DisplayName("a transient fault heals before the retries run out")
    void transientHeals() {
      boolean[] outcomes = new boolean[MAX_SETTLE_ATTEMPTS];
      for (int attempts = 0; attempts < MAX_SETTLE_ATTEMPTS; attempts++) {
        outcomes[attempts] = shouldSimulateFailure(SimulateMode.TRANSIENT, attempts);
      }
      // Fails at first, succeeds on the final attempt - so the payment completes
      // and is never refunded.
      assertThat(outcomes[0]).isTrue();
      assertThat(outcomes[outcomes.length - 1]).isFalse();
    }

    @Test
    @DisplayName("a permanent fault never heals")
    void permanentNeverHeals() {
      for (int attempts = 0; attempts <= MAX_SETTLE_ATTEMPTS + 2; attempts++) {
        assertThat(shouldSimulateFailure(SimulateMode.PERMANENT, attempts)).isTrue();
      }
    }

    @Test
    @DisplayName("no simulation means no interference")
    void noneDoesNothing() {
      assertThat(shouldSimulateFailure(SimulateMode.NONE, 0)).isFalse();
      assertThat(shouldSimulateFailure(SimulateMode.NONE, 99)).isFalse();
    }
  }

  @Nested
  @DisplayName("idempotency keys")
  class IdempotencyKeys {

    @Test
    @DisplayName("derives the same key for an identical request")
    void stableForIdenticalRequest() {
      assertThat(deriveIdempotencyKey("a", "b", 2_500))
          .isEqualTo(deriveIdempotencyKey("a", "b", 2_500));
    }

    @Test
    @DisplayName("derives a different key when anything about the payment changes")
    void differsWhenRequestDiffers() {
      String base = deriveIdempotencyKey("a", "b", 2_500);
      assertThat(deriveIdempotencyKey("a", "b", 2_501)).isNotEqualTo(base);
      assertThat(deriveIdempotencyKey("a", "c", 2_500)).isNotEqualTo(base);
      assertThat(deriveIdempotencyKey("c", "b", 2_500)).isNotEqualTo(base);
      assertThat(deriveIdempotencyKey("b", "a", 2_500)).isNotEqualTo(base);
      // Two payments of the same amount with different notes are two payments.
      assertThat(deriveIdempotencyKey("a", "b", 2_500, "lunch")).isNotEqualTo(base);
    }

    @Test
    @DisplayName("is not confused by field values that concatenate the same way")
    void notConfusedByConcatenation() {
      assertThat(deriveIdempotencyKey("a|b", "c", 1))
          .isNotEqualTo(deriveIdempotencyKey("a", "b|c", 1));
    }

    @Test
    @DisplayName("marks derived keys so they can be treated differently")
    void marksDerivedKeys() {
      assertThat(isDerivedKey(deriveIdempotencyKey("a", "b", 1))).isTrue();
      assertThat(isDerivedKey("client-supplied-key")).isFalse();
    }

    @Test
    @DisplayName("fingerprints requests so a reused key with different params is caught")
    void fingerprintsRequests() {
      assertThat(requestFingerprint("a", "b", 2_500))
          .isEqualTo(requestFingerprint("a", "b", 2_500));
      assertThat(requestFingerprint("a", "b", 2_500))
          .isNotEqualTo(requestFingerprint("a", "b", 9_999));
      assertThat(requestFingerprint("a", "b", 2_500, "x"))
          .isNotEqualTo(requestFingerprint("a", "b", 2_500, "y"));
    }

    @Test
    @DisplayName("hashes the same bytes the TypeScript implementation did")
    void matchesTheTypescriptFingerprint() {
      // sha256 of JSON.stringify(["a","b",2500,""]) - pinned so a key minted by
      // the old service still matches one minted here, and a rolling deploy
      // cannot charge anyone twice.
      assertThat(requestFingerprint("a", "b", 2_500))
          .isEqualTo("f5cff99aa5cbe601e4a37612ea04d6e543def0614978c752842fa4ffbd55760e");
    }
  }
}
