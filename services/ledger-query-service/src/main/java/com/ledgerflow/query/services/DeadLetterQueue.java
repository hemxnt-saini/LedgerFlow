package com.ledgerflow.query.services;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ledgerflow.query.config.Config;
import com.ledgerflow.query.lib.Iso;
import com.ledgerflow.query.lib.Log;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

/**
 * The dead letter queue.
 *
 * Logging a bad message and moving on is data loss, and in a system that moves
 * money that is not acceptable - an event we could not understand is still
 * evidence that something happened. So an unprocessable message is republished
 * to a parking topic, where it can be looked at, fixed and replayed instead of
 * silently disappearing.
 *
 * Only *poison* messages come here: ones that will never succeed no matter how
 * many times they are tried (unparseable JSON, a missing event id, a type this
 * version does not know). A projection failure is different - that usually means
 * Redis is unwell, and dead-lettering thousands of perfectly good events during
 * an outage would turn a blip into a data-repair job. Those are retried and then
 * left to block, because blocking is recoverable.
 */
@Service
public class DeadLetterQueue {

  private static final String DLQ_KEY = "dlq:entries";
  private static final int MAX_DLQ_ENTRIES = Config.Retention.DLQ_ENTRIES;

  public enum DeadLetterReason {
    /** The message body was not JSON at all. */
    UNPARSEABLE,
    /** Parsed, but missing the fields needed to handle it safely. */
    MALFORMED,
    /** A well-formed event of a type this version cannot project. */
    UNKNOWN_TYPE
  }

  /** @param payload the original bytes, verbatim, so a replay is byte-for-byte the same. */
  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record DeadLetter(
      String dlqId,
      DeadLetterReason reason,
      String detail,
      String sourceTopic,
      int partition,
      String offset,
      String key,
      String payload,
      String failedAt,
      String replayedAt) {

    DeadLetter replayedNow() {
      return new DeadLetter(
          dlqId,
          reason,
          detail,
          sourceTopic,
          partition,
          offset,
          key,
          payload,
          failedAt,
          Iso.format(Instant.now()));
    }
  }

  private final KafkaTemplate<String, String> kafka;
  private final StringRedisTemplate redis;
  private final ObjectMapper mapper;
  private final StreamService streams;
  private final ProjectionCounters counters;

  public DeadLetterQueue(
      KafkaTemplate<String, String> kafka,
      StringRedisTemplate redis,
      ObjectMapper mapper,
      StreamService streams,
      ProjectionCounters counters) {
    this.kafka = kafka;
    this.redis = redis;
    this.mapper = mapper;
    this.streams = streams;
    this.counters = counters;
  }

  /** Park a message that can never be processed as-is. */
  public void deadLetter(
      DeadLetterReason reason,
      String detail,
      String sourceTopic,
      int partition,
      long offset,
      String key,
      String payload) {
    DeadLetter entry =
        new DeadLetter(
            UUID.randomUUID().toString(),
            reason,
            detail,
            sourceTopic,
            partition,
            String.valueOf(offset),
            key,
            payload,
            Iso.format(Instant.now()),
            null);

    // Kafka is the durable record. If this throws, the caller lets the message
    // block rather than dropping it - which is the whole point.
    kafka.send(Config.Kafka.DLQ_TOPIC, entry.dlqId(), write(entry)).join();

    Log.warn(
        "parked a poison message",
        "dlqId",
        entry.dlqId(),
        "reason",
        entry.reason(),
        "detail",
        entry.detail(),
        "sourceTopic",
        entry.sourceTopic(),
        "partition",
        entry.partition(),
        "offset",
        entry.offset());
  }

  /**
   * A browsable copy of the parking topic. Kafka holds the truth; this makes it
   * listable without spinning up a consumer per request - and parked messages
   * appear live in the monitor alongside everything else.
   */
  @KafkaListener(
      id = "dead-letters",
      topics = "${KAFKA_DLQ_TOPIC:payment-events-dlq}",
      groupId = "${KAFKA_DLQ_GROUP_ID:ledger-query-service-dlq}")
  public void watchParkingTopic(ConsumerRecord<String, String> record) {
    if (record.value() == null) return;

    DeadLetter entry;
    try {
      entry = mapper.readValue(record.value(), DeadLetter.class);
    } catch (Exception e) {
      return; // nothing sensible to do with a broken DLQ record
    }

    redis.opsForList().leftPush(DLQ_KEY, record.value());
    redis.opsForList().trim(DLQ_KEY, 0, MAX_DLQ_ENTRIES - 1);

    counters.countDeadLettered();
    streams.broadcast("dead-letter", entry);
  }

  public List<DeadLetter> list(int limit) {
    List<String> raw = redis.opsForList().range(DLQ_KEY, 0, limit - 1);
    if (raw == null) return List.of();
    List<DeadLetter> entries = new ArrayList<>(raw.size());
    for (String value : raw) {
      DeadLetter entry = read(value);
      if (entry != null) entries.add(entry);
    }
    return entries;
  }

  /**
   * Put a parked message back on the main topic.
   *
   * Safe to do more than once: the read model claims each event id before
   * applying it, so replaying something already projected changes nothing.
   * Replaying a message that is still poison simply lands back here.
   */
  public DeadLetter replay(String dlqId) {
    List<String> raw = redis.opsForList().range(DLQ_KEY, 0, MAX_DLQ_ENTRIES - 1);
    if (raw == null) return null;

    for (int index = 0; index < raw.size(); index++) {
      DeadLetter entry = read(raw.get(index));
      if (entry == null || !dlqId.equals(entry.dlqId())) continue;

      kafka.send(Config.Kafka.TOPIC, entry.key(), entry.payload()).join();

      DeadLetter replayed = entry.replayedNow();
      redis.opsForList().set(DLQ_KEY, index, write(replayed));
      Log.info("replayed a parked message", "dlqId", dlqId, "topic", Config.Kafka.TOPIC);
      return replayed;
    }
    return null;
  }

  public record Poisoned(String topic, String payload) {}

  /**
   * Demo only: writes something the consumer cannot possibly handle.
   *
   * Parking a poison message was the one failure in this system with no way to
   * trigger it from the app - it needed a shell and a console producer. The bytes
   * are deliberately not JSON, which is the simplest thing that reaches the
   * UNPARSEABLE path without inventing a fake event.
   */
  public Poisoned poison() {
    String payload = "not json - parked on purpose at " + Iso.format(Instant.now());
    kafka.send(Config.Kafka.TOPIC, null, payload).join();
    Log.warn("DEMO: produced a poison message", "topic", Config.Kafka.TOPIC);
    return new Poisoned(Config.Kafka.TOPIC, payload);
  }

  public boolean discard(String dlqId) {
    List<String> raw = redis.opsForList().range(DLQ_KEY, 0, MAX_DLQ_ENTRIES - 1);
    if (raw == null) return false;

    for (String value : raw) {
      DeadLetter entry = read(value);
      if (entry == null || !dlqId.equals(entry.dlqId())) continue;
      // Removes it from the browsable copy only. The parking topic keeps the
      // record - discarding is a UI action, not an erasure of history.
      redis.opsForList().remove(DLQ_KEY, 1, value);
      return true;
    }
    return false;
  }

  private String write(DeadLetter entry) {
    try {
      return mapper.writeValueAsString(entry);
    } catch (Exception e) {
      throw new IllegalStateException("cannot serialise a dead letter", e);
    }
  }

  private DeadLetter read(String value) {
    try {
      return mapper.readValue(value, DeadLetter.class);
    } catch (Exception e) {
      return null;
    }
  }
}
