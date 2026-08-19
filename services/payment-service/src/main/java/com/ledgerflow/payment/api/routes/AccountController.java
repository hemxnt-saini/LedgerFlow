package com.ledgerflow.payment.api.routes;

import com.ledgerflow.payment.api.JsonBody;
import com.ledgerflow.payment.api.Validation;
import com.ledgerflow.payment.models.AccountModel.AccountDto;
import com.ledgerflow.payment.services.AccountService;
import com.ledgerflow.payment.services.AccountService.AccountLimitsView;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AccountController {

  private final AccountService accounts;
  private final JsonBody jsonBody;

  public AccountController(AccountService accounts, JsonBody jsonBody) {
    this.accounts = accounts;
    this.jsonBody = jsonBody;
  }

  @PostMapping("/accounts")
  public ResponseEntity<AccountDto> create(HttpServletRequest request) {
    Map<String, Object> body = jsonBody.read(request);
    String name = Validation.parseAccountName(body.get("name"));
    long openingBalance = Validation.parseOpeningBalance(body.get("initialBalanceCents"));
    return ResponseEntity.status(HttpStatus.CREATED)
        .body(accounts.createAccount(name, openingBalance));
  }

  @GetMapping("/accounts")
  public List<AccountDto> list(
      @RequestParam(name = "includeSystem", required = false) String includeSystem) {
    return accounts.listAccounts("true".equals(includeSystem));
  }

  @GetMapping("/accounts/{id}")
  public AccountDto get(@PathVariable String id) {
    return accounts.getAccount(Validation.requireUuid(id, "INVALID_ACCOUNT_ID"));
  }

  /** Spending controls and how much of today's allowance is gone. */
  @GetMapping("/accounts/{id}/limits")
  public AccountLimitsView limits(@PathVariable String id) {
    return accounts.getLimits(Validation.requireUuid(id, "INVALID_ACCOUNT_ID"));
  }

  /**
   * Change an account's spending controls.
   *
   * A real product would put this behind an operator role. Here it is open,
   * which is also what makes the limits demonstrable - drop the daily cap to
   * $100 and the next payment shows the control refusing.
   */
  @PutMapping("/accounts/{id}/limits")
  public AccountLimitsView setLimits(@PathVariable String id, HttpServletRequest request) {
    return accounts.setLimits(
        Validation.requireUuid(id, "INVALID_ACCOUNT_ID"),
        Validation.parseLimits(jsonBody.read(request)));
  }
}
