package com.ledgerflow.query.api.routes;

import com.ledgerflow.query.api.Validation;
import com.ledgerflow.query.config.Config;
import com.ledgerflow.query.services.QueryService;
import com.ledgerflow.query.services.QueryService.Balance;
import com.ledgerflow.query.services.QueryService.Balances;
import com.ledgerflow.query.services.QueryService.Pipeline;
import com.ledgerflow.query.services.QueryService.Stats;
import com.ledgerflow.query.services.QueryService.Transactions;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class QueryController {

  private final QueryService query;

  public QueryController(QueryService query) {
    this.query = query;
  }

  @GetMapping("/accounts/{id}/balance")
  public ResponseEntity<?> balance(@PathVariable String id) {
    Balance balance = query.getBalance(id);
    if (balance == null) {
      // Either the account does not exist, or its event has not been projected
      // yet - eventual consistency, not an error on the write side.
      return ResponseEntity.status(HttpStatus.NOT_FOUND)
          .body(Map.of("error", "ACCOUNT_NOT_IN_READ_MODEL"));
    }
    return ResponseEntity.ok(balance);
  }

  /** All balances in one call, so a dashboard does not need N round trips. */
  @GetMapping("/balances")
  public Balances balances(@RequestParam(required = false) String ids) {
    List<String> wanted = new ArrayList<>();
    for (String id : String.valueOf(ids == null ? "" : ids).split(",")) {
      String trimmed = id.trim();
      if (!trimmed.isEmpty() && wanted.size() < Config.Limits.BULK_BALANCE_IDS) {
        wanted.add(trimmed);
      }
    }
    return query.getBalances(wanted);
  }

  @GetMapping("/accounts/{id}/transactions")
  public Transactions transactions(
      @PathVariable String id, @RequestParam(required = false) String limit) {
    return query.getTransactions(
        id, Validation.clampLimit(limit, 50, Config.Limits.TRANSACTIONS_PAGE_SIZE));
  }

  /**
   * Totals come from counters the projection maintains, not from scanning
   * history - the read side answers in O(1) because the write path already did
   * the arithmetic.
   */
  @GetMapping("/accounts/{id}/stats")
  public Stats stats(@PathVariable String id) {
    return query.getStats(id);
  }

  /** The global "John paid Alice" ticker. */
  @GetMapping("/activity")
  public QueryService.Activity activity(@RequestParam(required = false) String limit) {
    return query.getActivity(Validation.clampLimit(limit, 50, Config.Limits.FEED_PAGE_SIZE));
  }

  /** Measured stage latencies for the pipeline monitor. */
  @GetMapping("/pipeline")
  public Pipeline pipeline(@RequestParam(required = false) String limit) {
    return query.getPipelineTraces(
        Validation.clampLimit(limit, 50, Config.Limits.FEED_PAGE_SIZE));
  }
}
