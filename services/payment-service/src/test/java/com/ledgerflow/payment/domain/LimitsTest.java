package com.ledgerflow.payment.domain;

import static com.ledgerflow.payment.domain.Limits.checkLimits;
import static com.ledgerflow.payment.domain.Limits.explainBreach;
import static org.assertj.core.api.Assertions.assertThat;

import com.ledgerflow.payment.domain.Limits.AccountLimits;
import com.ledgerflow.payment.domain.Limits.LimitBreach;
import com.ledgerflow.payment.domain.Limits.LimitDecision;
import com.ledgerflow.payment.domain.Limits.SpendSoFar;
import java.util.function.LongFunction;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

class LimitsTest {

  private static final AccountLimits LIMITS =
      new AccountLimits(
          50_000, // $500 a payment
          200_000, // $2,000 a day
          5);

  private static SpendSoFar spend() {
    return new SpendSoFar(0, 0);
  }

  private static SpendSoFar spend(long todayCents) {
    return new SpendSoFar(todayCents, 0);
  }

  private static SpendSoFar spend(long todayCents, int recentCount) {
    return new SpendSoFar(todayCents, recentCount);
  }

  @Nested
  @DisplayName("checkLimits")
  class CheckLimits {

    @Test
    @DisplayName("allows a payment well inside every limit")
    void allowsPaymentInsideLimits() {
      assertThat(checkLimits(2_500, LIMITS, spend()))
          .isEqualTo(new LimitDecision(true, null, 200_000));
    }

    @Nested
    @DisplayName("per-payment cap")
    class PerPaymentCap {

      @Test
      @DisplayName("allows exactly the cap")
      void allowsExactlyTheCap() {
        assertThat(checkLimits(50_000, LIMITS, spend()).allowed()).isTrue();
      }

      @Test
      @DisplayName("rejects one cent over")
      void rejectsOneCentOver() {
        assertThat(checkLimits(50_001, LIMITS, spend()).breach())
            .isEqualTo(LimitBreach.AMOUNT_ABOVE_LIMIT);
      }
    }

    @Nested
    @DisplayName("daily cap")
    class DailyCap {

      @Test
      @DisplayName("allows a payment that lands exactly on the cap")
      void allowsLandingOnTheCap() {
        assertThat(checkLimits(50_000, LIMITS, spend(150_000)).allowed()).isTrue();
      }

      // Deliberately under the per-payment cap, so the daily rule is what
      // catches it rather than the amount rule.
      @Test
      @DisplayName("rejects the cent that would cross it")
      void rejectsCrossingTheCap() {
        assertThat(checkLimits(45_000, LIMITS, spend(155_001)).breach())
            .isEqualTo(LimitBreach.DAILY_LIMIT_EXCEEDED);
      }

      @Test
      @DisplayName("reports what is left before the payment is applied")
      void reportsRemaining() {
        assertThat(checkLimits(1_000, LIMITS, spend(120_000)).remainingTodayCents())
            .isEqualTo(80_000);
      }

      @Test
      @DisplayName("never reports a negative remainder once the cap is spent")
      void neverNegativeRemainder() {
        assertThat(checkLimits(100, LIMITS, spend(250_000)).remainingTodayCents()).isZero();
      }

      @Test
      @DisplayName("rejects anything at all once the cap is used up")
      void rejectsOnceCapUsedUp() {
        assertThat(checkLimits(1, LIMITS, spend(200_000)).breach())
            .isEqualTo(LimitBreach.DAILY_LIMIT_EXCEEDED);
      }
    }

    @Nested
    @DisplayName("velocity")
    class Velocity {

      @Test
      @DisplayName("allows the last payment inside the window")
      void allowsLastInsideWindow() {
        assertThat(checkLimits(100, LIMITS, spend(0, 4)).allowed()).isTrue();
      }

      @Test
      @DisplayName("rejects the one after that")
      void rejectsTheNextOne() {
        assertThat(checkLimits(100, LIMITS, spend(0, 5)).breach())
            .isEqualTo(LimitBreach.VELOCITY_EXCEEDED);
      }
    }

