package com.ledgerflow.payment.services;

import com.ledgerflow.payment.config.Config;
import com.ledgerflow.payment.db.Tx;
import com.ledgerflow.payment.domain.Reconciliations;
import com.ledgerflow.payment.domain.Reconciliations.AccountSnapshot;
import com.ledgerflow.payment.domain.Reconciliations.Finding;
import com.ledgerflow.payment.domain.Reconciliations.FindingCode;
import com.ledgerflow.payment.domain.Reconciliations.ReconciliationInput;
import com.ledgerflow.payment.domain.Reconciliations.ReconciliationReport;
import com.ledgerflow.payment.domain.Reconciliations.Severity;
import com.ledgerflow.payment.lib.HttpError;
import com.ledgerflow.payment.lib.Iso;
import com.ledgerflow.payment.lib.Log;
import com.ledgerflow.payment.models.ReconciliationModel;
import com.ledgerflow.payment.models.ReconciliationModel.ReconciliationRunDto;
import com.ledgerflow.payment.models.ReconciliationModel.ReconciliationRunRow;
import com.ledgerflow.payment.repositories.OutboxRepository;
import com.ledgerflow.payment.repositories.ReconciliationRepository;
import com.ledgerflow.payment.repositories.ReconciliationRepository.DriftedAccount;
import com.ledgerflow.payment.repositories.ReconciliationRepository.LedgerSnapshot;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.data.redis.connection.StringRedisConnection;
import org.springframework.data.redis.core.RedisCallback;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

@Service
public class ReconciliationService {

  public record ReconciliationResult(
      Severity status,
      List<Finding> findings,
      int checkedAccounts,
      long driftCents,
      long id,
      long durationMs) {}

  public record Repaired(
      String accountId, String accountName, long fromCents, long toCents) {}

  /** @param correctedCents total absolute correction applied, in cents. */
  public record RepairResult(List<Repaired> repaired, long correctedCents) {}

  public record InjectedDrift(String accountId, String accountName, long driftCents) {}

  /** The latest verdict plus recent history, so drift has a first sighting. */
  public record Runs(ReconciliationRunDto latest, List<ReconciliationRunDto> history) {}

  private final Tx tx;
  private final ReconciliationRepository runs;
  private final OutboxRepository outbox;
  private final StringRedisTemplate redis;

  public ReconciliationService(
      Tx tx,
      ReconciliationRepository runs,
      OutboxRepository outbox,
      StringRedisTemplate redis) {
    this.tx = tx;
    this.runs = runs;
    this.outbox = outbox;
    this.redis = redis;
  }

  /**
   * Reads the read model's view of every wallet, so the control can compare the
   * two stores. Best-effort: Redis being unreachable is not a ledger fault, so
   * the cross-store check is simply skipped.
   */
  private Map<String, Long> readModelBalances(List<String> accountIds) {
    if (accountIds.isEmpty()) return Map.of();
    try {
      List<Object> results =
          redis.executePipelined(
              (RedisCallback<Object>)
                  connection -> {
                    StringRedisConnection strings = (StringRedisConnection) connection;
                    for (String id : accountIds) strings.hGet("account:" + id, "balanceCents");
                    return null;
                  });

      Map<String, Long> balances = new LinkedHashMap<>();
      for (int index = 0; index < accountIds.size(); index++) {
        Object value = index < results.size() ? results.get(index) : null;
        if (value instanceof String text && !text.isEmpty()) {
          try {
            balances.put(accountIds.get(index), Long.parseLong(text));
          } catch (NumberFormatException ignored) {
            // A value we cannot read is not a balance we can compare.
          }
        }
      }
      return balances;
    } catch (Exception e) {
      return null;
    }
  }

