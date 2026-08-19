package com.ledgerflow.payment.domain;

import static com.ledgerflow.payment.domain.Reconciliations.ledgerBalance;
import static com.ledgerflow.payment.domain.Reconciliations.reconcile;
import static org.assertj.core.api.Assertions.assertThat;

import com.ledgerflow.payment.domain.Reconciliations.AccountSnapshot;
import com.ledgerflow.payment.domain.Reconciliations.Finding;
import com.ledgerflow.payment.domain.Reconciliations.FindingCode;
import com.ledgerflow.payment.domain.Reconciliations.LedgerTotals;
import com.ledgerflow.payment.domain.Reconciliations.ReconciliationInput;
import com.ledgerflow.payment.domain.Reconciliations.ReconciliationReport;
import com.ledgerflow.payment.domain.Reconciliations.Severity;
import com.ledgerflow.payment.domain.Reconciliations.UnbalancedJournal;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

class ReconciliationsTest {

  private static final String CLEARING = "clearing";
  private static final String FUNDING = "funding";

  private static AccountSnapshot account(String id, long balanceCents) {
    return new AccountSnapshot(id, id, balanceCents, false);
  }

  private static AccountSnapshot account(String id, long balanceCents, boolean isSystem) {
    return new AccountSnapshot(id, id, balanceCents, isSystem);
  }

  private static LedgerTotals totals(long creditsCents, long debitsCents) {
    return new LedgerTotals(creditsCents, debitsCents);
  }

  /**
   * A mutable builder for the input, so each test can bend one thing about an
   * otherwise healthy world - the same shape the TypeScript tests used.
   */
  private static final class World {
    List<AccountSnapshot> accounts = new ArrayList<>();
    Map<String, LedgerTotals> ledger = new HashMap<>();
    List<UnbalancedJournal> unbalancedJournals = new ArrayList<>();
    long inFlightCents;
    Map<String, Long> readModel;
    boolean readModelMayLag;

    ReconciliationInput input() {
      return new ReconciliationInput(
          List.copyOf(accounts),
          Map.copyOf(ledger),
          List.copyOf(unbalancedJournals),
          CLEARING,
          inFlightCents,
          readModel == null ? null : Map.copyOf(readModel),
          readModelMayLag);
    }
  }

  /**
   * A healthy world: funding issued 10,500 into two wallets, Alice then paid Bob
   * 2,500. Every balance is explained by the ledger and the books sum to zero.
   */
  private static World healthy() {
    World world = new World();
    world.accounts =
        new ArrayList<>(
            List.of(
                account("alice", 7_500),
                account("bob", 3_000),
                account(CLEARING, 0, true),
                account(FUNDING, -10_500, true)));
    world.ledger =
        new HashMap<>(
            Map.of(
                "alice", totals(10_000, 2_500),
                "bob", totals(3_000, 0),
                CLEARING, totals(2_500, 2_500),
                FUNDING, totals(0, 10_500)));
    world.inFlightCents = 0;
    world.readModelMayLag = false;
    return world;
  }

  private static Finding findingOf(ReconciliationReport report, FindingCode code) {
    return report.findings().stream()
        .filter(finding -> finding.code() == code)
        .findFirst()
        .orElse(null);
  }

  @Nested
  @DisplayName("a healthy ledger")
  class HealthyLedger {

    @Test
    @DisplayName("reports OK with nothing to say")
    void reportsOk() {
      ReconciliationReport report = reconcile(healthy().input());
      assertThat(report.status()).isEqualTo(Severity.OK);
      assertThat(report.findings()).isEmpty();
      assertThat(report.driftCents()).isZero();
      assertThat(report.checkedAccounts()).isEqualTo(4);
    }

    @Test
    @DisplayName("is still OK mid-saga, with money sitting in clearing")
    void okMidSaga() {
      World world = healthy();
      // Alice authorised 1,000 that has not settled yet.
      world.accounts =
          new ArrayList<>(
              List.of(
                  account("alice", 6_500),
                  account("bob", 3_000),
                  account(CLEARING, 1_000, true),
                  account(FUNDING, -10_500, true)));
      world.ledger =
          new HashMap<>(
              Map.of(
                  "alice", totals(10_000, 3_500),
                  "bob", totals(3_000, 0),
                  CLEARING, totals(3_500, 2_500),
                  FUNDING, totals(0, 10_500)));
      world.inFlightCents = 1_000;

      assertThat(reconcile(world.input()).status()).isEqualTo(Severity.OK);
    }
  }

