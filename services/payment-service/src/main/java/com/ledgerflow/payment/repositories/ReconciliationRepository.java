package com.ledgerflow.payment.repositories;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ledgerflow.payment.db.Rows;
import com.ledgerflow.payment.domain.Reconciliations.AccountSnapshot;
import com.ledgerflow.payment.domain.Reconciliations.Finding;
import com.ledgerflow.payment.domain.Reconciliations.LedgerTotals;
import com.ledgerflow.payment.domain.Reconciliations.ReconciliationReport;
import com.ledgerflow.payment.domain.Reconciliations.Severity;
import com.ledgerflow.payment.domain.Reconciliations.UnbalancedJournal;
import com.ledgerflow.payment.models.ReconciliationModel.ReconciliationRunRow;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

@Repository
public class ReconciliationRepository {

  /** @param hasPendingWork true when unpublished events or in-flight payments could explain a lag. */
  public record LedgerSnapshot(
      List<AccountSnapshot> accounts,
      Map<String, LedgerTotals> ledger,
      List<UnbalancedJournal> unbalancedJournals,
      long inFlightCents,
      boolean hasPendingWork) {}

  public record DriftedAccount(String id, String name, long cachedCents, long ledgerCents) {}

  private static final TypeReference<List<Finding>> FINDINGS = new TypeReference<>() {};

  private final JdbcTemplate jdbc;
  private final ObjectMapper mapper;
  private final RowMapper<ReconciliationRunRow> run;

  public ReconciliationRepository(JdbcTemplate jdbc, ObjectMapper mapper) {
    this.jdbc = jdbc;
    this.mapper = mapper;
    this.run = runRowMapper();
  }

  private RowMapper<ReconciliationRunRow> runRowMapper() {
    return
      (rs, rowNum) -> {
        String findingsJson = rs.getString("findings");
        List<Finding> findings;
        try {
          findings = findingsJson == null ? List.of() : mapper.readValue(findingsJson, FINDINGS);
        } catch (Exception e) {
          findings = List.of();
        }
        return new ReconciliationRunRow(
            rs.getLong("id"),
            Rows.instant(rs, "started_at"),
            Rows.instant(rs, "finished_at"),
            Severity.valueOf(rs.getString("status")),
            rs.getInt("checked_accounts"),
            rs.getLong("drift_cents"),
            findings,
            Rows.integer(rs, "duration_ms"));
      };
  }

  /**
   * Reads the raw numbers the control compares.
   *
   * Deliberately its own set of queries rather than reusing the repositories the
   * write path uses - a control that shares the write path's assumptions checks
   * nothing.
   *
   * Every aggregate is cast to bigint: sum() over bigint yields numeric, and
   * comparing that to a plain integer is how a false drift alarm gets raised.
   */
  public LedgerSnapshot snapshot() {
    List<AccountSnapshot> accounts =
        jdbc.query(
            "SELECT id, name, balance_cents, is_system FROM accounts",
            (rs, rowNum) ->
                new AccountSnapshot(
                    rs.getString("id"),
                    rs.getString("name"),
                    rs.getLong("balance_cents"),
                    rs.getBoolean("is_system")));

    Map<String, LedgerTotals> ledger = new HashMap<>();
    for (Map.Entry<String, LedgerTotals> row :
        jdbc.query(
            "SELECT account_id,"
                + "        coalesce(sum(amount_cents) FILTER (WHERE direction = 'CREDIT'), 0)::bigint AS credits,"
                + "        coalesce(sum(amount_cents) FILTER (WHERE direction = 'DEBIT'),  0)::bigint AS debits"
                + "   FROM ledger_entries GROUP BY account_id",
            (rs, rowNum) ->
                Map.entry(
                    rs.getString("account_id"),
                    new LedgerTotals(rs.getLong("credits"), rs.getLong("debits"))))) {
      ledger.put(row.getKey(), row.getValue());
    }

    // Any journal that is not exactly one debit and one credit netting zero.
    List<UnbalancedJournal> unbalancedJournals =
        jdbc.query(
            "SELECT entry_group, count(*)::int AS lines,"
                + "        sum(CASE WHEN direction = 'CREDIT' THEN amount_cents ELSE -amount_cents END)::bigint AS net"
                + "   FROM ledger_entries"
                + "  GROUP BY entry_group"
                + " HAVING count(*) <> 2"
                + "     OR sum(CASE WHEN direction = 'CREDIT' THEN amount_cents ELSE -amount_cents END) <> 0"
                + "  LIMIT 50",
            (rs, rowNum) ->
                new UnbalancedJournal(
                    rs.getString("entry_group"), rs.getInt("lines"), rs.getLong("net")));

    // Everything the clearing account is holding. A held payment has been
    // authorised, so its money is in clearing exactly like a processing one.
    Long inFlight =
        jdbc.queryForObject(
            "SELECT coalesce(sum(amount_cents), 0)::bigint AS total FROM payments"
                + "  WHERE status IN ('PROCESSING','HELD_FOR_REVIEW','AWAITING_REFUND')",
            Long.class);

    // Work the system will finish by itself, which is the only kind that
    // excuses a lagging read model. HELD_FOR_REVIEW is deliberately absent:
    // it waits on a person and could sit there for days, and treating that
    // as "still catching up" would downgrade genuine drift to a warning for
    // as long as one payment stayed in the queue.
    boolean hasPendingWork =
        Boolean.TRUE.equals(
            jdbc.queryForObject(
                "SELECT ((SELECT count(*) FROM outbox WHERE published_at IS NULL) > 0"
                    + "     OR (SELECT count(*) FROM payments"
                    + "          WHERE status IN ('PROCESSING','AWAITING_REFUND')) > 0) AS pending",
                Boolean.class));

    return new LedgerSnapshot(
        accounts,
        ledger,
        unbalancedJournals,
        inFlight == null ? 0 : inFlight,
        hasPendingWork);
  }

