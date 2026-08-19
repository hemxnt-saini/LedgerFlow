package com.ledgerflow.query.api.routes;

import com.ledgerflow.query.config.Config;
import com.ledgerflow.query.services.ConsumerControls;
import com.ledgerflow.query.services.ProjectionCounters;
import com.ledgerflow.query.services.StreamService;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HealthController {

  private final StreamService streams;
  private final ConsumerControls controls;
  private final ProjectionCounters counters;

  public HealthController(
      StreamService streams, ConsumerControls controls, ProjectionCounters counters) {
    this.streams = streams;
    this.controls = controls;
    this.counters = counters;
  }

  @GetMapping("/health")
  public Map<String, Object> health() {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("status", "ok");
    body.put("service", Config.SERVICE_NAME);
    body.put("subscribers", streams.subscriberCount());
    body.put("consumerPaused", controls.isPaused());
    // A 200 here only proves the web server is alive. These prove the consumer
    // is actually consuming.
    body.put("counters", counters.snapshot());
    return body;
  }
}
