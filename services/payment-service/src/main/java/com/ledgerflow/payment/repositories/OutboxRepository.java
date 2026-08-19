package com.ledgerflow.payment.repositories;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ledgerflow.payment.lib.Log;
import java.sql.PreparedStatement;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

@Repository
public class OutboxRepository {

  /**
   * @param payload the event as Postgres stored it, both parsed and verbatim -
   *     the publisher needs a couple of fields for the message key and the
   *     original text for the value.
   */
  public record OutboxRow(long id, String eventType, Map<String, Object> payload, String raw) {}

  private static final TypeReference<Map<String, Object>> JSON_OBJECT = new TypeReference<>() {};

  private final JdbcTemplate jdbc;
  private final ObjectMapper mapper;
  private final RowMapper<OutboxRow> outboxRow;

  public OutboxRepository(JdbcTemplate jdbc, ObjectMapper mapper) {
    this.jdbc = jdbc;
    this.mapper = mapper;
    this.outboxRow = outboxRowMapper();
  }

  private RowMapper<OutboxRow> outboxRowMapper() {
    return
      (rs, rowNum) -> {
        String raw = rs.getString("payload");
        Map<String, Object> payload;
        try {
          payload = mapper.readValue(raw, JSON_OBJECT);
        } catch (Exception e) {
          // Unreachable in practice: this column is jsonb, so Postgres would
          // have refused anything unparseable on the way in.
          Log.error("unreadable outbox payload", "id", rs.getLong("id"), "err", e);
          payload = Map.of();
        }
        return new OutboxRow(rs.getLong("id"), rs.getString("event_type"), payload, raw);
      };
  }

  /**
   * Transactional outbox write: the event goes into the same DB transaction as
   * the business data, so we can never publish an event for a rolled-back
   * payment, nor commit a payment whose event was lost. That is the dual-write
   * problem, and one commit is the only real answer to it.
   */
  public void enqueue(String eventType, Map<String, Object> payload) {
    Map<String, Object> event = new LinkedHashMap<>();
    // Publishing is at-least-once (a crash between the Kafka send and the
    // COMMIT re-sends the row), so every event carries a stable id and
    // consumers apply it once. Generated here, not at publish time, so a
    // re-publish carries the *same* id.
    event.put("eventId", UUID.randomUUID().toString());
    event.put("type", eventType);
    // Rides along in the payload so it survives the trip through Kafka and
    // the read side can log under the same id.
    String correlationId = Log.currentCorrelationId();
    if (correlationId != null) event.put("correlationId", correlationId);
    event.putAll(payload);

    String json;
    try {
      json = mapper.writeValueAsString(event);
    } catch (Exception e) {
      throw new IllegalStateException("cannot serialise " + eventType, e);
    }
    jdbc.update(
        "INSERT INTO outbox (event_type, payload) VALUES (?, CAST(? AS jsonb))", eventType, json);
  }

  /**
   * Claims unpublished rows for this poller pass.
   *
   * SKIP LOCKED means several instances could poll concurrently without
   * publishing the same row twice.
   */
  public List<OutboxRow> claimUnpublished(int limit) {
    return jdbc.query(
        "SELECT id, event_type, payload"
            + "   FROM outbox"
            + "  WHERE published_at IS NULL"
            + "  ORDER BY id"
            + "    FOR UPDATE SKIP LOCKED"
            + "  LIMIT ?",
        outboxRow,
        limit);
  }

  public void markPublished(List<Long> ids) {
    jdbc.update(
        connection -> {
          PreparedStatement statement =
              connection.prepareStatement(
                  "UPDATE outbox SET published_at = now() WHERE id = ANY(CAST(? AS bigint[]))");
          statement.setArray(1, connection.createArrayOf("bigint", ids.toArray()));
          return statement;
        });
  }
}