  @Nested
  @DisplayName("ledgerBalance")
  class LedgerBalance {

    @Test
    @DisplayName("is credits minus debits, and zero for an account with no history")
    void creditsMinusDebits() {
      assertThat(ledgerBalance(totals(500, 200))).isEqualTo(300);
      assertThat(ledgerBalance(null)).isZero();
    }
  }

  @Nested
  @DisplayName("balance drift")
  class BalanceDrift {

    @Test
    @DisplayName("catches a balance edited without a matching ledger entry")
    void catchesEditedBalance() {
      World world = healthy();
      // Somebody added 100 to Alice directly. The ledger does not know.
      world.accounts.set(0, account("alice", 7_600));

      ReconciliationReport report = reconcile(world.input());
      Finding finding = findingOf(report, FindingCode.BALANCE_DRIFT);
      assertThat(finding).isNotNull();
      assertThat(finding.severity()).isEqualTo(Severity.DRIFT);
      assertThat(finding.accountId()).isEqualTo("alice");
      assertThat(finding.expectedCents()).isEqualTo(7_500);
      assertThat(finding.actualCents()).isEqualTo(7_600);
      assertThat(finding.driftCents()).isEqualTo(100);
      assertThat(report.status()).isEqualTo(Severity.DRIFT);
    }

    @Test
    @DisplayName("catches a ledger entry written without updating the balance")
    void catchesUnappliedLedgerEntry() {
      World world = healthy();
      world.ledger.put("bob", totals(4_000, 0));

      Finding finding = findingOf(reconcile(world.input()), FindingCode.BALANCE_DRIFT);
      assertThat(finding).isNotNull();
      assertThat(finding.accountId()).isEqualTo("bob");
      assertThat(finding.expectedCents()).isEqualTo(4_000);
      assertThat(finding.actualCents()).isEqualTo(3_000);
    }

    @Test
    @DisplayName("reports drift for every affected account and sums the magnitude")
    void reportsEveryDriftedAccount() {
      World world = healthy();
      world.accounts.set(0, account("alice", 7_400)); // -100
      world.accounts.set(1, account("bob", 3_050)); //  +50

      ReconciliationReport report = reconcile(world.input());
      assertThat(report.findings().stream().filter(f -> f.code() == FindingCode.BALANCE_DRIFT))
          .hasSize(2);
      // Magnitudes, not a net that could cancel out to a comfortable zero.
      assertThat(report.driftCents()).isGreaterThanOrEqualTo(150);
    }
  }

  @Nested
  @DisplayName("the system must sum to zero")
  class SystemMustSumToZero {

    @Test
    @DisplayName("catches money invented out of nothing")
    void catchesInventedMoney() {
      World world = healthy();
      // Consistent with its own ledger, but funding never issued it.
      world.accounts.add(account("mallory", 1_000_000));
      world.ledger.put("mallory", totals(1_000_000, 0));

      ReconciliationReport report = reconcile(world.input());
      assertThat(report.findings().stream().map(Finding::code))
          .contains(FindingCode.SYSTEM_NOT_ZERO_SUM);
      assertThat(findingOf(report, FindingCode.SYSTEM_NOT_ZERO_SUM).actualCents())
          .isEqualTo(1_000_000);
    }

    @Test
    @DisplayName("is satisfied when funding covers exactly what exists")
    void satisfiedWhenFundingCovers() {
      assertThat(reconcile(healthy().input()).findings().stream().map(Finding::code))
          .doesNotContain(FindingCode.SYSTEM_NOT_ZERO_SUM);
    }
  }

  @Nested
  @DisplayName("the clearing account")
  class ClearingAccount {

    @Test
    @DisplayName("catches money stranded in clearing with no payment to explain it")
    void catchesStrandedMoney() {
      World world = healthy();
      world.accounts.set(2, account(CLEARING, 900, true));
      world.ledger.put(CLEARING, totals(3_400, 2_500));
      world.accounts.set(3, account(FUNDING, -11_400, true));
      world.ledger.put(FUNDING, totals(0, 11_400));
      world.inFlightCents = 0; // nothing in flight, yet clearing holds 900

      Finding finding = findingOf(reconcile(world.input()), FindingCode.CLEARING_MISMATCH);
      assertThat(finding).isNotNull();
      assertThat(finding.expectedCents()).isZero();
      assertThat(finding.actualCents()).isEqualTo(900);
      assertThat(finding.driftCents()).isEqualTo(900);
    }

