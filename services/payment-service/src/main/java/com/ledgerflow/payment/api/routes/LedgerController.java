package com.ledgerflow.payment.api.routes;

import com.ledgerflow.payment.api.Validation;
import com.ledgerflow.payment.domain.Ledgers.TrialBalance;
import com.ledgerflow.payment.services.LedgerService;
import com.ledgerflow.payment.services.LedgerService.AccountStatement;
import com.ledgerflow.payment.services.LedgerService.Journal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class LedgerController {

  private final LedgerService ledger;

  public LedgerController(LedgerService ledger) {
    this.ledger = ledger;
  }

  /** Debit column, credit column, and the difference between them. */
  @GetMapping("/ledger/trial-balance")
  public TrialBalance trialBalance() {
    return ledger.getTrialBalance();
  }

  /** The general journal. `accountId` narrows it to entries touching one account. */
  @GetMapping("/ledger/journal")
  public Journal journal(
      @RequestParam(required = false) String accountId,
      @RequestParam(required = false) String limit) {
    String wanted =
        accountId == null || accountId.isEmpty()
            ? null
            : Validation.requireUuid(accountId, "INVALID_ACCOUNT_ID");
    return ledger.getJournal(Validation.clampLimit(limit, 50, 200), wanted);
  }

  /** One account's lines with a running balance. */
  @GetMapping("/ledger/accounts/{id}")
  public AccountStatement statement(
      @PathVariable String id, @RequestParam(required = false) String limit) {
    return ledger.getStatement(
        Validation.requireUuid(id, "INVALID_ACCOUNT_ID"),
        Validation.clampLimit(limit, 100, 500));
  }
}
