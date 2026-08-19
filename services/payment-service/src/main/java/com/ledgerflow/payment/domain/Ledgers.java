package com.ledgerflow.payment.domain;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Pure ledger reporting: turning journal lines into the two documents an
 * accountant actually asks for.
 *
 * A trial balance is the oldest correctness check in double-entry bookkeeping
 * and it is still the right one - list every account's debit and credit
 * totals, add up each column, and the two columns must be equal. If they are
 * not, a journal was written with only one side and the books are broken.
 *
 * A statement is the same rows read down one account with a running balance,
 * which is how you answer "where did this money come from" for a single line.
 *
 * No Spring, no JDBC, no Redis. The caller does the querying.
 */
public final class Ledgers {

  private Ledgers() {}

  /** One account's summed lines. */
  public record AccountTotals(long debitsCents, long creditsCents) {}

  /**
   * @param balanceCents the denormalised cache on `accounts`, which the ledger
   *     must agree with.
   */
  public record AccountRef(String id, String name, long balanceCents, boolean isSystem) {}

  /**
   * @param ledgerBalanceCents credits minus debits: what the ledger says this
   *     account holds.
   * @param cachedBalanceCents what the `accounts` row claims it holds.
   * @param matches false means this account is the reason the books are wrong.
   */
  public record TrialBalanceRow(
      String accountId,
      String accountName,
      boolean isSystem,
      long debitsCents,
      long creditsCents,
      long ledgerBalanceCents,
      long cachedBalanceCents,
      boolean matches) {}

  /**
   * @param differenceCents debits minus credits. Zero is the only correct
   *     answer.
   * @param systemTotalCents sum of every cached balance. Also zero, because the
   *     books are closed.
   * @param mismatchedAccounts accounts whose cache disagrees with their own
   *     journal lines.
   */
  public record TrialBalance(
      List<TrialBalanceRow> rows,
      long totalDebitsCents,
      long totalCreditsCents,
      long differenceCents,
      boolean balanced,
      long systemTotalCents,
      boolean zeroSum,
      int mismatchedAccounts) {}

  /**
   * Builds the trial balance.
   *
   * Accounts with no journal lines still appear, at zero - an account missing
   * from the report is indistinguishable from an account that balances, and the
   * whole point is to be able to look down the column.
   */
  public static TrialBalance trialBalance(
      List<AccountRef> accounts, Map<String, AccountTotals> totals) {
    List<TrialBalanceRow> rows = new ArrayList<>(accounts.size());
    for (AccountRef account : accounts) {
      AccountTotals accountTotals = totals.get(account.id());
      long debitsCents = accountTotals == null ? 0 : accountTotals.debitsCents();
      long creditsCents = accountTotals == null ? 0 : accountTotals.creditsCents();
      long ledgerBalanceCents = creditsCents - debitsCents;
      rows.add(
          new TrialBalanceRow(
              account.id(),
              account.name(),
              account.isSystem(),
              debitsCents,
              creditsCents,
              ledgerBalanceCents,
              account.balanceCents(),
              ledgerBalanceCents == account.balanceCents()));
    }

    long totalDebitsCents = rows.stream().mapToLong(TrialBalanceRow::debitsCents).sum();
    long totalCreditsCents = rows.stream().mapToLong(TrialBalanceRow::creditsCents).sum();
    long systemTotalCents = rows.stream().mapToLong(TrialBalanceRow::cachedBalanceCents).sum();

    return new TrialBalance(
        List.copyOf(rows),
        totalDebitsCents,
        totalCreditsCents,
        totalDebitsCents - totalCreditsCents,
        totalDebitsCents == totalCreditsCents,
        systemTotalCents,
        systemTotalCents == 0,
        (int) rows.stream().filter(row -> !row.matches()).count());
  }

  /**
   * @param counterpartyName the other side of this journal entry, so a line
   *     reads as a sentence.
   */
  public record StatementLine(
      String entryGroup,
      String paymentId,
      Leg leg,
      Direction direction,
      long amountCents,
      Instant createdAt,
      String counterpartyName) {}

  /**
   * @param changeCents signed effect of this line on the account: credits add,
   *     debits subtract.
   * @param runningCents the account's balance immediately after this line was
   *     posted.
   */
  public record StatementLineWithBalance(
      String entryGroup,
      String paymentId,
      Leg leg,
      Direction direction,
      long amountCents,
      Instant createdAt,
      String counterpartyName,
      long changeCents,
      long runningCents) {}

  public record Statement(
      List<StatementLineWithBalance> lines, long openingCents, long closingCents) {}

  /**
   * Walks an account's lines oldest-first and carries a running balance.
   *
   * `openingCents` is what the account held before the first line shown, so a
   * truncated window still reconciles: opening plus the movements below always
   * equals closing.
   */
  public static Statement statement(List<StatementLine> lines, long openingCents) {
    long running = openingCents;
    List<StatementLineWithBalance> withBalance = new ArrayList<>(lines.size());
    for (StatementLine line : lines) {
      long changeCents =
          line.direction() == Direction.CREDIT ? line.amountCents() : -line.amountCents();
      running += changeCents;
      withBalance.add(
          new StatementLineWithBalance(
              line.entryGroup(),
              line.paymentId(),
              line.leg(),
              line.direction(),
              line.amountCents(),
              line.createdAt(),
              line.counterpartyName(),
              changeCents,
              running));
    }

    return new Statement(List.copyOf(withBalance), openingCents, running);
  }
}
