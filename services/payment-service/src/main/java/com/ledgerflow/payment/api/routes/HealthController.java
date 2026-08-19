package com.ledgerflow.payment.api.routes;

import com.ledgerflow.payment.config.Config;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HealthController {

  @GetMapping("/health")
  public Map<String, Object> health() {
    // Ordered, so the response reads the way it always has.
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("status", "ok");
    body.put("service", Config.SERVICE_NAME);
    return body;
  }
}
