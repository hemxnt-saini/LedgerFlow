package com.ledgerflow.query.repositories;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ledgerflow.query.config.Config;
import com.ledgerflow.query.domain.Projector;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.data.redis.connection.StringRedisConnection;
import org.springframework.data.redis.core.RedisCallback;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Repository;

/**
 * Every read of the projected state. Nothing outside this class knows what the
 * Redis keys look like, so the storage layout can change without touching a
 * controller or a service.
 */
@Repository
public class ReadModelRepository {

  public static final String PIPELINE_KEY = "pipeline:traces";

  public record ProjectedAccount(String id, String name, long balanceCents) {}

  public record ProjectedPayment(
      String paymentId,
      String fromAccountId,
      String toAccountId,
      long amountCents,
      String note,
      String status,
      String failureReason,
      int attempts,
      String createdAt,
      String updatedAt) {}

  public record Counters(
      long sentCents, long receivedCents, long sentCount, long receivedCount) {}

  private final StringRedisTemplate redis;
  private final ObjectMapper mapper;

  public ReadModelRepository(StringRedisTemplate redis, ObjectMapper mapper) {
    this.redis = redis;
    this.mapper = mapper;
  }

  public ProjectedAccount findAccount(String id) {
    Map<Object, Object> hash = redis.opsForHash().entries(Projector.accountKey(id));
    if (hash.isEmpty()) return null;
    return new ProjectedAccount(id, text(hash, "name"), number(hash, "balanceCents"));
  }

  /** One round trip for a whole dashboard rather than N. */
  public Map<String, Long> findBalances(List<String> ids) {
    Map<String, Long> balances = new LinkedHashMap<>();
    if (ids.isEmpty()) return balances;

    List<Object> results = pipelinedHashes(ids, Projector::accountKey);
    for (int index = 0; index < ids.size(); index++) {
      Map<?, ?> hash = asHash(results, index);
      if (hash != null && hash.get("balanceCents") != null) {
        balances.put(ids.get(index), number(hash, "balanceCents"));
      }
    }
    return balances;
  }

  /**
   * A payment is one row whose status changes, not one row per lifecycle event -
   * so this reads an index of ids and then the current state of each.
   */
  public List<ProjectedPayment> findPaymentsForAccount(String accountId, int limit) {
    Set<String> ranked =
        redis.opsForZSet().reverseRange(Projector.paymentIndexKey(accountId), 0, limit - 1);
    List<String> ids = new ArrayList<>(ranked == null ? Set.of() : new LinkedHashSet<>(ranked));
    if (ids.isEmpty()) return List.of();

    List<Object> results = pipelinedHashes(ids, Projector::paymentKey);
    List<ProjectedPayment> payments = new ArrayList<>(ids.size());
    for (int index = 0; index < ids.size(); index++) {
      Map<?, ?> hash = asHash(results, index);
      if (hash == null || hash.isEmpty()) continue;
      payments.add(
          new ProjectedPayment(
              text(hash, "paymentId"),
              text(hash, "fromAccountId"),
              text(hash, "toAccountId"),
              number(hash, "amountCents"),
              emptyToNull(text(hash, "note")),
              text(hash, "status"),
              emptyToNull(text(hash, "failureReason")),
              (int) number(hash, "attempts"),
              text(hash, "createdAt"),
              text(hash, "updatedAt")));
    }
    return payments;
  }

  public Counters findLifetimeCounters(String accountId) {
    return readCounters(Projector.statsKey(accountId));
  }

  public Counters findDayCounters(String accountId, String day) {
    return readCounters(Projector.dayStatsKey(accountId, day));
  }

  private Counters readCounters(String key) {
    Map<Object, Object> hash = redis.opsForHash().entries(key);
    return new Counters(
        number(hash, "sentCents"),
        number(hash, "receivedCents"),
        number(hash, "sentCount"),
        number(hash, "receivedCount"));
  }

  public List<JsonNode> findActivity(int limit) {
    return parseAll(redis.opsForList().range(Projector.ACTIVITY_KEY, 0, limit - 1));
  }

  public List<JsonNode> findPipelineTraces(int limit) {
    return parseAll(redis.opsForList().range(PIPELINE_KEY, 0, limit - 1));
  }

  public void appendPipelineTrace(Object trace) {
    try {
      redis.opsForList().leftPush(PIPELINE_KEY, mapper.writeValueAsString(trace));
    } catch (Exception e) {
      throw new IllegalStateException("cannot serialise pipeline trace", e);
    }
    redis.opsForList().trim(PIPELINE_KEY, 0, Config.Retention.PIPELINE_TRACES - 1);
  }

  /**
   * Deletes everything the projection owns, so it can be rebuilt from the log.
   *
   * Only the projected keys: the idempotency cache belongs to the payment
   * service and parked messages are their own record. The dedup claims go with
   * it, which is what lets every event apply again.
   *
   * ponytail: KEYS is fine at demo scale; SCAN if the keyspace ever grows.
   */
  public long clearProjection() {
    List<String> keys = new ArrayList<>();
    keys.add(Projector.ACTIVITY_KEY);
    keys.add(PIPELINE_KEY);
    keys.add(Projector.APPLIED_EVENTS_KEY);
    for (String pattern : List.of("account:*", "payment:*", "stats:*")) {
      Set<String> matches = redis.keys(pattern);
      if (matches != null) keys.addAll(matches);
    }
    if (!keys.isEmpty()) redis.delete(keys);
    return keys.size();
  }

  // --- plumbing -------------------------------------------------------------

  private List<Object> pipelinedHashes(
      List<String> ids, java.util.function.Function<String, String> keyOf) {
    return redis.executePipelined(
        (RedisCallback<Object>)
            connection -> {
              StringRedisConnection strings = (StringRedisConnection) connection;
              for (String id : ids) strings.hGetAll(keyOf.apply(id));
              return null;
            });
  }

  private static Map<?, ?> asHash(List<Object> results, int index) {
    Object value = index < results.size() ? results.get(index) : null;
    return value instanceof Map<?, ?> hash ? hash : null;
  }

  private static String text(Map<?, ?> hash, String field) {
    Object value = hash.get(field);
    return value == null ? null : String.valueOf(value);
  }

  private static long number(Map<?, ?> hash, String field) {
    Object value = hash.get(field);
    if (value == null) return 0;
    try {
      return Long.parseLong(String.valueOf(value));
    } catch (NumberFormatException e) {
      return 0;
    }
  }

  private static String emptyToNull(String value) {
    return value == null || value.isEmpty() ? null : value;
  }

  private List<JsonNode> parseAll(List<String> raw) {
    if (raw == null) return List.of();
    List<JsonNode> entries = new ArrayList<>(raw.size());
    for (String entry : raw) {
      try {
        entries.add(mapper.readTree(entry));
      } catch (Exception e) {
        // A single unreadable entry is not worth failing a feed for.
      }
    }
    return entries;
  }
}