  /**
   * Runs the control: pull the raw numbers, hand them to the pure `reconcile`,
   * record the verdict, and shout if the books do not agree with themselves.
   */
  public ReconciliationResult runReconciliation() {
    long startedAt = System.currentTimeMillis();
    LedgerSnapshot snapshot = runs.snapshot();

    List<String> walletIds = new ArrayList<>();
    for (AccountSnapshot account : snapshot.accounts()) {
      if (!account.isSystem()) walletIds.add(account.id());
    }

    ReconciliationReport report =
        Reconciliations.reconcile(
            new ReconciliationInput(
                snapshot.accounts(),
                snapshot.ledger(),
                snapshot.unbalancedJournals(),
                Config.SystemAccounts.CLEARING_ID,
                snapshot.inFlightCents(),
                readModelBalances(walletIds),
                // A disagreement only counts as a fault when there is no outstanding
                // work to explain it. Eventual consistency is the design, not a defect.
                snapshot.hasPendingWork()));

    long durationMs = System.currentTimeMillis() - startedAt;

    long runId =
        tx.inTransaction(
            () -> {
              long id = runs.insertRun(report, durationMs);
              // Drift goes onto the topic like any other fact, so a future alerting
              // consumer learns about it the same way everything else does.
              if (report.status() != Severity.OK) {
                List<String> codes = new ArrayList<>();
                for (FindingCode code : Reconciliations.distinctCodes(report.findings())) {
                  codes.add(code.name());
                }
                Map<String, Object> event = new LinkedHashMap<>();
                event.put("runId", id);
                event.put("reconciliationStatus", report.status().name());
                event.put("driftCents", report.driftCents());
                event.put("findingCount", report.findings().size());
                event.put("codes", codes);
                event.put("occurredAt", Iso.format(Instant.now()));
                outbox.enqueue("reconciliation.drift_detected", event);
              }
              return id;
            });

    Object[] fields = {
      "runId", runId,
      "driftCents", report.driftCents(),
      "findings", report.findings().size(),
      "checkedAccounts", report.checkedAccounts(),
      "durationMs", durationMs
    };
    if (report.status() == Severity.DRIFT) {
      Object[] withDetail = new Object[fields.length + 2];
      System.arraycopy(fields, 0, withDetail, 0, fields.length);
      withDetail[fields.length] = "detail";
      withDetail[fields.length + 1] = report.findings();
      Log.error("BOOKS DO NOT BALANCE", withDetail);
    } else if (report.status() == Severity.WARN) {
      Log.warn("reconciliation warnings (read model catching up)", fields);
    } else {
      Log.info("reconciliation ok", fields);
    }

    return new ReconciliationResult(
        report.status(),
        report.findings(),
        report.checkedAccounts(),
        report.driftCents(),
        runId,
        durationMs);
  }

  /**
   * Remediation: recompute every cached balance from the journal.
   *
   * Detecting drift and fixing it are separate jobs, and this is the fix. It is
   * safe precisely because the journal is append-only - the ledger is never the
   * thing that needs repairing, only the balance cached alongside it, so the
   * correct value is always recoverable by adding the lines back up.
   *
   * Nothing is posted to the ledger here. Writing a correcting journal entry
   * would be wrong: no money moved, a number was simply stale.
   */
  public RepairResult repairBalances() {
    return tx.inTransaction(
        () -> {
          List<DriftedAccount> drifted = runs.findDrifted();
          for (DriftedAccount account : drifted) {
            runs.setBalance(account.id(), account.ledgerCents());
          }

          List<Repaired> repaired = new ArrayList<>();
          long correctedCents = 0;
          for (DriftedAccount account : drifted) {
            repaired.add(
                new Repaired(
                    account.id(), account.name(), account.cachedCents(), account.ledgerCents()));
            correctedCents += Math.abs(account.cachedCents() - account.ledgerCents());
          }

          if (!drifted.isEmpty()) {
            Log.warn(
                "repaired cached balances from the journal",
                "accounts",
                drifted.size(),
                "correctedCents",
                correctedCents);
          }
          return new RepairResult(List.copyOf(repaired), correctedCents);
        });
  }

  /**
   * Breaks the books on purpose, so the control can be watched catching it.
   *
   * Deliberately changes a balance without a journal entry, which is the one
   * thing the whole double-entry design is meant to make impossible through the
   * API. Reachable only when demo endpoints are enabled.
   */
  public InjectedDrift injectDrift(long driftCents) {
    Map<String, String> account = tx.inTransaction(() -> runs.injectDrift(driftCents));
    if (account == null) throw new HttpError(409, "NO_ACCOUNTS_TO_DRIFT");

    Log.warn("DEMO: injected balance drift", "accountId", account.get("id"), "driftCents", driftCents);
    return new InjectedDrift(account.get("id"), account.get("name"), driftCents);
  }

  public Runs listRuns(int limit) {
    List<ReconciliationRunRow> rows = runs.listRuns(limit);
    List<ReconciliationRunDto> history = new ArrayList<>();
    for (ReconciliationRunRow row : rows) {
      history.add(ReconciliationModel.toReconciliationRunDto(row));
    }
    return new Runs(history.isEmpty() ? null : history.get(0), history);
  }
}
