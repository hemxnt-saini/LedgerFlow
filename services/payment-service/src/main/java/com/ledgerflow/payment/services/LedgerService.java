package com.ledgerflow.payment.services;

import com.ledgerflow.payment.domain.Direction;
import com.ledgerflow.payment.domain.Ledgers;
import com.ledgerflow.payment.domain.Ledgers.Statement;
import com.ledgerflow.payment.domain.Ledgers.StatementLine;
import com.ledgerflow.payment.domain.Ledgers.StatementLineWithBalance;
import com.ledgerflow.payment.domain.Ledgers.TrialBalance;
import com.ledgerflow.payment.lib.HttpError;
import com.ledgerflow.payment.models.AccountModel.AccountRow;
import com.ledgerflow.payment.models.LedgerModel;
import com.ledgerflow.payment.models.LedgerModel.JournalEntryDto;
import com.ledgerflow.payment.models.LedgerModel.StatementLineRow;
import com.ledgerflow.payment.repositories.AccountRepository;
import com.ledgerflow.payment.repositories.LedgerRepository;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

/**
 * The ledger, read rather than written.
 *
 * Nothing in this class touches a row. The journal is append-only, so every
 * question about the past is answered by reading it back - there is no summary
 * table to fall out of date, and no cached figure that could be wrong in a way
 * the ledger is not.
 */
@Service
public class LedgerService {

  public record Journal(List<JournalEntryDto> entries) {}

  /**
   * @param cachedBalanceCents what the `accounts` row claims, for comparison
   *     with `closingCents`.
   */
  public record AccountStatement(
      String accountId,
      String accountName,
      long cachedBalanceCents,
      boolean matches,
      long openingCents,
      long closingCents,
      List<StatementLineWithBalance> lines) {}

  private final AccountRepository accounts;
  private final LedgerRepository ledger;

  public LedgerService(AccountRepository accounts, LedgerRepository ledger) {
    this.accounts = accounts;
    this.ledger = ledger;
  }

  /**
   * The oldest correctness check in bookkeeping: add up the debit column, add up
   * the credit column, and the two must be equal.
   *
   * System accounts are included deliberately. Leaving out the funding account
   * would make the columns disagree by exactly the amount of money issued, and
   * a trial balance you have to explain away is not a trial balance.
   */
  public TrialBalance getTrialBalance() {
    List<Ledgers.AccountRef> refs = accounts.findAllRefs(true);
    Map<String, Ledgers.AccountTotals> totals = ledger.accountTotals();
    return Ledgers.trialBalance(refs, totals);
  }

  /** The general journal, newest entry first, optionally for one account. */
  public Journal getJournal(int limit, String accountId) {
    return new Journal(LedgerModel.toJournalEntries(ledger.listJournal(limit, accountId)));
  }

  /**
   * One account's statement, oldest line first with a running balance.
   *
   * Only the most recent `limit` lines are shown, so the opening figure is
   * derived by subtracting the movements on this page from the account's full
   * ledger balance. That keeps the page self-proving: opening plus the column
   * of movements always equals closing, however far back the window starts.
   */
  public AccountStatement getStatement(String accountId, int limit) {
    AccountRow account = accounts.findById(accountId);
    if (account == null) throw HttpError.notFound("ACCOUNT_NOT_FOUND");

    List<StatementLineRow> rows = ledger.statementLines(accountId, limit);
    long ledgerBalanceCents = ledger.ledgerBalanceOf(accountId);

    // The query returns newest first for the LIMIT to mean "most recent".
    List<StatementLineRow> newestFirst = new ArrayList<>(rows);
    Collections.reverse(newestFirst);

    List<StatementLine> chronological = new ArrayList<>(newestFirst.size());
    long movementShown = 0;
    for (StatementLineRow row : newestFirst) {
      chronological.add(
          new StatementLine(
              row.entryGroup(),
              row.paymentId(),
              row.leg(),
              row.direction(),
              row.amountCents(),
              row.createdAt(),
              row.counterparty()));
      movementShown +=
          row.direction() == Direction.CREDIT ? row.amountCents() : -row.amountCents();
    }

    Statement statement = Ledgers.statement(chronological, ledgerBalanceCents - movementShown);

    return new AccountStatement(
        account.id(),
        account.name(),
        account.balanceCents(),
        ledgerBalanceCents == account.balanceCents(),
        statement.openingCents(),
        statement.closingCents(),
        statement.lines());
  }
}
