package com.ledgerflow.query.api.routes;

import com.ledgerflow.query.api.Validation;
import com.ledgerflow.query.config.Config;
import com.ledgerflow.query.services.DeadLetterQueue;
import com.ledgerflow.query.services.DeadLetterQueue.DeadLetter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Inspecting and replaying parked messages.
 *
 * Replay is safe to repeat: the read model claims each event id before applying
 * it, so putting something back that already worked changes nothing, and putting
 * back something still unprocessable simply parks it again.
 */
@RestController
public class DlqController {

  private final DeadLetterQueue dlq;

  public DlqController(DeadLetterQueue dlq) {
    this.dlq = dlq;
  }

  /**
   * Publish a message the consumer cannot parse, so it can be watched being
   * parked rather than dropped. 404s unless demo endpoints are enabled.
   */
  @PostMapping("/dlq/demo/poison")
  public ResponseEntity<?> poison() {
    if (!Config.Demo.ENABLED) {
      return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "NOT_FOUND"));
    }
    return ResponseEntity.ok(dlq.poison());
  }

  @GetMapping("/dlq")
  public Map<String, Object> list(@RequestParam(required = false) String limit) {
    List<DeadLetter> entries =
        dlq.list(Validation.clampLimit(limit, 50, Config.Limits.FEED_PAGE_SIZE));
    long pending = entries.stream().filter(entry -> entry.replayedAt() == null).count();

    Map<String, Object> body = new LinkedHashMap<>();
    body.put("topic", Config.Kafka.DLQ_TOPIC);
    body.put("pending", pending);
    body.put("entries", entries);
    return body;
  }

  @PostMapping("/dlq/replay-all")
  public Map<String, Object> replayAll() {
    List<String> replayed = new ArrayList<>();
    for (DeadLetter entry : dlq.list(Config.Retention.DLQ_ENTRIES)) {
      if (entry.replayedAt() != null) continue;
      DeadLetter result = dlq.replay(entry.dlqId());
      if (result != null) replayed.add(result.dlqId());
    }
    return Map.of("replayed", replayed.size(), "dlqIds", replayed);
  }

  @PostMapping("/dlq/{dlqId}/replay")
  public ResponseEntity<?> replay(@PathVariable String dlqId) {
    DeadLetter entry = dlq.replay(dlqId);
    if (entry == null) {
      return ResponseEntity.status(HttpStatus.NOT_FOUND)
          .body(Map.of("error", "DLQ_ENTRY_NOT_FOUND"));
    }
    return ResponseEntity.ok(entry);
  }

  /** Removes it from the browsable list. The parking topic keeps the record. */
  @DeleteMapping("/dlq/{dlqId}")
  public ResponseEntity<?> discard(@PathVariable String dlqId) {
    if (!dlq.discard(dlqId)) {
      return ResponseEntity.status(HttpStatus.NOT_FOUND)
          .body(Map.of("error", "DLQ_ENTRY_NOT_FOUND"));
    }
    return ResponseEntity.ok(Map.of("discarded", dlqId));
  }
}