  public long insertRun(ReconciliationReport report, long durationMs) {
    String findings;
    try {
      findings = mapper.writeValueAsString(report.findings());
    } catch (Exception e) {
      throw new IllegalStateException("cannot serialise findings", e);
    }
    Long id =
        jdbc.queryForObject(
            "INSERT INTO reconciliation_runs"
                + "   (finished_at, status, checked_accounts, drift_cents, findings, duration_ms)"
                + " VALUES (now(), ?, ?, ?, CAST(? AS jsonb), ?) RETURNING id",
            Long.class,
            report.status().name(),
            report.checkedAccounts(),
            report.driftCents(),
            findings,
            (int) durationMs);
    return id == null ? 0 : id;
  }

  public List<ReconciliationRunRow> listRuns(int limit) {
    return jdbc.query(
        "SELECT * FROM reconciliation_runs ORDER BY id DESC LIMIT ?", run, limit);
  }

  /**
   * Accounts whose cached balance disagrees with their own journal lines.
   *
   * The same comparison the control makes, but returning the rows rather than a
   * verdict - repair needs to know which ones and by how much.
   */
  public List<DriftedAccount> findDrifted() {
    List<DriftedAccount> everyAccount =
        jdbc.query(
            "SELECT a.id, a.name, a.balance_cents,"
                + "        coalesce((SELECT sum(CASE WHEN l.direction = 'CREDIT' THEN l.amount_cents"
                + "                                  ELSE -l.amount_cents END)"
                + "                    FROM ledger_entries l WHERE l.account_id = a.id), 0)::bigint AS ledger_cents"
                + "   FROM accounts a",
            (rs, rowNum) ->
                new DriftedAccount(
                    rs.getString("id"),
                    rs.getString("name"),
                    rs.getLong("balance_cents"),
                    rs.getLong("ledger_cents")));

    List<DriftedAccount> drifted = new ArrayList<>();
    for (DriftedAccount account : everyAccount) {
      if (account.cachedCents() != account.ledgerCents()) drifted.add(account);
    }
    return drifted;
  }

  /** Sets a cached balance back to what the journal says it should be. */
  public void setBalance(String accountId, long balanceCents) {
    jdbc.update(
        "UPDATE accounts SET balance_cents = ? WHERE id = ?", balanceCents, Rows.uuid(accountId));
  }

  /**
   * Moves a balance without posting a journal entry for it - the exact
   * corruption the control exists to catch. Demo only.
   */
  public Map<String, String> injectDrift(long driftCents) {
    List<Map<String, String>> rows =
        jdbc.query(
            "UPDATE accounts SET balance_cents = balance_cents + ?"
                + "  WHERE id = (SELECT id FROM accounts WHERE NOT is_system ORDER BY random() LIMIT 1)"
                + "  RETURNING id, name",
            (rs, rowNum) -> Map.of("id", rs.getString("id"), "name", rs.getString("name")),
            driftCents);
    return rows.isEmpty() ? null : rows.get(0);
  }
}