    @Test
    @DisplayName("catches an in-flight payment whose money is not being held")
    void catchesUnheldInFlightMoney() {
      World world = healthy();
      world.inFlightCents = 2_000; // claims to be holding 2,000, holds 0

      Finding finding = findingOf(reconcile(world.input()), FindingCode.CLEARING_MISMATCH);
      assertThat(finding).isNotNull();
      assertThat(finding.expectedCents()).isEqualTo(2_000);
      assertThat(finding.actualCents()).isZero();
    }
  }

  @Nested
  @DisplayName("double entry itself")
  class DoubleEntry {

    @Test
    @DisplayName("catches a journal that is not a balanced pair")
    void catchesUnbalancedJournal() {
      World world = healthy();
      world.unbalancedJournals = new ArrayList<>(List.of(new UnbalancedJournal("j1", 1, -500)));

      ReconciliationReport report = reconcile(world.input());
      assertThat(report.status()).isEqualTo(Severity.DRIFT);
      assertThat(findingOf(report, FindingCode.UNBALANCED_JOURNAL).detail()).contains("j1");
      assertThat(report.driftCents()).isEqualTo(500);
    }
  }

  @Nested
  @DisplayName("the read model")
  class ReadModel {

    @Test
    @DisplayName("says nothing when it agrees")
    void saysNothingWhenItAgrees() {
      World world = healthy();
      world.readModel = new HashMap<>(Map.of("alice", 7_500L, "bob", 3_000L));
      assertThat(reconcile(world.input()).status()).isEqualTo(Severity.OK);
    }

    @Test
    @DisplayName("is a warning, not a fault, while work is still in flight")
    void warnsWhileWorkIsInFlight() {
      World world = healthy();
      world.readModel = new HashMap<>(Map.of("alice", 9_000L));
      world.readModelMayLag = true;

      ReconciliationReport report = reconcile(world.input());
      assertThat(report.status()).isEqualTo(Severity.WARN);
      assertThat(report.findings().get(0).code()).isEqualTo(FindingCode.READ_MODEL_LAG);
      // Lag is expected under CQRS, so it must not be counted as lost money.
      assertThat(report.driftCents()).isZero();
    }

    @Test
    @DisplayName("is a fault once there is nothing left to explain it")
    void faultsWhenNothingExplainsIt() {
      World world = healthy();
      world.readModel = new HashMap<>(Map.of("alice", 9_000L));
      world.readModelMayLag = false;

      ReconciliationReport report = reconcile(world.input());
      assertThat(report.status()).isEqualTo(Severity.DRIFT);
      assertThat(report.findings().get(0).code()).isEqualTo(FindingCode.READ_MODEL_DRIFT);
      assertThat(report.driftCents()).isEqualTo(1_500);
    }

    @Test
    @DisplayName("ignores system accounts, which are never projected")
    void ignoresSystemAccounts() {
      World world = healthy();
      world.readModel = new HashMap<>(Map.of("alice", 7_500L, "bob", 3_000L));
      // Clearing and funding are absent from the read model on purpose.
      assertThat(reconcile(world.input()).status()).isEqualTo(Severity.OK);
    }

    @Test
    @DisplayName("is skipped entirely when no read model is supplied")
    void skippedWhenAbsent() {
      World world = healthy();
      world.readModel = null;
      assertThat(reconcile(world.input()).status()).isEqualTo(Severity.OK);
    }
  }

  @Nested
  @DisplayName("severity")
  class SeverityRanking {

    @Test
    @DisplayName("lets a real fault outrank a mere warning")
    void driftOutranksWarning() {
      World world = healthy();
      world.readModel = new HashMap<>(Map.of("alice", 9_000L));
      world.readModelMayLag = true; // WARN
      world.unbalancedJournals =
          new ArrayList<>(List.of(new UnbalancedJournal("j1", 3, 1))); // DRIFT

      assertThat(reconcile(world.input()).status()).isEqualTo(Severity.DRIFT);
    }
  }
}
