package com.ledgerflow.query.api.routes;

import com.ledgerflow.query.config.Config;
import com.ledgerflow.query.repositories.ReadModelRepository;
import com.ledgerflow.query.services.ConsumerControls;
import com.ledgerflow.query.services.KafkaAdminService;
import com.ledgerflow.query.services.KafkaAdminService.Overview;
import com.ledgerflow.query.services.StreamService;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The Kafka control room's backend. Everything reported here comes from the
 * broker's own admin protocol - partitions, log watermarks, committed offsets -
 * rather than being a number this service invents.
 */
@RestController
public class KafkaController {

  private final KafkaAdminService admin;
  private final ConsumerControls controls;
  private final StreamService streams;
  private final ReadModelRepository readModel;

  public KafkaController(
      KafkaAdminService admin,
      ConsumerControls controls,
      StreamService streams,
      ReadModelRepository readModel) {
    this.admin = admin;
    this.controls = controls;
    this.streams = streams;
    this.readModel = readModel;
  }

  @GetMapping("/kafka/overview")
  public Map<String, Object> overview() {
    Overview overview =
        admin.overview(
            List.of(Config.Kafka.TOPIC, Config.Kafka.DLQ_TOPIC),
            List.of(Config.Kafka.GROUP_ID, Config.Kafka.DLQ_GROUP_ID));

    Map<String, Object> body = new LinkedHashMap<>();
    body.put("topics", overview.topics());
    body.put("groups", overview.groups());
    body.put("mainTopic", Config.Kafka.TOPIC);
    body.put("dlqTopic", Config.Kafka.DLQ_TOPIC);
    body.put("consumerPaused", controls.isPaused());
    body.put("subscribers", streams.subscriberCount());
    return body;
  }

  /**
   * Pause consumption. The producer keeps writing, the log keeps growing, lag
   * climbs - and nothing is lost. Resume and it drains.
   */
  @PostMapping("/kafka/consumer/pause")
  public Map<String, Object> pause() {
    controls.pause();
    return Map.of("paused", true);
  }

  @PostMapping("/kafka/consumer/resume")
  public Map<String, Object> resume() {
    controls.resume();
    return Map.of("paused", false);
  }

  /**
   * Throw the read model away and rebuild it from the log. It comes back
   * identical, because the log is the source of truth and Redis is a cache of
   * it.
   */
  @PostMapping("/kafka/consumer/rebuild")
  public Map<String, Object> rebuild() {
    long cleared = readModel.clearProjection();
    controls.rewind();
    return Map.of("cleared", cleared, "rewoundPartitions", Config.Kafka.PARTITIONS);
  }
}
