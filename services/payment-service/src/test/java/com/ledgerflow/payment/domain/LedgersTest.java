package com.ledgerflow.payment.domain;

import static com.ledgerflow.payment.domain.Ledgers.statement;
import static com.ledgerflow.payment.domain.Ledgers.trialBalance;
import static org.assertj.core.api.Assertions.assertThat;

import com.ledgerflow.payment.domain.Ledgers.AccountRef;
import com.ledgerflow.payment.domain.Ledgers.AccountTotals;
import com.ledgerflow.payment.domain.Ledgers.Statement;
import com.ledgerflow.payment.domain.Ledgers.StatementLine;
import com.ledgerflow.payment.domain.Ledgers.StatementLineWithBalance;
import com.ledgerflow.payment.domain.Ledgers.TrialBalance;
import com.ledgerflow.payment.domain.Ledgers.TrialBalanceRow;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

class LedgersTest {

  private static AccountRef account(String id, String name, long balanceCents) {
    return new AccountRef(id, name, balanceCents, false);
  }

  private static AccountRef account(
      String id, String name, long balanceCents, boolean isSystem) {
    return new AccountRef(id, name, balanceCents, isSystem);
  }

  private static TrialBalanceRow row(TrialBalance balance, String accountId) {
    return balance.rows().stream()
        .filter(candidate -> candidate.accountId().equals(accountId))
        .findFirst()
        .orElseThrow();
  }

  @Nested
  @DisplayName("trialBalance")
  class TrialBalanceReport {

    // Opening two wallets from the funding account: the funding account is
    // debited twice, each wallet credited once. Columns must match.
    private TrialBalance funded() {
      return trialBalance(
          List.of(
              account("funding", "Funding account", -15_000, true),
              account("alice", "Alice", 10_000),
              account("bob", "Bob", 5_000)),
          Map.of(
              "funding", new AccountTotals(15_000, 0),
              "alice", new AccountTotals(0, 10_000),
              "bob", new AccountTotals(0, 5_000)));
    }

    @Test
    @DisplayName("adds each column and reports them equal")
    void addsEachColumn() {
      TrialBalance result = funded();
      assertThat(result.totalDebitsCents()).isEqualTo(15_000);
      assertThat(result.totalCreditsCents()).isEqualTo(15_000);
      assertThat(result.differenceCents()).isZero();
      assertThat(result.balanced()).isTrue();
    }

    @Test
    @DisplayName("reports the closed books summing to zero")
    void reportsZeroSum() {
      TrialBalance result = funded();
      assertThat(result.systemTotalCents()).isZero();
      assertThat(result.zeroSum()).isTrue();
    }

    @Test
    @DisplayName("agrees with each cached balance when nothing has drifted")
    void agreesWithCachedBalances() {
      TrialBalance result = funded();
      assertThat(result.mismatchedAccounts()).isZero();
      assertThat(result.rows()).allMatch(TrialBalanceRow::matches);
    }

    @Test
    @DisplayName("derives the ledger balance as credits minus debits")
    void derivesLedgerBalance() {
      TrialBalance result = funded();
      assertThat(row(result, "alice").ledgerBalanceCents()).isEqualTo(10_000);
      assertThat(row(result, "funding").ledgerBalanceCents()).isEqualTo(-15_000);
    }

    // The failure this document exists to catch: a hand-edited balance.
    @Test
    @DisplayName("names the account whose cache no longer matches its journal")
    void namesTheDriftedAccount() {
      TrialBalance result =
          trialBalance(
              List.of(account("alice", "Alice", 999_999), account("bob", "Bob", 5_000)),
              Map.of(
                  "alice", new AccountTotals(0, 10_000),
                  "bob", new AccountTotals(0, 5_000)));
      assertThat(result.mismatchedAccounts()).isEqualTo(1);
      TrialBalanceRow alice = row(result, "alice");
      assertThat(alice.matches()).isFalse();
      assertThat(alice.ledgerBalanceCents()).isEqualTo(10_000);
      assertThat(alice.cachedBalanceCents()).isEqualTo(999_999);
    }

    // A half-written journal: the debit landed, the credit did not.
    @Test
    @DisplayName("shows the columns disagreeing when only one side was posted")
    void showsColumnsDisagreeing() {
      TrialBalance result =
          trialBalance(
              List.of(account("alice", "Alice", -2_500), account("bob", "Bob", 0)),
              Map.of("alice", new AccountTotals(2_500, 0)));
      assertThat(result.totalDebitsCents()).isEqualTo(2_500);
      assertThat(result.totalCreditsCents()).isZero();
      assertThat(result.differenceCents()).isEqualTo(2_500);
      assertThat(result.balanced()).isFalse();
    }

