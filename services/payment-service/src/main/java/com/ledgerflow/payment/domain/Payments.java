package com.ledgerflow.payment.domain;

import com.ledgerflow.payment.config.Config;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.EnumMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Pure domain logic for the payment service.
 *
 * A payment is a two-step saga, not a single transfer:
 *
 * <pre>
 *     PROCESSING   sender  -&gt; CLEARING   (authorise leg, one DB transaction)
 *        |         ...a real gap: separate transaction, separate worker...
 *        +-------&gt; CLEARING -&gt; receiver  (settle leg, second DB transaction)
 *                    = COMPLETED
 *        |
 *        +-------&gt; settle failed = AWAITING_REFUND (money sits in clearing)
 *                    compensate: CLEARING -&gt; sender = REFUNDED
 * </pre>
 *
 * Money is never in nobody's hands: between the two legs it belongs to the
 * clearing account, so the double-entry ledger balances at every instant even
 * though the payment is only half done. That is what a suspense/clearing
 * account is for, and it is why a "stuck" payment is a recoverable state
 * rather than lost money.
 *
 * Deliberately framework-free - nothing here imports Spring, JDBC, Redis or
 * Kafka. MessageDigest is the standard library. Every function is pure, so
 * these rules could be lifted into an aggregate untouched.
 */
public final class Payments {

  private Payments() {}

  /**
   * JavaScript's integer-safe range. The write side speaks to a TypeScript
   * client and a JSON wire format, so an amount that cannot survive the round
   * trip is not a valid amount however well a long holds it.
   */
  public static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;

  public record Account(String id, long balanceCents) {}

  public record LedgerEntry(String accountId, Direction direction, long amountCents) {}

  /**
   * The outcome of one attempt to move money: either the two new balances and
   * the journal pair, or the reason it was refused.
   */
  public record MoveResult(
      boolean ok,
      long fromBalanceCents,
      long toBalanceCents,
      List<LedgerEntry> entries,
      String failureReason) {

    public static MoveResult applied(long fromBalanceCents, long toBalanceCents, List<LedgerEntry> entries) {
      return new MoveResult(true, fromBalanceCents, toBalanceCents, entries, null);
    }

    public static MoveResult refused(String failureReason) {
      return new MoveResult(false, 0, 0, List.of(), failureReason);
    }
  }

  public static final String INVALID_AMOUNT = "INVALID_AMOUNT";
  public static final String SAME_ACCOUNT = "SAME_ACCOUNT";
  public static final String INSUFFICIENT_FUNDS = "INSUFFICIENT_FUNDS";
  /** A reviewer refused to release funds that were already held. */
  public static final String REJECTED_IN_REVIEW = "REJECTED_IN_REVIEW";

  /** Money is integer cents. Floats and non-positive amounts are never valid. */
  public static boolean isValidAmount(long amountCents) {
    return amountCents > 0 && amountCents <= MAX_SAFE_INTEGER;
  }

  /**
   * The same check at the trust boundary, where the value has come off the
   * wire and may not be a whole number - or a number at all.
   */
  public static boolean isValidAmount(Object amountCents) {
    Long value = asSafeInteger(amountCents);
    return value != null && isValidAmount(value.longValue());
  }

  /**
   * A JSON value read as an integer, or null if it is not one.
   *
   * JSON has a single number type and so does JavaScript, so 2500 and 2500.0
   * are the same value and both are integers - but 2500.5 is not, and neither
   * is the string "2500". Anything outside the safe range is rejected too,
   * because a client could not have sent it precisely.
   */
  public static Long asSafeInteger(Object value) {
    if (value instanceof Integer i) return i.longValue();
    if (value instanceof Long l) return withinSafeRange(l.doubleValue()) ? l : null;
    if (value instanceof Short s) return s.longValue();
    if (value instanceof Byte b) return b.longValue();
    if (value instanceof Double d) return fromDouble(d);
    if (value instanceof Float f) return fromDouble(f.doubleValue());
    if (value instanceof BigDecimal d) {
      try {
        return fromDouble(d.doubleValue());
      } catch (ArithmeticException e) {
        return null;
      }
    }
    if (value instanceof java.math.BigInteger i) return fromDouble(i.doubleValue());
    return null;
  }

  private static Long fromDouble(double value) {
    if (!Double.isFinite(value)) return null;
    if (Math.rint(value) != value) return null;
    if (!withinSafeRange(value)) return null;
    return (long) value;
  }

  private static boolean withinSafeRange(double value) {
    return Math.abs(value) <= (double) MAX_SAFE_INTEGER;
  }

