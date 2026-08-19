package com.ledgerflow.query.domain;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Pure read-model projection: payment event -> store state.
 *
 * Nothing here imports Spring, Redis or Kafka. The store is passed in as
 * {@link ProjectionStore}, so production passes the real client and tests pass
 * an in-memory fake.
 */
public final class Projector {

  private Projector() {}

  private static final int MAX_PAYMENTS_PER_ACCOUNT = 100;
  private static final int MAX_ACTIVITY = 200;
  private static final long DAY_BUCKET_TTL_SECONDS = 40L * 24 * 60 * 60;

  public static final String ACTIVITY_KEY = "activity";
  public static final String APPLIED_EVENTS_KEY = "projection:applied";

  public static String accountKey(String id) {
    return "account:" + id;
  }

  public static String paymentKey(String id) {
    return "payment:" + id;
  }

  public static String paymentIndexKey(String accountId) {
    return "account:" + accountId + ":payments";
  }

  public static String statsKey(String accountId) {
    return "stats:" + accountId;
  }

  public static String dayStatsKey(String accountId, String day) {
    return "stats:" + accountId + ":d:" + day;
  }

  public static final String ACCOUNT_CREATED = "account.created";

  /**
   * Read-model status implied by each event. One row per payment, mutated in
   * place.
   */
  private static final Map<String, String> STATUS_BY_EVENT =
      Map.of(
          "payment.initiated", "PROCESSING",
          "payment.held", "HELD_FOR_REVIEW",
          // Released by a reviewer and back on the ordinary path - the settle leg
          // will take it from here.
          "payment.approved", "PROCESSING",
          // Still in flight: a retry is not a new state, it is the same state with
          // another attempt spent.
          "payment.settlement_retrying", "PROCESSING",
          "payment.completed", "COMPLETED",
          "payment.failed", "FAILED",
          "payment.stuck", "AWAITING_REFUND",
          "payment.refunded", "REFUNDED");

  /** Activity entries are JSON; this is the standard library of the JVM, not a framework. */
  private static final ObjectMapper JSON = new ObjectMapper();

  /** ISO timestamps sort and slice; no date maths needed for a UTC day bucket. */
  public static String dayOf(String occurredAt) {
    return occurredAt.length() < 10 ? occurredAt : occurredAt.substring(0, 10);
  }

  /**
   * Epoch milliseconds for an event's timestamp, or null if it cannot be read.
   *
   * The same function screens an event at the trust boundary and scores it in
   * the feed, so a timestamp that would poison the sort can never be applied.
   */
  public static Long parseTimestamp(String occurredAt) {
    if (occurredAt == null) return null;
    try {
      return Instant.parse(occurredAt).toEpochMilli();
    } catch (Exception first) {
      try {
        return OffsetDateTime.parse(occurredAt).toInstant().toEpochMilli();
      } catch (Exception second) {
        return null;
      }
    }
  }

  /**
   * Whether this version knows how to project a type. Checked *before* the
   * event id is claimed: claiming first would mean that after adding support
   * and replaying the event, the dedup set would skip it forever.
   */
  public static boolean isKnownEventType(String type) {
    return ACCOUNT_CREATED.equals(type) || STATUS_BY_EVENT.containsKey(type);
  }

  /**
   * Applies one event to the read model, exactly once.
   *
   * Delivery is at-least-once from both ends: the outbox publisher can re-send
   * a row after crashing between the Kafka send and its COMMIT, and Kafka can
   * redeliver on a consumer rebalance. An increment applied twice would invent
   * money out of nothing, so the event id is claimed first and a second sighting
   * is a no-op. Wiping the store clears the claims too, which is what makes
   * "delete the read model and replay the topic" rebuild it correctly.
   *
   * @return true if the event was applied, false if it was a duplicate.
   */
  public static boolean applyEvent(ProjectionStore store, PaymentEvent event) {
    // ponytail: the claim set grows without bound. Fine for a demo topic; swap
    // for per-event keys with a TTL longer than the retention if it ever matters.
    if (store.sadd(APPLIED_EVENTS_KEY, event.eventId()) == 0) return false;

    project(store, event);
    return true;
  }