    @Test
    @DisplayName("lists an account with no journal lines at zero rather than omitting it")
    void listsAccountWithNoLines() {
      TrialBalance result = trialBalance(List.of(account("new", "Newcomer", 0)), Map.of());
      assertThat(result.rows()).hasSize(1);
      TrialBalanceRow only = result.rows().get(0);
      assertThat(only.debitsCents()).isZero();
      assertThat(only.creditsCents()).isZero();
      assertThat(only.ledgerBalanceCents()).isZero();
      assertThat(only.matches()).isTrue();
    }

    @Test
    @DisplayName("is balanced and zero-sum on an empty system")
    void emptySystemIsBalanced() {
      TrialBalance result = trialBalance(List.of(), Map.of());
      assertThat(result.balanced()).isTrue();
      assertThat(result.zeroSum()).isTrue();
      assertThat(result.mismatchedAccounts()).isZero();
    }
  }

  @Nested
  @DisplayName("statement")
  class StatementReport {

    private StatementLine line(Direction direction, long amountCents, Leg leg) {
      return line(direction, amountCents, leg, null);
    }

    private StatementLine line(
        Direction direction, long amountCents, Leg leg, String counterpartyName) {
      return new StatementLine(
          leg + "-" + direction + "-" + amountCents,
          leg == Leg.FUNDING ? null : "payment-1",
          leg,
          direction,
          amountCents,
          Instant.parse("2026-01-01T00:00:00.000Z"),
          counterpartyName);
    }

    @Test
    @DisplayName("carries a running balance down the page")
    void carriesRunningBalance() {
      Statement result =
          statement(
              List.of(
                  line(Direction.CREDIT, 10_000, Leg.FUNDING, "Funding account"),
                  line(Direction.DEBIT, 2_500, Leg.AUTHORISE, "Clearing account"),
                  line(Direction.CREDIT, 1_000, Leg.SETTLE, "Clearing account")),
              0);
      assertThat(result.lines().stream().map(StatementLineWithBalance::runningCents))
          .containsExactly(10_000L, 7_500L, 8_500L);
    }

    @Test
    @DisplayName("signs each movement by its direction")
    void signsEachMovement() {
      Statement result = statement(List.of(line(Direction.DEBIT, 2_500, Leg.AUTHORISE)), 10_000);
      assertThat(result.lines().get(0).changeCents()).isEqualTo(-2_500);
      assertThat(result.lines().get(0).runningCents()).isEqualTo(7_500);
    }

    // The property that makes a truncated window trustworthy.
    @Test
    @DisplayName("closes at opening plus the sum of the movements shown")
    void closesAtOpeningPlusMovements() {
      Statement result =
          statement(
              List.of(
                  line(Direction.CREDIT, 4_000, Leg.SETTLE),
                  line(Direction.DEBIT, 1_500, Leg.AUTHORISE),
                  line(Direction.CREDIT, 700, Leg.COMPENSATE)),
              25_000);
      long movement =
          result.lines().stream().mapToLong(StatementLineWithBalance::changeCents).sum();
      assertThat(result.closingCents()).isEqualTo(result.openingCents() + movement);
      assertThat(result.closingCents()).isEqualTo(28_200);
    }

    @Test
    @DisplayName("returns the opening balance unchanged when there are no lines")
    void emptyStatementKeepsOpening() {
      Statement result = statement(List.of(), 4_200);
      assertThat(result.lines()).isEmpty();
      assertThat(result.openingCents()).isEqualTo(4_200);
      assertThat(result.closingCents()).isEqualTo(4_200);
    }

    // An authorise followed by a compensate must leave the sender exactly where
    // they started - the refund path's whole promise, checked arithmetically.
    @Test
    @DisplayName("returns to the starting balance after an authorise is compensated")
    void compensationReturnsToStart() {
      Statement result =
          statement(
              List.of(
                  line(Direction.DEBIT, 3_300, Leg.AUTHORISE),
                  line(Direction.CREDIT, 3_300, Leg.COMPENSATE)),
              9_000);
      assertThat(result.closingCents()).isEqualTo(9_000);
    }
  }
}
