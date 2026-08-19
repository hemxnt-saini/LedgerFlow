package com.ledgerflow.payment.repositories;

import com.ledgerflow.payment.db.Rows;
import com.ledgerflow.payment.domain.Limits.AccountLimits;
import com.ledgerflow.payment.domain.Limits.SpendSoFar;
import com.ledgerflow.payment.domain.Payments.Account;
import com.ledgerflow.payment.models.AccountModel.AccountRow;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

@Repository
public class AccountRepository {

  private static final String COLUMNS = "id, name, balance_cents, is_system, created_at";

  private static final RowMapper<AccountRow> ACCOUNT =
      (rs, rowNum) ->
          new AccountRow(
              rs.getString("id"),
              rs.getString("name"),
              rs.getLong("balance_cents"),
              rs.getBoolean("is_system"),
              Rows.instant(rs, "created_at"));

  private final JdbcTemplate jdbc;

  public AccountRepository(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  public AccountRow insert(String name, long balanceCents) {
    return jdbc.queryForObject(
        "INSERT INTO accounts (name, balance_cents) VALUES (?, ?) RETURNING " + COLUMNS,
        ACCOUNT,
        name,
        balanceCents);
  }

  public List<AccountRow> findAll(boolean includeSystem) {
    return jdbc.query(
        "SELECT "
            + COLUMNS
            + " FROM accounts"
            + " WHERE CAST(? AS boolean) OR NOT is_system"
            + " ORDER BY is_system, created_at",
        ACCOUNT,
        includeSystem);
  }

  public AccountRow findById(String id) {
    List<AccountRow> rows =
        jdbc.query(
            "SELECT " + COLUMNS + " FROM accounts WHERE id = ?", ACCOUNT, Rows.uuid(id));
    return rows.isEmpty() ? null : rows.get(0);
  }

  /**
   * Locks accounts with SELECT ... FOR UPDATE, always in ascending id order.
   *
   * Every leg of every saga acquires its locks through this method, so
   * concurrent payments queue instead of deadlocking on each other's rows. The
   * ordering is the entire point - two payments touching the same pair in
   * opposite directions would otherwise each hold what the other needs.
   *
   * ponytail: every payment locks the single clearing row, so throughput is
   * bounded by one account. Shard the clearing account if that ever matters.
   */
  public Map<String, Account> lockMany(List<String> ids) {
    Map<String, Account> locked = new LinkedHashMap<>();
    for (String id : new TreeSet<>(ids)) {
      List<Account> rows =
          jdbc.query(
              "SELECT id, balance_cents FROM accounts WHERE id = ? FOR UPDATE",
              (rs, rowNum) -> new Account(rs.getString("id"), rs.getLong("balance_cents")),
              Rows.uuid(id));
      if (!rows.isEmpty()) locked.put(id, rows.get(0));
    }
    return locked;
  }

  public void updateBalance(String id, long balanceCents) {
    jdbc.update(
        "UPDATE accounts SET balance_cents = ? WHERE id = ?", balanceCents, Rows.uuid(id));
  }

  public AccountLimits findLimits(String id) {
    List<AccountLimits> rows =
        jdbc.query(
            "SELECT max_payment_cents, daily_limit_cents, velocity_max FROM accounts WHERE id = ?",
            (rs, rowNum) ->
                new AccountLimits(
                    rs.getLong("max_payment_cents"),
                    rs.getLong("daily_limit_cents"),
                    rs.getInt("velocity_max")),
            Rows.uuid(id));
    return rows.isEmpty() ? null : rows.get(0);
  }

  public AccountRow updateLimits(String id, AccountLimits limits) {
    List<AccountRow> rows =
        jdbc.query(
            "UPDATE accounts"
                + "    SET max_payment_cents = ?, daily_limit_cents = ?, velocity_max = ?"
                + "  WHERE id = ? AND NOT is_system"
                + "  RETURNING "
                + COLUMNS,
            ACCOUNT,
            limits.maxPaymentCents(),
            limits.dailyLimitCents(),
            limits.velocityMax(),
            Rows.uuid(id));
    return rows.isEmpty() ? null : rows.get(0);
  }

  /**
   * What this account has already spent, for the limit check.
   *
   * Counts only payments that actually took funds. A declined payment moved
   * nothing and must not consume an allowance, and a refunded one gave the money
   * back. Velocity counts the same set rather than every attempt, so a run of
   * insufficient-funds declines cannot rate-limit someone out of their own
   * wallet.
   *
   * Must be called with the sender's row already locked. Under READ COMMITTED
   * this sees everything committed before the statement began, and the row lock
   * is what guarantees no concurrent payment from the same sender can commit
   * between this read and ours.
   */
  public SpendSoFar spendSoFar(String accountId, int velocityWindowSeconds) {
    return jdbc.queryForObject(
        "SELECT"
            + "   coalesce(sum(amount_cents)"
            + "     FILTER (WHERE created_at >= date_trunc('day', now())), 0)::bigint AS today_cents,"
            + "   count(*)"
            + "     FILTER (WHERE created_at >= now() - make_interval(secs => CAST(? AS double precision)))::int AS recent_count"
            + "   FROM payments"
            + "  WHERE from_account_id = ?"
            + "    AND status IN ('PROCESSING','HELD_FOR_REVIEW','COMPLETED','AWAITING_REFUND')",
        (rs, rowNum) -> new SpendSoFar(rs.getLong("today_cents"), rs.getInt("recent_count")),
        velocityWindowSeconds,
        Rows.uuid(accountId));
  }

  /** Accounts as the ledger reports need them: id, name, balance, system flag. */
  public List<com.ledgerflow.payment.domain.Ledgers.AccountRef> findAllRefs(boolean includeSystem) {
    List<com.ledgerflow.payment.domain.Ledgers.AccountRef> refs = new ArrayList<>();
    for (AccountRow row : findAll(includeSystem)) {
      refs.add(
          new com.ledgerflow.payment.domain.Ledgers.AccountRef(
              row.id(), row.name(), row.balanceCents(), row.isSystem()));
    }
    return refs;
  }
}
