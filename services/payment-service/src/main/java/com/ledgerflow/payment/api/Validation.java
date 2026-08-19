package com.ledgerflow.payment.api;

import com.ledgerflow.payment.config.Config;
import com.ledgerflow.payment.domain.Limits.AccountLimits;
import com.ledgerflow.payment.domain.Payments;
import com.ledgerflow.payment.domain.SimulateMode;
import com.ledgerflow.payment.lib.HttpError;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The trust boundary. Nothing past this class assumes anything about the shape
 * of a request - if a value got here, it is the right type and within range.
 */
public final class Validation {

  private Validation() {}

  private static final Pattern UUID_RE =
      Pattern.compile(
          "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
          Pattern.CASE_INSENSITIVE);

  public static boolean isUuid(String value) {
    return value != null && UUID_RE.matcher(value).matches();
  }

  public static String requireUuid(String value, String code) {
    if (!isUuid(value)) throw HttpError.badRequest(code);
    return value;
  }

  /**
   * Clamped both ways: a negative limit would become a negative range index,
   * which some stores read as "from the end" and quietly return the wrong slice.
   */
  public static int clampLimit(String raw, int fallback, int max) {
    double wanted = fallback;
    if (raw != null) {
      try {
        double parsed = Double.parseDouble(raw.trim());
        // A zero or unparseable limit means "unspecified", as Number(x) || fallback did.
        wanted = Double.isFinite(parsed) && parsed != 0 ? parsed : fallback;
      } catch (NumberFormatException e) {
        wanted = fallback;
      }
    }
    return (int) Math.min(Math.max(wanted, 1), max);
  }

  public static String parseAccountName(Object value) {
    if (!(value instanceof String text) || text.trim().isEmpty()) {
      throw HttpError.badRequest("NAME_REQUIRED");
    }
    String name = text.trim();
    if (name.length() > Config.Limits.NAME_LENGTH) throw HttpError.badRequest("NAME_TOO_LONG");
    return name;
  }

  public static long parseOpeningBalance(Object value) {
    Long balance = Payments.asSafeInteger(value);
    if (balance == null || balance < 0) throw HttpError.badRequest("INVALID_INITIAL_BALANCE");
    return balance;
  }

  /** A limit is a non-negative whole number of cents; zero means "blocked". */
  private static long parseCap(Object value, String code, long max) {
    Long cap = Payments.asSafeInteger(value);
    if (cap == null || cap < 0 || cap > max) throw HttpError.badRequest(code);
    return cap;
  }

  public static AccountLimits parseLimits(Map<String, Object> body) {
    return new AccountLimits(
        parseCap(body.get("maxPaymentCents"), "INVALID_MAX_PAYMENT", Config.Limits.MAX_LIMIT_CENTS),
        parseCap(body.get("dailyLimitCents"), "INVALID_DAILY_LIMIT", Config.Limits.MAX_LIMIT_CENTS),
        (int) parseCap(body.get("velocityMax"), "INVALID_VELOCITY_MAX", 10_000));
  }

  public static String parseNote(Object value) {
    if (value == null) return null;
    if (!(value instanceof String text)) throw HttpError.badRequest("INVALID_NOTE");
    if (text.length() > Config.Limits.NOTE_LENGTH) throw HttpError.badRequest("NOTE_TOO_LONG");
    String trimmed = text.trim();
    return trimmed.isEmpty() ? null : trimmed;
  }

  /**
   * How the settle leg should be made to fail, for demonstrating the saga.
   * `simulate` is the current field; the older boolean `simulateFailure: true`
   * is still accepted and means "permanent".
   */
  public static SimulateMode parseSimulateMode(Object simulate, Object simulateFailure) {
    SimulateMode mode = SimulateMode.NONE;

    if (simulateFailure != null) {
      if (!(simulateFailure instanceof Boolean flag)) {
        throw HttpError.badRequest("INVALID_SIMULATE_FAILURE");
      }
      if (flag) mode = SimulateMode.PERMANENT;
    }

    if (simulate != null) {
      String wanted = String.valueOf(simulate).toUpperCase();
      try {
        mode = SimulateMode.valueOf(wanted);
      } catch (IllegalArgumentException e) {
        throw HttpError.badRequest("INVALID_SIMULATE_MODE");
      }
    }

    return mode;
  }

  public static String parseIdempotencyKey(String header) {
    String key = header == null || header.trim().isEmpty() ? null : header.trim();
    if (key != null && key.length() > Config.Limits.IDEMPOTENCY_KEY_LENGTH) {
      throw HttpError.badRequest("IDEMPOTENCY_KEY_TOO_LONG");
    }
    return key;
  }

  public record ValidatedTransfer(String fromAccountId, String toAccountId, long amountCents) {}

  public static ValidatedTransfer parseTransfer(Map<String, Object> body) {
    String fromAccountId = String.valueOf(body.get("fromAccountId"));
    String toAccountId = String.valueOf(body.get("toAccountId"));

    if (!isUuid(fromAccountId) || !isUuid(toAccountId)) {
      throw HttpError.badRequest("INVALID_ACCOUNT_ID");
    }
    Long amountCents = Payments.asSafeInteger(body.get("amountCents"));
    if (amountCents == null || !Payments.isValidAmount(amountCents.longValue())) {
      throw HttpError.badRequest("INVALID_AMOUNT");
    }
    if (fromAccountId.equals(toAccountId)) throw HttpError.badRequest("SAME_ACCOUNT");

    // The clearing and funding accounts are plumbing. Letting a client move
    // money in or out of them directly would put the ledger's invariants at the
    // mercy of the API.
    List<String> systemIds =
        List.of(Config.SystemAccounts.CLEARING_ID, Config.SystemAccounts.FUNDING_ID);
    if (systemIds.contains(fromAccountId) || systemIds.contains(toAccountId)) {
      throw HttpError.badRequest("SYSTEM_ACCOUNT_NOT_PAYABLE");
    }

    return new ValidatedTransfer(fromAccountId, toAccountId, amountCents);
  }
}
