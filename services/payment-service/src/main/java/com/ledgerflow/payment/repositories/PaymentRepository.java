package com.ledgerflow.payment.repositories;

import com.ledgerflow.payment.db.Rows;
import com.ledgerflow.payment.domain.PaymentStatus;
import com.ledgerflow.payment.domain.SimulateMode;
import com.ledgerflow.payment.models.PaymentModel.PaymentRow;
import java.sql.PreparedStatement;
import java.sql.Types;
import java.time.Instant;
import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

@Repository
public class PaymentRepository {

  private static final RowMapper<PaymentRow> PAYMENT =
      (rs, rowNum) ->
          new PaymentRow(
              rs.getString("id"),
              rs.getString("from_account_id"),
              rs.getString("to_account_id"),
              rs.getLong("amount_cents"),
              rs.getString("note"),
              PaymentStatus.valueOf(rs.getString("status")),
              rs.getString("failure_reason"),
              SimulateMode.valueOf(rs.getString("simulate_mode")),
              rs.getInt("attempts"),
              Rows.instant(rs, "next_attempt_at"),
              Rows.strings(rs, "hold_reasons"),
              rs.getString("correlation_id"),
              Rows.instant(rs, "created_at"),
              Rows.instant(rs, "updated_at"));

  /**
   * @param idempotencyKey only a client-supplied key is persisted - see the
   *     idempotency service.
   * @param holdReasons why the risk screen held it, if it did.
   * @param settleDelayMs milliseconds from now until leg 2 is due.
   */
  public record InsertPaymentParams(
      String fromAccountId,
      String toAccountId,
      long amountCents,
      String note,
      PaymentStatus status,
      String failureReason,
      String idempotencyKey,
      SimulateMode simulateMode,
      List<String> holdReasons,
      int settleDelayMs,
      String correlationId) {}

  private final JdbcTemplate jdbc;

