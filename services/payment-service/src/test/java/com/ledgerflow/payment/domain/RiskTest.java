package com.ledgerflow.payment.domain;

import static com.ledgerflow.payment.domain.Risk.assessRisk;
import static com.ledgerflow.payment.domain.Risk.describeFlags;
import static org.assertj.core.api.Assertions.assertThat;

import com.ledgerflow.payment.domain.Risk.RiskAssessment;
import com.ledgerflow.payment.domain.Risk.RiskFlag;
import com.ledgerflow.payment.domain.Risk.RiskPolicy;
import com.ledgerflow.payment.domain.Risk.RiskSignals;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

class RiskTest {

  private static final RiskPolicy POLICY =
      new RiskPolicy(
          50_000, // $500
          10_000, // $100
          5);

  private static RiskSignals signals() {
    return new RiskSignals(1_000, false, 0);
  }

  private static RiskSignals signals(long amountCents) {
    return new RiskSignals(amountCents, false, 0);
  }

  private static RiskSignals signals(long amountCents, boolean payeeIsNew) {
    return new RiskSignals(amountCents, payeeIsNew, 0);
  }

  private static RiskSignals recent(int recentCount) {
    return new RiskSignals(1_000, false, recentCount);
  }

  @Nested
  @DisplayName("assessRisk")
  class AssessRisk {

    @Test
    @DisplayName("lets an ordinary payment through untouched")
    void ordinaryPaymentPasses() {
      assertThat(assessRisk(signals(), POLICY)).isEqualTo(new RiskAssessment(false, List.of()));
    }

    @Nested
    @DisplayName("large amount")
    class LargeAmount {

      @Test
      @DisplayName("holds at the threshold")
      void holdsAtThreshold() {
        RiskAssessment result = assessRisk(signals(50_000), POLICY);
        assertThat(result.hold()).isTrue();
        assertThat(result.flags()).containsExactly(RiskFlag.LARGE_AMOUNT);
      }

      @Test
      @DisplayName("lets one cent under it through")
      void oneCentUnderPasses() {
        assertThat(assessRisk(signals(49_999), POLICY).hold()).isFalse();
      }
    }

    @Nested
    @DisplayName("new payee")
    class NewPayee {

      @Test
      @DisplayName("holds a first payment at or above the threshold")
      void holdsFirstLargePayment() {
        RiskAssessment result = assessRisk(signals(10_000, true), POLICY);
        assertThat(result.flags()).containsExactly(RiskFlag.NEW_PAYEE_LARGE);
      }

      // A small first payment is how people check an account number works.
      @Test
      @DisplayName("lets a small first payment through")
      void smallFirstPaymentPasses() {
        assertThat(assessRisk(signals(9_999, true), POLICY).hold()).isFalse();
      }

      @Test
      @DisplayName("ignores the payee rule once they have been paid before")
      void ignoresKnownPayee() {
        assertThat(assessRisk(signals(40_000, false), POLICY).hold()).isFalse();
      }
    }

    @Nested
    @DisplayName("rapid fire")
    class RapidFire {

      @Test
      @DisplayName("holds at the threshold")
      void holdsAtThreshold() {
        assertThat(assessRisk(recent(5), POLICY).flags()).containsExactly(RiskFlag.RAPID_FIRE);
      }

      @Test
      @DisplayName("lets one under it through")
      void oneUnderPasses() {
        assertThat(assessRisk(recent(4), POLICY).hold()).isFalse();
      }
    }

    // A reviewer releasing someone else's money wants the whole picture, so
    // every rule that fired is reported rather than only the first.
    @Test
    @DisplayName("reports every rule that fired")
    void reportsEveryRule() {
      RiskAssessment result = assessRisk(new RiskSignals(90_000, true, 9), POLICY);
      assertThat(result.hold()).isTrue();
      assertThat(result.flags())
          .containsExactly(RiskFlag.LARGE_AMOUNT, RiskFlag.NEW_PAYEE_LARGE, RiskFlag.RAPID_FIRE);
    }

    @Nested
    @DisplayName("degenerate policy")
    class DegeneratePolicy {

      @Test
      @DisplayName("a zero large-amount threshold reviews everything")
      void zeroThresholdReviewsEverything() {
        RiskPolicy paranoid =
            new RiskPolicy(0, POLICY.newPayeeAmountCents(), POLICY.rapidFireCount());
        assertThat(assessRisk(signals(1), paranoid).hold()).isTrue();
      }

      @Test
      @DisplayName("thresholds above any real amount review nothing")
      void unreachableThresholdsReviewNothing() {
        RiskPolicy relaxed =
            new RiskPolicy(Payments.MAX_SAFE_INTEGER, Payments.MAX_SAFE_INTEGER, Integer.MAX_VALUE);
        assertThat(assessRisk(new RiskSignals(10_000_000, true, 500), relaxed))
            .isEqualTo(new RiskAssessment(false, List.of()));
      }
    }
  }

  @Nested
  @DisplayName("describeFlags")
  class DescribeFlags {

    @Test
    @DisplayName("reads as a sentence for a reviewer")
    void readsAsASentence() {
      assertThat(describeFlags(List.of(RiskFlag.LARGE_AMOUNT, RiskFlag.NEW_PAYEE_LARGE)))
          .isEqualTo("Large amount · First payment to this payee");
    }

    @Test
    @DisplayName("is empty when nothing fired")
    void emptyWhenNothingFired() {
      assertThat(describeFlags(List.of())).isEmpty();
    }
  }
}