  private static void project(ProjectionStore store, PaymentEvent event) {
    if (ACCOUNT_CREATED.equals(event.type())) {
      // Identity is set absolutely - it never changes, so writing it twice is
      // harmless. The opening balance is applied as a *delta*, not a set.
      //
      // That distinction is what makes more than one partition safe. Events for
      // one account and events for one payment hash to different partitions, so
      // there is no ordering guarantee between them; an absolute write arriving
      // after an increment would wipe it out. Every balance mutation in this
      // class is therefore commutative, and the dedup set stops any of them
      // being applied twice.
      Map<String, String> identity = new LinkedHashMap<>();
      identity.put("id", event.accountId());
      identity.put("name", event.name());
      store.hset(accountKey(event.accountId()), identity);
      store.hincrby(accountKey(event.accountId()), "balanceCents", event.balanceOrZero());
      return;
    }

    // Callers screen unknown types out before the id is claimed, so by here the
    // status is always defined.
    String status = STATUS_BY_EVENT.get(event.type());

    // Balances mirror the ledger legs exactly, one delta per event, so the read
    // model is correct at every step of the saga - not only at the end.
    //
    //   initiated  sender -= amount   (money is now in clearing)
    //   held       sender -= amount   (authorised too, just not released yet)
    //   completed  receiver += amount (clearing paid it out)
    //   refunded   sender += amount   (clearing gave it back)
    //   approved/failed/stuck  no balance change
    switch (event.type()) {
      case "payment.initiated", "payment.held" ->
          store.hincrby(accountKey(event.fromAccountId()), "balanceCents", -event.amountOrZero());
      case "payment.completed" -> {
        store.hincrby(accountKey(event.toAccountId()), "balanceCents", event.amountOrZero());
        countCompleted(store, event);
      }
      case "payment.refunded" ->
          store.hincrby(accountKey(event.fromAccountId()), "balanceCents", event.amountOrZero());
      default -> {
        // approved, failed and stuck move no money.
      }
    }

    upsertPayment(store, event, status);
    recordActivity(store, event);
  }

  /**
   * One hash per payment plus a per-account index, rather than an append-only
   * list: a payment is a single thing whose status changes, and a wallet shows
   * it as one row, not one row per lifecycle event.
   */
  private static void upsertPayment(ProjectionStore store, PaymentEvent event, String status) {
    Map<String, String> fields = new LinkedHashMap<>();
    fields.put("paymentId", event.paymentId());
    fields.put("fromAccountId", event.fromAccountId());
    fields.put("toAccountId", event.toAccountId());
    fields.put("amountCents", String.valueOf(event.amountOrZero()));
    fields.put("note", event.note() == null ? "" : event.note());
    fields.put("status", status);
    fields.put("failureReason", event.failureReason() == null ? "" : event.failureReason());
    fields.put("attempts", String.valueOf(event.attempts() == null ? 0 : event.attempts()));
    fields.put("updatedAt", event.occurredAt());
    store.hset(paymentKey(event.paymentId()), fields);

    // Score by the initiating event so a payment keeps its place in the feed as
    // it moves through the saga instead of jumping to the top on every update.
    if ("payment.initiated".equals(event.type())
        || "payment.held".equals(event.type())
        || "payment.failed".equals(event.type())) {
      store.hset(paymentKey(event.paymentId()), Map.of("createdAt", event.occurredAt()));
    }
    Long parsed = parseTimestamp(event.occurredAt());
    double score = parsed == null ? 0 : parsed;

    for (String accountId : List.of(event.fromAccountId(), event.toAccountId())) {
      store.zadd(paymentIndexKey(accountId), score, event.paymentId());
      store.zremrangebyrank(paymentIndexKey(accountId), 0, -(MAX_PAYMENTS_PER_ACCOUNT + 1));
    }
  }

  /** Money only counts as sent or received once it has actually arrived. */
  private static void countCompleted(ProjectionStore store, PaymentEvent event) {
    String day = dayOf(event.occurredAt());
    long amount = event.amountOrZero();
    List<String[]> buckets =
        List.of(
            new String[] {statsKey(event.fromAccountId()), "sent"},
            new String[] {dayStatsKey(event.fromAccountId(), day), "sent"},
            new String[] {statsKey(event.toAccountId()), "received"},
            new String[] {dayStatsKey(event.toAccountId(), day), "received"});

    for (String[] bucket : buckets) {
      String key = bucket[0];
      String field = bucket[1];
      store.hincrby(key, field + "Cents", amount);
      store.hincrby(key, field + "Count", 1);
      if (key.contains(":d:")) store.expire(key, DAY_BUCKET_TTL_SECONDS);
    }
  }

  /** The global "John paid Alice" ticker. Append-only: this one really is a log. */
  private static void recordActivity(ProjectionStore store, PaymentEvent event) {
    Map<String, Object> entry = new LinkedHashMap<>();
    entry.put("eventId", event.eventId());
    entry.put("type", event.type());
    entry.put("paymentId", event.paymentId());
    entry.put("fromAccountId", event.fromAccountId());
    entry.put("toAccountId", event.toAccountId());
    entry.put("amountCents", event.amountOrZero());
    entry.put("note", event.note() == null ? "" : event.note());
    entry.put("failureReason", event.failureReason());
    entry.put("occurredAt", event.occurredAt());

    try {
      store.lpush(ACTIVITY_KEY, JSON.writeValueAsString(entry));
    } catch (Exception e) {
      throw new IllegalStateException("cannot serialise activity entry", e);
    }
    store.ltrim(ACTIVITY_KEY, 0, MAX_ACTIVITY - 1);
  }
}
