package com.ledgerflow.query.services;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ledgerflow.query.config.Config;
import com.ledgerflow.query.domain.PaymentEvent;
import com.ledgerflow.query.domain.ProjectionStore;
import com.ledgerflow.query.domain.Projector;
import com.ledgerflow.query.lib.Iso;
import com.ledgerflow.query.lib.Log;
import com.ledgerflow.query.repositories.ReadModelRepository;
import com.ledgerflow.query.services.DeadLetterQueue.DeadLetterReason;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.common.header.Header;
import org.springframework.context.event.EventListener;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.event.ConsumerStoppedEvent;
import org.springframework.kafka.listener.AbstractConsumerSeekAware;
import org.springframework.stereotype.Service;

/**
 * Consumes the topic and applies each event to the read model, exactly once.
 *
 * Extends {@link AbstractConsumerSeekAware} so the Kafka page can rewind every
 * partition to the beginning of the log and rebuild the projection from it.
 */
@Service
public class ProjectionService extends AbstractConsumerSeekAware {

  private final ProjectionStore store;
  private final ReadModelRepository readModel;
  private final DeadLetterQueue dlq;
  private final StreamService streams;
  private final ProjectionCounters counters;
  private final ObjectMapper mapper;

  public ProjectionService(
      ProjectionStore store,
      ReadModelRepository readModel,
      DeadLetterQueue dlq,
      StreamService streams,
      ProjectionCounters counters,
      ObjectMapper mapper) {
    this.store = store;
    this.readModel = readModel;
    this.dlq = dlq;
    this.streams = streams;
    this.counters = counters;
    this.mapper = mapper;
  }

  @KafkaListener(
      id = "projection",
      topics = "${KAFKA_TOPIC:payment-events}",
      groupId = "${KAFKA_GROUP_ID:ledger-query-service}")
  public void onMessage(ConsumerRecord<String, String> record) {
    if (record.value() == null) return;

    // The id travelled with the event, so this side's log lines line up with
    // the ones the write side produced for the same payment.
    Log.withContext(
        Map.of("correlationId", correlationIdOf(record)),
        () -> {
          project(record);
          return null;
        });
  }

  private void project(ConsumerRecord<String, String> record) {
    long receivedAt = System.currentTimeMillis();
    String raw = record.value();

    PaymentEvent event;
    try {
      event = mapper.readValue(raw, PaymentEvent.class);
    } catch (Exception e) {
      // Park it rather than drop it. Something produced this, and that is a
      // fact worth keeping even when we cannot read it.
      park(record, DeadLetterReason.UNPARSEABLE, String.valueOf(e.getMessage()));
      return;
    }

    // Trust boundary. An event without an id cannot be de-duplicated, and one
    // without a usable timestamp would poison the feed's sort score and the day
    // buckets. Neither is safe to apply to a balance.
    if (event == null
        || event.eventId() == null
        || event.type() == null
        || Projector.parseTimestamp(event.occurredAt()) == null) {
      park(record, DeadLetterReason.MALFORMED, "needs eventId, type and a parseable occurredAt");
      return;
    }

    // Checked before applyEvent so the id is not claimed. Otherwise adding
    // support for the type later and replaying it would be a permanent no-op.
    if (!Projector.isKnownEventType(event.type())) {
      park(record, DeadLetterReason.UNKNOWN_TYPE, "no projection for " + event.type());
      return;
    }

    // Throwing here makes the container retry the message rather than commit
    // the offset, so a Redis blip does not silently lose an event.
    if (!Projector.applyEvent(store, event)) {
      counters.countDuplicate();
      Log.debug("skipped duplicate", "type", event.type(), "eventId", event.eventId());
      return;
    }
    counters.countApplied();

    // The read model is already updated and the offset is about to commit.
    // Telemetry and fan-out are best-effort from here: a failure in either must
    // not throw, because an error out of the handler blocks the consumer.
    try {
      long publishedAt = publishedAtOf(record, receivedAt);
      Map<String, Object> trace =
          traceOf(event, publishedAt, receivedAt, System.currentTimeMillis(), record);
      readModel.appendPipelineTrace(trace);

      Log.info(
          "projected event",
          "type",
          event.type(),
          "paymentId",
          event.paymentId(),
          "totalMs",
          ((Map<?, ?>) trace.get("stages")).get("totalMs"));

      // The whole point of the read side: the moment state changes, every open
      // tab hears about it without polling.
      Map<String, Object> frame = new LinkedHashMap<>();
      frame.put("event", event);
      frame.put("trace", trace);
      streams.broadcast("payment-event", frame);
    } catch (Exception e) {
      Log.error("event applied, telemetry failed", "err", e);
    }
  }

