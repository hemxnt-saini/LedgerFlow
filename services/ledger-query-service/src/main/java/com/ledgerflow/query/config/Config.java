package com.ledgerflow.query.config;

/**
 * Every environment variable this service reads, in one place.
 *
 * Nothing else in the codebase touches the environment, so the full set of
 * knobs is discoverable here rather than scattered across a dozen classes.
 */
public final class Config {

  private Config() {}

  static String text(String name, String fallback) {
    String value = System.getenv(name);
    return value == null || value.isEmpty() ? fallback : value;
  }

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

  public static final String SERVICE_NAME = text("SERVICE_NAME", "ledger-query-service");
  public static final int PORT = num("PORT", 4001);
  public static final String LOG_LEVEL = text("LOG_LEVEL", "info");

  public static final String REDIS_URL = text("REDIS_URL", "redis://localhost:6379");

  public static final class Kafka {
    private Kafka() {}
    public static final String CLIENT_ID = "ledger-query-service";
    public static final String BROKERS = text("KAFKA_BROKERS", "localhost:9094");
    public static final String TOPIC = text("KAFKA_TOPIC", "payment-events");
    public static final String DLQ_TOPIC = text("KAFKA_DLQ_TOPIC", "payment-events-dlq");
    /**
     * Order is guaranteed per key, not across the topic. Safe here because
     * every balance mutation in the projection is a commutative delta.
     */
    public static final int PARTITIONS = num("KAFKA_PARTITIONS", 3);
    public static final String GROUP_ID = text("KAFKA_GROUP_ID", "ledger-query-service");
    public static final String DLQ_GROUP_ID =
        text("KAFKA_DLQ_GROUP_ID", "ledger-query-service-dlq");
  }

  /** How much history the browsable copies of each feed keep. */
  public static final class Retention {
    private Retention() {}
    public static final int PIPELINE_TRACES = 200;
    public static final int DLQ_ENTRIES = 200;
  }

  public static final class Limits {
    private Limits() {}
    public static final int TRANSACTIONS_PAGE_SIZE = 100;
    public static final int FEED_PAGE_SIZE = 200;
    public static final int BULK_BALANCE_IDS = 100;
  }

  /** Proxies and browsers drop an idle SSE stream without a heartbeat. */
  public static final int STREAM_KEEP_ALIVE_MS = 20_000;

  /**
   * Endpoints that break things on purpose, so the failure handling can be
   * seen working rather than taken on trust. Same reasoning as the payment
   * service's: on by default because this is a demonstration, behind a switch
   * because deliberately corrupting a topic belongs nowhere else.
   */
  public static final class Demo {
    private Demo() {}
    public static final boolean ENABLED = !"false".equals(text("DEMO_ENDPOINTS", "true"));
  }
}
