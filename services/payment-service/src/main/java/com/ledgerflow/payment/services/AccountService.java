package com.ledgerflow.payment.services;

import com.ledgerflow.payment.config.Config;
import com.ledgerflow.payment.db.Tx;
import com.ledgerflow.payment.domain.Direction;
import com.ledgerflow.payment.domain.Leg;
import com.ledgerflow.payment.domain.Limits.AccountLimits;
import com.ledgerflow.payment.domain.Limits.SpendSoFar;
import com.ledgerflow.payment.domain.Payments.Account;
import com.ledgerflow.payment.domain.Payments.LedgerEntry;
import com.ledgerflow.payment.lib.HttpError;
import com.ledgerflow.payment.lib.Iso;
import com.ledgerflow.payment.models.AccountModel;
import com.ledgerflow.payment.models.AccountModel.AccountDto;
import com.ledgerflow.payment.models.AccountModel.AccountRow;
import com.ledgerflow.payment.repositories.AccountRepository;
import com.ledgerflow.payment.repositories.LedgerRepository;
import com.ledgerflow.payment.repositories.OutboxRepository;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

@Service
public class AccountService {

  /**
   * @param remainingTodayCents headroom left against the daily cap, so a client
   *     can warn before sending.
   */
  public record AccountLimitsView(
      String accountId, AccountLimits limits, Usage usage, long remainingTodayCents) {

    public record Usage(long todayCents, int recentCount, int windowSeconds) {}
  }

  private final Tx tx;
  private final AccountRepository accounts;
  private final LedgerRepository ledger;
  private final OutboxRepository outbox;

  public AccountService(
      Tx tx, AccountRepository accounts, LedgerRepository ledger, OutboxRepository outbox) {
    this.tx = tx;
    this.accounts = accounts;
    this.ledger = ledger;
    this.outbox = outbox;
  }

  /**
   * Opens a wallet.
   *
   * An opening balance is not money appearing from nowhere: it is issued by the
   * funding account, which goes negative by exactly this much. That is what
   * makes the ledger complete - every cent has a provenance, and the balances of
   * all accounts together still sum to zero, which is the invariant the
   * reconciliation control leans on.
   */
  public AccountDto createAccount(String name, long initialBalanceCents) {
    AccountRow row =
        tx.inTransaction(
            () -> {
              AccountRow account = accounts.insert(name, initialBalanceCents);

              if (initialBalanceCents > 0) {
                Map<String, Account> locked =
                    accounts.lockMany(List.of(Config.SystemAccounts.FUNDING_ID));
                Account funding = locked.get(Config.SystemAccounts.FUNDING_ID);
                if (funding == null) throw new HttpError(500, "FUNDING_ACCOUNT_MISSING");

                accounts.updateBalance(
                    funding.id(), funding.balanceCents() - initialBalanceCents);
                ledger.postJournal(
                    null,
                    Leg.FUNDING,
                    List.of(
                        new LedgerEntry(funding.id(), Direction.DEBIT, initialBalanceCents),
                        new LedgerEntry(account.id(), Direction.CREDIT, initialBalanceCents)));
              }

              Map<String, Object> event = new LinkedHashMap<>();
              event.put("accountId", account.id());
              event.put("name", account.name());
              event.put("balanceCents", account.balanceCents());
              event.put("occurredAt", Iso.format(account.createdAt()));
              outbox.enqueue("account.created", event);
              return account;
            });

    return AccountModel.toAccountDto(row);
  }

  /**
   * The system accounts are plumbing, not people - hidden from the wallet's
   * friends list, visible to the developer dashboard.
   */
  public List<AccountDto> listAccounts(boolean includeSystem) {
    List<AccountDto> dtos = new ArrayList<>();
    for (AccountRow row : accounts.findAll(includeSystem)) {
      dtos.add(AccountModel.toAccountDto(row));
    }
    return dtos;
  }

  public AccountDto getAccount(String id) {
    AccountRow row = accounts.findById(id);
    if (row == null) throw HttpError.notFound("ACCOUNT_NOT_FOUND");
    return AccountModel.toAccountDto(row);
  }

  /**
   * An account's spending controls and how much of them it has used.
   *
   * Read outside a transaction and without a lock: this is for showing someone
   * their headroom, not for deciding anything. The number that matters is
   * recomputed under the sender's row lock at authorise time, which is the only
   * place it can be trusted.
   */
  public AccountLimitsView getLimits(String id) {
    AccountLimits limits = accounts.findLimits(id);
    if (limits == null) throw HttpError.notFound("ACCOUNT_NOT_FOUND");

    int windowSeconds = Config.Controls.VELOCITY_WINDOW_SECONDS;
    SpendSoFar usage = accounts.spendSoFar(id, windowSeconds);

    return new AccountLimitsView(
        id,
        limits,
        new AccountLimitsView.Usage(usage.todayCents(), usage.recentCount(), windowSeconds),
        Math.max(0, limits.dailyLimitCents() - usage.todayCents()));
  }

  /** System accounts are plumbing and have no spending controls to set. */
  public AccountLimitsView setLimits(String id, AccountLimits limits) {
    AccountRow updated = tx.inTransaction(() -> accounts.updateLimits(id, limits));
    if (updated == null) throw HttpError.notFound("ACCOUNT_NOT_FOUND");
    return getLimits(id);
  }
}