  /**
   * The single money primitive. Every leg of the saga is one of these:
   *
   * <pre>
   *   authorise   moveFunds(sender,   clearing)
   *   settle      moveFunds(clearing, receiver)
   *   compensate  moveFunds(clearing, sender)
   * </pre>
   *
   * One function, so there is exactly one place where a balance can change and
   * exactly one definition of "you cannot spend what you do not have".
   */
  public static MoveResult moveFunds(Account from, Account to, long amountCents) {
    if (!isValidAmount(amountCents)) {
      return MoveResult.refused(INVALID_AMOUNT);
    }
    if (from.id().equals(to.id())) {
      return MoveResult.refused(SAME_ACCOUNT);
    }
    if (from.balanceCents() < amountCents) {
      return MoveResult.refused(INSUFFICIENT_FUNDS);
    }
    return MoveResult.applied(
        from.balanceCents() - amountCents,
        to.balanceCents() + amountCents,
        List.of(
            new LedgerEntry(from.id(), Direction.DEBIT, amountCents),
            new LedgerEntry(to.id(), Direction.CREDIT, amountCents)));
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Only a half-finished payment can be settled. */
  public static boolean canSettle(PaymentStatus status) {
    return status == PaymentStatus.PROCESSING;
  }

  /**
   * Refunds exist for exactly one situation: the sender's money left, the
   * receiver never got it, and it is sitting in clearing. A COMPLETED payment
   * is not refundable - the money arrived, so there is nothing to recover.
   */
  public static boolean canRefund(PaymentStatus status) {
    return status == PaymentStatus.AWAITING_REFUND;
  }

  /** A payment sitting in the review queue, waiting on a decision. */
  public static boolean isUnderReview(PaymentStatus status) {
    return status == PaymentStatus.HELD_FOR_REVIEW;
  }

  /**
   * Statuses whose money can be returned from clearing to the sender.
   *
   * Wider than {@link #canRefund} on purpose: a rejected review compensates by
   * exactly the same route a stranded payment does, but the public refund
   * endpoint must still only accept AWAITING_REFUND. A held payment is
   * resolved by a reviewer approving or rejecting it, not by the payer
   * pressing refund.
   */
  public static boolean canCompensate(PaymentStatus status) {
    return status == PaymentStatus.AWAITING_REFUND || status == PaymentStatus.HELD_FOR_REVIEW;
  }

  /**
   * Money that has left the sender and not yet reached anyone. The clearing
   * account must hold exactly this set, and it is what an account has "spent"
   * for the purposes of a daily cap.
   */
  public static boolean holdsFundsInClearing(PaymentStatus status) {
    return status == PaymentStatus.PROCESSING
        || status == PaymentStatus.HELD_FOR_REVIEW
        || status == PaymentStatus.AWAITING_REFUND;
  }

  public static boolean isTerminal(PaymentStatus status) {
    return status == PaymentStatus.COMPLETED
        || status == PaymentStatus.FAILED
        || status == PaymentStatus.REFUNDED;
  }

  /** Every legal move in the state machine. Anything else is a bug. */
  private static final Map<PaymentStatus, Set<PaymentStatus>> TRANSITIONS =
      new EnumMap<>(
          Map.of(
              // Approving a held payment puts it back on the ordinary settlement
              // path rather than settling it directly, so there is one route to
              // COMPLETED.
              PaymentStatus.HELD_FOR_REVIEW,
              Set.of(PaymentStatus.PROCESSING, PaymentStatus.REFUNDED),
              PaymentStatus.PROCESSING,
              Set.of(PaymentStatus.COMPLETED, PaymentStatus.AWAITING_REFUND),
              PaymentStatus.AWAITING_REFUND,
              Set.of(PaymentStatus.REFUNDED),
              PaymentStatus.COMPLETED,
              Set.of(),
              PaymentStatus.FAILED,
              Set.of(),
              PaymentStatus.REFUNDED,
              Set.of()));

  public static boolean canTransition(PaymentStatus from, PaymentStatus to) {
    return TRANSITIONS.get(from).contains(to);
  }

  // -------------------------------------------------------------------------
  // Retry policy
  // -------------------------------------------------------------------------

  /**
   * How many times settlement is attempted before the payment is given up on
   * and the money returned. Compensating on the first hiccup would unwind
   * perfectly good payments over a momentary blip; never compensating would
   * strand money forever. Both are wrong, so the saga does a bounded number of
   * attempts and then gives the money back.
   */
  public static final int MAX_SETTLE_ATTEMPTS = Config.Saga.MAX_ATTEMPTS;

  private static final long DEFAULT_BASE_MS = 500;
  private static final long DEFAULT_MAX_MS = 30_000;

  /** Exponential backoff with full jitter, capped. Attempt 1 is the first retry. */
  public static long backoffMs(int attempt) {
    return backoffMs(attempt, DEFAULT_BASE_MS, DEFAULT_MAX_MS, 0);
  }

  /**
   * @param jitter 0..1, supplied by the caller rather than generated here so
   *     this stays a pure function. In production it is a random double; in
   *     tests it is fixed. Without it, every worker in a fleet retries in
   *     lockstep and hammers a struggling dependency in synchronised waves.
   */
  public static long backoffMs(int attempt, double jitter) {
    return backoffMs(attempt, DEFAULT_BASE_MS, DEFAULT_MAX_MS, jitter);
  }

  public static long backoffMs(int attempt, long baseMs, long maxMs, double jitter) {
    if (attempt < 1) return 0;
    double exponential = Math.min(baseMs * Math.pow(2, attempt - 1), maxMs);
    // Full jitter: anywhere in [half the delay, the full delay]. Keeps the
    // growth curve while spreading the herd.
    double spread = exponential / 2;
    return Math.round(exponential - spread + spread * Math.min(Math.max(jitter, 0), 1));
  }

  /** True once settlement has failed enough times to stop trying. */
  public static boolean isExhausted(int attempts) {
    return attempts >= MAX_SETTLE_ATTEMPTS;
  }

  /**
   * A transient fault heals: it fails while there are still retries to burn and
   * succeeds on the last one, so the payment completes without ever needing to
   * be refunded. A permanent fault never heals and ends in compensation.
   */
  public static boolean shouldSimulateFailure(SimulateMode mode, int attempts) {
    if (mode == SimulateMode.PERMANENT) return true;
    if (mode == SimulateMode.TRANSIENT) return attempts < MAX_SETTLE_ATTEMPTS - 1;
    return false;
  }

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  /**
   * A stable hash of everything that makes a payment request what it is.
   *
   * Two jobs: it is the auto-derived key when a client sends none, and it is
   * stored alongside a cached response so that reusing one key for a
   * *different* request can be rejected instead of silently returning the
   * wrong payment.
   *
   * The hashed text is the JSON array of the four fields, byte for byte what
   * `JSON.stringify` produced before this service spoke Java - so a key minted
   * by either implementation matches, and a rolling deployment cannot charge
   * anyone twice.
   */
  public static String requestFingerprint(
      String fromAccountId, String toAccountId, long amountCents, String note) {
    // JSON-encoded rather than joined with a separator, so no combination of
    // field values can fingerprint the same as a different combination.
    String json =
        "["
            + jsonString(fromAccountId)
            + ","
            + jsonString(toAccountId)
            + ","
            + amountCents
            + ","
            + jsonString(note == null ? "" : note)
            + "]";
    return sha256Hex(json);
  }

  public static String requestFingerprint(
      String fromAccountId, String toAccountId, long amountCents) {
    return requestFingerprint(fromAccountId, toAccountId, amountCents, "");
  }

  /**
   * The key used when the caller supplies no `Idempotency-Key` header.
   *
   * Deliberately content-derived, not random: a random key would be different
   * on every retry and would protect nobody. Because it is only as unique as
   * the request itself, it is cached for a short window only - it is a
   * double-submit guard, not a permanent payment identity. A client that
   * genuinely needs to send the same amount to the same payee twice in quick
   * succession supplies its own key.
   */
  public static final String DERIVED_KEY_PREFIX = "auto:";

  public static String deriveIdempotencyKey(
      String fromAccountId, String toAccountId, long amountCents, String note) {
    return DERIVED_KEY_PREFIX
        + requestFingerprint(fromAccountId, toAccountId, amountCents, note).substring(0, 32);
  }

  public static String deriveIdempotencyKey(
      String fromAccountId, String toAccountId, long amountCents) {
    return deriveIdempotencyKey(fromAccountId, toAccountId, amountCents, "");
  }

  public static boolean isDerivedKey(String key) {
    return key != null && key.startsWith(DERIVED_KEY_PREFIX);
  }

  private static String sha256Hex(String text) {
    try {
      byte[] digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
      return HexFormat.of().formatHex(digest);
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException("SHA-256 is required by every JVM", e);
    }
  }

  /** JSON string encoding, matching `JSON.stringify` for a string value. */
  private static String jsonString(String value) {
    StringBuilder out = new StringBuilder(value.length() + 2).append('"');
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      switch (c) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        case '\b' -> out.append("\\b");
        case '\f' -> out.append("\\f");
        case '\n' -> out.append("\\n");
        case '\r' -> out.append("\\r");
        case '\t' -> out.append("\\t");
        default -> {
          if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
          else out.append(c);
        }
      }
    }
    return out.append('"').toString();
  }
}