  /**
   * Real timings for every event, not invented lifecycle steps: when the write
   * side committed, when the outbox actually published, when this consumer got
   * it, and when the read model reflected it. The gaps between those four
   * numbers are exactly the eventual-consistency window the UI warns about.
   */
  private Map<String, Object> traceOf(
      PaymentEvent event,
      long publishedAt,
      long receivedAt,
      long projectedAt,
      ConsumerRecord<String, String> record) {
    Long committed = Projector.parseTimestamp(event.occurredAt());
    long committedAt = committed == null ? receivedAt : committed;

    Map<String, Object> stages = new LinkedHashMap<>();
    stages.put("outboxMs", Math.max(publishedAt - committedAt, 0));
    stages.put("transportMs", Math.max(receivedAt - publishedAt, 0));
    stages.put("projectionMs", Math.max(projectedAt - receivedAt, 0));
    stages.put("totalMs", Math.max(projectedAt - committedAt, 0));

    Map<String, Object> trace = new LinkedHashMap<>();
    trace.put("eventId", event.eventId());
    trace.put("type", event.type());
    trace.put("paymentId", event.paymentId());
    // Where it actually lived in the log.
    trace.put("partition", record.partition());
    trace.put("offset", String.valueOf(record.offset()));
    trace.put("committedAt", Iso.format(Instant.ofEpochMilli(committedAt)));
    trace.put("publishedAt", Iso.format(Instant.ofEpochMilli(publishedAt)));
    trace.put("receivedAt", Iso.format(Instant.ofEpochMilli(receivedAt)));
    trace.put("projectedAt", Iso.format(Instant.ofEpochMilli(projectedAt)));
    trace.put("stages", stages);
    return trace;
  }

  private void park(
      ConsumerRecord<String, String> record, DeadLetterReason reason, String detail) {
    dlq.deadLetter(
        reason,
        detail,
        record.topic(),
        record.partition(),
        record.offset(),
        record.key(),
        record.value());
  }

  private static String correlationIdOf(ConsumerRecord<String, String> record) {
    return Log.correlationIdFrom(header(record, "correlationId"));
  }

  private static long publishedAtOf(ConsumerRecord<String, String> record, long fallback) {
    String value = header(record, "publishedAt");
    if (value == null) return fallback;
    try {
      return Long.parseLong(value.trim());
    } catch (NumberFormatException e) {
      return fallback;
    }
  }

  private static String header(ConsumerRecord<String, String> record, String name) {
    Header header = record.headers().lastHeader(name);
    return header == null || header.value() == null
        ? null
        : new String(header.value(), StandardCharsets.UTF_8);
  }

  /**
   * A stopped consumer is the worst failure this service has: the HTTP side
   * keeps answering 200 while the read model silently freezes. Exiting makes it
   * visible and lets the restart policy recover it.
   */
  @EventListener
  public void onConsumerStopped(ConsumerStoppedEvent event) {
    if (event.getReason() == ConsumerStoppedEvent.Reason.NORMAL) return;
    Log.error("consumer stopped, exiting to restart", "reason", event.getReason());
    System.exit(1);
  }

  /** Rewind every partition to the start of the log, for a rebuild. */
  public void rewind() {
    seekToBeginning();
    Log.warn(
        "rewound to the beginning of the log",
        "topic",
        Config.Kafka.TOPIC,
        "partitions",
        Config.Kafka.PARTITIONS);
  }
}