    @Nested
    @DisplayName("precedence")
    class Precedence {

      // A payment can break several rules at once. The most specific reason is
      // the most actionable, so it wins.
      @Test
      @DisplayName("reports the amount cap ahead of the daily cap")
      void amountBeforeDaily() {
        assertThat(checkLimits(90_000, LIMITS, spend(199_000)).breach())
            .isEqualTo(LimitBreach.AMOUNT_ABOVE_LIMIT);
      }

      @Test
      @DisplayName("reports the daily cap ahead of velocity")
      void dailyBeforeVelocity() {
        assertThat(checkLimits(40_000, LIMITS, spend(199_000, 9)).breach())
            .isEqualTo(LimitBreach.DAILY_LIMIT_EXCEEDED);
      }
    }

    @Nested
    @DisplayName("degenerate limits")
    class DegenerateLimits {

      @Test
      @DisplayName("a zero daily limit blocks everything")
      void zeroDailyLimitBlocksEverything() {
        AccountLimits frozen = new AccountLimits(LIMITS.maxPaymentCents(), 0, LIMITS.velocityMax());
        assertThat(checkLimits(1, frozen, spend()).breach())
            .isEqualTo(LimitBreach.DAILY_LIMIT_EXCEEDED);
      }

      @Test
      @DisplayName("a zero velocity limit blocks everything")
      void zeroVelocityBlocksEverything() {
        AccountLimits frozen =
            new AccountLimits(LIMITS.maxPaymentCents(), LIMITS.dailyLimitCents(), 0);
        assertThat(checkLimits(1, frozen, spend()).breach())
            .isEqualTo(LimitBreach.VELOCITY_EXCEEDED);
      }
    }

    // The property the concurrency guarantee rests on: a sequence of payments
    // checked against the running total stops at exactly the right one, and the
    // total never exceeds the cap.
    @Test
    @DisplayName("stops a sequence at the cap and never lets the total past it")
    void stopsSequenceAtTheCap() {
      long today = 0;
      int allowed = 0;
      AccountLimits relaxedVelocity =
          new AccountLimits(LIMITS.maxPaymentCents(), LIMITS.dailyLimitCents(), 1_000);
      for (int i = 0; i < 20; i++) {
        if (!checkLimits(30_000, relaxedVelocity, spend(today)).allowed()) continue;
        today += 30_000;
        allowed++;
      }
      assertThat(allowed).isEqualTo(6); // 6 x $300 = $1,800; a seventh would pass $2,000
      assertThat(today).isLessThanOrEqualTo(LIMITS.dailyLimitCents());
    }
  }

  @Nested
  @DisplayName("explainBreach")
  class ExplainBreach {

    private final LongFunction<String> money = cents -> String.format("$%.2f", cents / 100.0);

    @Test
    @DisplayName("names the per-payment cap")
    void namesThePerPaymentCap() {
      assertThat(explainBreach(LimitBreach.AMOUNT_ABOVE_LIMIT, LIMITS, spend(), 60, money))
          .isEqualTo("Single payments are capped at $500.00");
    }

    @Test
    @DisplayName("names the daily cap and what is left of it")
    void namesTheDailyCap() {
      String message =
          explainBreach(LimitBreach.DAILY_LIMIT_EXCEEDED, LIMITS, spend(180_000), 60, money);
      assertThat(message).contains("$2000.00 daily limit");
      assertThat(message).contains("$200.00 left");
    }

    @Test
    @DisplayName("does not report a negative remainder")
    void noNegativeRemainder() {
      String message =
          explainBreach(LimitBreach.DAILY_LIMIT_EXCEEDED, LIMITS, spend(250_000), 60, money);
      assertThat(message).contains("$0.00 left");
    }

    @Test
    @DisplayName("names the velocity window")
    void namesTheVelocityWindow() {
      assertThat(explainBreach(LimitBreach.VELOCITY_EXCEEDED, LIMITS, spend(), 60, money))
          .isEqualTo("5 payments in 60 seconds is the most allowed");
    }
  }
}