  public PaymentRepository(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  public PaymentRow insert(InsertPaymentParams params) {
    String sql =
        "INSERT INTO payments"
            + "   (from_account_id, to_account_id, amount_cents, note, status,"
            + "    failure_reason, idempotency_key, simulate_mode, hold_reasons,"
            + "    next_attempt_at, correlation_id)"
            + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,"
            + "         now() + (CAST(? AS int) * interval '1 millisecond'), ?)"
            + " RETURNING *";

    List<PaymentRow> rows =
        jdbc.query(
            connection -> {
              PreparedStatement statement = connection.prepareStatement(sql);
              statement.setObject(1, Rows.uuid(params.fromAccountId()));
              statement.setObject(2, Rows.uuid(params.toAccountId()));
              statement.setLong(3, params.amountCents());
              statement.setObject(4, params.note(), Types.VARCHAR);
              statement.setString(5, params.status().name());
              statement.setObject(6, params.failureReason(), Types.VARCHAR);
              statement.setObject(7, params.idempotencyKey(), Types.VARCHAR);
              statement.setString(8, params.simulateMode().name());
              statement.setArray(
                  9, connection.createArrayOf("text", params.holdReasons().toArray()));
              statement.setInt(10, params.settleDelayMs());
              statement.setObject(11, params.correlationId(), Types.VARCHAR);
              return statement;
            },
            PAYMENT);
    return rows.get(0);
  }

  public PaymentRow findById(String id) {
    List<PaymentRow> rows =
        jdbc.query("SELECT * FROM payments WHERE id = ?", PAYMENT, Rows.uuid(id));
    return rows.isEmpty() ? null : rows.get(0);
  }

  /** Locks the row so two concurrent refunds cannot both read the same status. */
  public PaymentRow findByIdForUpdate(String id) {
    List<PaymentRow> rows =
        jdbc.query("SELECT * FROM payments WHERE id = ? FOR UPDATE", PAYMENT, Rows.uuid(id));
    return rows.isEmpty() ? null : rows.get(0);
  }

  public PaymentRow findByIdempotencyKey(String key) {
    List<PaymentRow> rows =
        jdbc.query("SELECT * FROM payments WHERE idempotency_key = ?", PAYMENT, key);
    return rows.isEmpty() ? null : rows.get(0);
  }

  public List<PaymentRow> list(String accountId, int limit) {
    return jdbc.query(
        "SELECT * FROM payments"
            + "  WHERE CAST(? AS uuid) IS NULL"
            + "     OR from_account_id = CAST(? AS uuid)"
            + "     OR to_account_id = CAST(? AS uuid)"
            + "  ORDER BY created_at DESC"
            + "  LIMIT ?",
        PAYMENT,
        accountId,
        accountId,
        accountId,
        limit);
  }

  /**
   * Claims a batch of payments that are due for work.
   *
   * One scheduling clock for both workers: a row is due when its
   * next_attempt_at has passed. The initial settle delay, each retry backoff and
   * the compensation delay are all just different values written into it.
   *
   * SKIP LOCKED means several instances of this service could run without ever
   * processing the same payment twice.
   */
  public List<PaymentRow> claimDue(PaymentStatus status, int limit) {
    return jdbc.query(
        "SELECT * FROM payments"
            + "  WHERE status = ? AND next_attempt_at <= now()"
            + "  ORDER BY next_attempt_at"
            + "    FOR UPDATE SKIP LOCKED"
            + "  LIMIT ?",
        PAYMENT,
        status.name(),
        limit);
  }

  /** Every status change returns updated_at, which becomes the event timestamp. */
  private Instant transition(String sql, Object... params) {
    return jdbc.queryForObject(sql, (rs, rowNum) -> Rows.instant(rs, "updated_at"), params);
  }

  public Instant markCompleted(String id, int attempts) {
    return transition(
        // Clear the reason: it recorded why an earlier attempt failed, and this
        // payment succeeded. A COMPLETED row must not carry a failure.
        "UPDATE payments SET status = 'COMPLETED', attempts = ?, failure_reason = NULL,"
            + "        updated_at = now()"
            + "  WHERE id = ? RETURNING updated_at",
        attempts,
        Rows.uuid(id));
  }

  public Instant markStranded(String id, String reason, int attempts, int compensateDelayMs) {
    return transition(
        "UPDATE payments"
            + "    SET status = 'AWAITING_REFUND', failure_reason = ?, attempts = ?,"
            + "        updated_at = now(),"
            + "        next_attempt_at = now() + (CAST(? AS int) * interval '1 millisecond')"
            + "  WHERE id = ? RETURNING updated_at",
        reason,
        attempts,
        compensateDelayMs,
        Rows.uuid(id));
  }

  public Instant scheduleRetry(String id, int attempts, String reason, long delayMs) {
    return transition(
        "UPDATE payments"
            + "    SET attempts = ?, failure_reason = ?, updated_at = now(),"
            + "        next_attempt_at = now() + (CAST(? AS int) * interval '1 millisecond')"
            + "  WHERE id = ? RETURNING updated_at",
        attempts,
        reason,
        (int) delayMs,
        Rows.uuid(id));
  }

  /** `reason` distinguishes a rejected review from an ordinary stranded refund. */
  public Instant markRefunded(String id, String reason) {
    return transition(
        "UPDATE payments"
            + "    SET status = 'REFUNDED',"
            + "        failure_reason = coalesce(?, failure_reason),"
            + "        updated_at = now()"
            + "  WHERE id = ? RETURNING updated_at",
        reason,
        Rows.uuid(id));
  }

  /**
   * A reviewer released the funds: the payment rejoins the ordinary settlement
   * path rather than being settled here, so there is one route to COMPLETED.
   * `next_attempt_at` is set to now so the settle worker picks it up at once.
   */
  public Instant markApproved(String id) {
    return transition(
        "UPDATE payments"
            + "    SET status = 'PROCESSING', next_attempt_at = now(), updated_at = now()"
            + "  WHERE id = ? AND status = 'HELD_FOR_REVIEW' RETURNING updated_at",
        Rows.uuid(id));
  }

  /** Payments waiting on a reviewer, oldest first - a queue, not a feed. */
  public List<PaymentRow> listHeld(int limit) {
    return jdbc.query(
        "SELECT * FROM payments WHERE status = 'HELD_FOR_REVIEW'"
            + "  ORDER BY created_at LIMIT ?",
        PAYMENT,
        limit);
  }

  /**
   * Has this sender ever successfully moved money to this payee before?
   *
   * A declined payment does not count as knowing someone: it moved nothing, and
   * treating it as a prior relationship would let a rejected attempt whitelist
   * the next one.
   */
  public boolean hasPaidBefore(String fromAccountId, String toAccountId) {
    return Boolean.TRUE.equals(
        jdbc.queryForObject(
            "SELECT EXISTS ("
                + "   SELECT 1 FROM payments"
                + "    WHERE from_account_id = ? AND to_account_id = ?"
                + "      AND status IN ('PROCESSING','HELD_FOR_REVIEW','COMPLETED','AWAITING_REFUND','REFUNDED')"
                + " ) AS exists",
            Boolean.class,
            Rows.uuid(fromAccountId),
            Rows.uuid(toAccountId)));
  }
}
