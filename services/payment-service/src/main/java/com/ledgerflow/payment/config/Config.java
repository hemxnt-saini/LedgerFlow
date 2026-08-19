package com.ledgerflow.payment.config;

/**
 * Every environment variable this service reads, in one place.
 *
 * Nothing else in the codebase touches the environment, so the full set of
 * knobs is discoverable here rather than scattered across a dozen classes -
 * and a missing or mistyped variable fails in one obvious spot.
 *
 * Static and final because every one of these is fixed at boot. That also
 * keeps the domain package free of Spring: a pure function can read a limit
 * without being handed a bean.
 */
public final class Config {

  private Config() {}

  static String text(String name, String fallback) {
    String value = System.getenv(name);
    return value == null || value.isEmpty() ? fallback : value;
  }

  /** Mirrors the TypeScript `num()`: anything unparseable falls back. */
  static int num(String name, int fallback) {
    String value = System.getenv(name);
    if (value == null) return fallback;
    try {
      double parsed = Double.parseDouble(value.trim());
      return Double.isFinite(parsed) ? (int) parsed : fallback;
    } catch (NumberFormatException e) {
      return fallback;
    }
  }

  public static final String SERVICE_NAME = text("SERVICE_NAME", "payment-service");
  public static final int PORT = num("PORT", 4000);
  public static final String LOG_LEVEL = text("LOG_LEVEL", "info");

  public static final String DATABASE_URL =
      text("DATABASE_URL", "postgres://payments:payments@localhost:5432/payments");
  public static final String REDIS_URL = text("REDIS_URL", "redis://localhost:6379");

  public static final class Kafka {
    private Kafka() {}
    public static final String CLIENT_ID = "payment-service";
    public static final String BROKERS = text("KAFKA_BROKERS", "localhost:9094");
    public static final String TOPIC = text("KAFKA_TOPIC", "payment-events");
  }

  /**
   * A client-supplied key is a promise about a specific payment, so it is
   * remembered for a day. A key we derived ourselves is only a double-submit
   * guard, so it expires in a minute - otherwise a legitimate repeat payment
   * of the same amount would be swallowed.
   */
  public static final class Idempotency {
    private Idempotency() {}
    public static final int TTL_SECONDS = num("IDEMPOTENCY_TTL", 86_400);
    public static final int DERIVED_TTL_SECONDS = num("DERIVED_IDEMPOTENCY_TTL", 60);
  }

  public static final class Saga {
    private Saga() {}
    /**
     * How long a payment sits in PROCESSING before the settle leg runs. An
     * artificial pause that makes the half-finished state long enough to see,
     * which is the whole point of modelling the saga instead of one atomic
     * transfer. Set it to 0 for a snappier demo.
     */
    public static final int SETTLE_DELAY_MS = num("SETTLE_DELAY_MS", 900);
    /** How long stranded money stays visible before it is returned. */
    public static final int COMPENSATE_DELAY_MS = num("COMPENSATE_DELAY_MS", 4_000);
    public static final int POLL_MS = num("SAGA_POLL_MS", 300);
    public static final int BATCH_SIZE = 20;
    /** Settlement attempts before the money is given back. */
    public static final int MAX_ATTEMPTS = num("MAX_SETTLE_ATTEMPTS", 3);
  }

  public static final class Outbox {
    private Outbox() {}
    public static final int POLL_MS = num("OUTBOX_POLL_MS", 400);
    public static final int BATCH_SIZE = 100;
  }

  public static final class Reconciliation {
    private Reconciliation() {}
    public static final int INTERVAL_MS = num("RECONCILE_INTERVAL_MS", 15_000);
  }

  /**
   * Default spending controls applied to a new wallet.
   *
   * Deliberately small enough that the limits can be reached in a
   * demonstration rather than only in theory. Per-account values live on the
   * `accounts` row and can be changed through the API; these are what a new
   * account starts with.
   */
  public static final class Controls {
    private Controls() {}
    public static final long MAX_PAYMENT_CENTS = num("DEFAULT_MAX_PAYMENT_CENTS", 100_000); // $1,000
    public static final long DAILY_LIMIT_CENTS = num("DEFAULT_DAILY_LIMIT_CENTS", 250_000); // $2,500
    public static final int VELOCITY_MAX = num("DEFAULT_VELOCITY_MAX", 8);
    public static final int VELOCITY_WINDOW_SECONDS = num("VELOCITY_WINDOW_SECONDS", 60);
  }

  /**
   * When a payment is worth a person looking at before the funds are released.
   *
   * Low thresholds on purpose: a review queue that never fills is not a review
   * queue anyone can see working. A real deployment would tune these from
   * observed fraud rates, not from what makes a good demonstration.
   */
  public static final class Risk {
    private Risk() {}
    public static final long LARGE_AMOUNT_CENTS = num("RISK_LARGE_AMOUNT_CENTS", 50_000); // $500
    public static final long NEW_PAYEE_AMOUNT_CENTS = num("RISK_NEW_PAYEE_CENTS", 20_000); // $200
    public static final int RAPID_FIRE_COUNT = num("RISK_RAPID_FIRE_COUNT", 5);
  }

  /**
   * Endpoints that exist to break things on purpose, so the controls can be
   * seen working rather than taken on trust.
   *
   * On by default because this project is a demonstration, and behind a switch
   * because an endpoint that corrupts a balance has no business being reachable
   * anywhere else. Same reasoning as `simulateMode` on a payment.
   */
  public static final class Demo {
    private Demo() {}
    public static final boolean ENABLED = !"false".equals(text("DEMO_ENDPOINTS", "true"));
  }

  /** Input caps at the trust boundary. */
  public static final class Limits {
    private Limits() {}
    public static final int NAME_LENGTH = 200;
    public static final int NOTE_LENGTH = 140;
    public static final int IDEMPOTENCY_KEY_LENGTH = 255;
    public static final int PAYMENTS_PAGE_SIZE = 200;
    public static final int RECONCILIATION_PAGE_SIZE = 100;
    /** Ceiling on a configurable spending cap - $1,000,000. */
    public static final long MAX_LIMIT_CENTS = 100_000_000L;
  }

  /**
   * The two system accounts, at fixed ids so every service and script can
   * refer to them without a lookup.
   *
   * CLEARING holds money in flight: debited from the sender on authorisation,
   * credited to the receiver on settlement.
   *
   * FUNDING makes the ledger complete. Opening a wallet with $1,000 is not
   * money appearing from nowhere - it is DEBIT funding / CREDIT wallet, so
   * every cent has a provenance and all balances together sum to zero.
   */
  public static final class SystemAccounts {
    private SystemAccounts() {}
    public static final String CLEARING_ID = "00000000-0000-4000-8000-000000000001";
    public static final String FUNDING_ID = "00000000-0000-4000-8000-000000000002";
  }
}
