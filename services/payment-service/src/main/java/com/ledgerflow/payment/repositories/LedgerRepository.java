package com.ledgerflow.payment.repositories;

import com.ledgerflow.payment.db.Rows;
import com.ledgerflow.payment.domain.Direction;
import com.ledgerflow.payment.domain.Leg;
import com.ledgerflow.payment.domain.Ledgers.AccountTotals;
import com.ledgerflow.payment.domain.Payments.LedgerEntry;
import com.ledgerflow.payment.models.LedgerModel.JournalLineRow;
import com.ledgerflow.payment.models.LedgerModel.LedgerEntryRow;
import com.ledgerflow.payment.models.LedgerModel.StatementLineRow;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

@Repository
public class LedgerRepository {

  private static final RowMapper<LedgerEntryRow> ENTRY =
      (rs, rowNum) ->
          new LedgerEntryRow(
              Leg.valueOf(rs.getString("leg")),
              Direction.valueOf(rs.getString("direction")),
              rs.getLong("amount_cents"),
              rs.getString("account_id"),
              rs.getString("name"),
              Rows.instant(rs, "created_at"));

  private static final RowMapper<JournalLineRow> JOURNAL_LINE =
      (rs, rowNum) ->
          new JournalLineRow(
              rs.getLong("id"),
              rs.getString("entry_group"),
              rs.getString("payment_id"),
              Leg.valueOf(rs.getString("leg")),
              Direction.valueOf(rs.getString("direction")),
              rs.getLong("amount_cents"),
              Rows.instant(rs, "created_at"),
              rs.getString("account_id"),
              rs.getString("name"));

  private static final RowMapper<StatementLineRow> STATEMENT_LINE =
      (rs, rowNum) ->
          new StatementLineRow(
              rs.getString("entry_group"),
              rs.getString("payment_id"),
              Leg.valueOf(rs.getString("leg")),
              Direction.valueOf(rs.getString("direction")),
              rs.getLong("amount_cents"),
              Rows.instant(rs, "created_at"),
              rs.getString("counterparty"));

  private final JdbcTemplate jdbc;

  public LedgerRepository(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  /**
   * Posts one journal entry.
   *
   * Both lines share an `entry_group`, so "every group is exactly one debit and
   * one credit of the same amount" is a property the reconciler can check
   * without knowing anything about payments. Nothing here ever updates or
   * deletes a row - a reversal is two new opposite lines.
   */
  public void postJournal(String paymentId, Leg leg, List<LedgerEntry> entries) {
    UUID entryGroup = UUID.randomUUID();
    for (LedgerEntry entry : entries) {
      jdbc.update(
          "INSERT INTO ledger_entries"
              + "   (entry_group, payment_id, account_id, direction, amount_cents, leg)"
              + " VALUES (?, ?, ?, ?, ?, ?)",
          entryGroup,
          Rows.uuid(paymentId),
          Rows.uuid(entry.accountId()),
          entry.direction().name(),
          entry.amountCents(),
          leg.name());
    }
  }

  /** The audit trail behind one payment, oldest leg first. */
  public List<LedgerEntryRow> findByPaymentId(String paymentId) {
    return jdbc.query(
        "SELECT l.leg, l.direction, l.amount_cents, l.account_id, a.name, l.created_at"
            + "   FROM ledger_entries l"
            + "   JOIN accounts a ON a.id = l.account_id"
            + "  WHERE l.payment_id = ?"
            + "  ORDER BY l.id",
        ENTRY,
        Rows.uuid(paymentId));
  }

  /**
   * Debit and credit totals per account, for the trial balance.
   *
   * sum() over bigint returns numeric, so the explicit ::bigint casts are what
   * keep the report comparing numbers to numbers. Getting this wrong produces a
   * report that claims the books are broken when they are not.
   */
  public Map<String, AccountTotals> accountTotals() {
    Map<String, AccountTotals> totals = new HashMap<>();
    for (Map.Entry<String, AccountTotals> row :
        jdbc.query(
            "SELECT account_id,"
                + "        coalesce(sum(amount_cents) FILTER (WHERE direction = 'DEBIT'),  0)::bigint AS debits,"
                + "        coalesce(sum(amount_cents) FILTER (WHERE direction = 'CREDIT'), 0)::bigint AS credits"
                + "   FROM ledger_entries"
                + "  GROUP BY account_id",
            (rs, rowNum) ->
                Map.entry(
                    rs.getString("account_id"),
                    new AccountTotals(rs.getLong("debits"), rs.getLong("credits"))))) {
      totals.put(row.getKey(), row.getValue());
    }
    return totals;
  }

  /**
   * The general journal: the most recent `limit` entry groups, every line of
   * each one.
   *
   * Paginated by group rather than by row, because half a journal entry is not
   * a meaningful thing to show anyone - the subquery picks whole groups and the
   * outer query then fetches all their lines.
   */
  public List<JournalLineRow> listJournal(int limit, String accountId) {
    return jdbc.query(
        "SELECT l.id, l.entry_group, l.payment_id, l.leg, l.direction, l.amount_cents,"
            + "        l.created_at, l.account_id, a.name"
            + "   FROM ledger_entries l"
            + "   JOIN accounts a ON a.id = l.account_id"
            + "  WHERE l.entry_group IN ("
            + "    SELECT entry_group FROM ledger_entries"
            + "     WHERE CAST(? AS uuid) IS NULL OR account_id = CAST(? AS uuid)"
            + "     GROUP BY entry_group"
            + "     ORDER BY max(id) DESC"
            + "     LIMIT ?"
            + "  )"
            + "  ORDER BY l.id DESC",
        JOURNAL_LINE,
        accountId,
        accountId,
        limit);
  }

  /**
   * One account's lines, newest first, each carrying the name of the other side
   * of its journal entry so a row reads as a sentence rather than an amount.
   */
  public List<StatementLineRow> statementLines(String accountId, int limit) {
    return jdbc.query(
        "SELECT l.entry_group, l.payment_id, l.leg, l.direction, l.amount_cents, l.created_at,"
            + "        (SELECT a.name"
            + "           FROM ledger_entries other"
            + "           JOIN accounts a ON a.id = other.account_id"
            + "          WHERE other.entry_group = l.entry_group AND other.id <> l.id"
            + "          LIMIT 1) AS counterparty"
            + "   FROM ledger_entries l"
            + "  WHERE l.account_id = ?"
            + "  ORDER BY l.id DESC"
            + "  LIMIT ?",
        STATEMENT_LINE,
        Rows.uuid(accountId),
        limit);
  }

  /** Credits minus debits over every line an account has ever had. */
  public long ledgerBalanceOf(String accountId) {
    Long balance =
        jdbc.queryForObject(
            "SELECT coalesce(sum(CASE WHEN direction = 'CREDIT' THEN amount_cents"
                + "                              ELSE -amount_cents END), 0)::bigint AS balance"
                + "   FROM ledger_entries WHERE account_id = ?",
            Long.class,
            Rows.uuid(accountId));
    return balance == null ? 0 : balance;
  }
}
