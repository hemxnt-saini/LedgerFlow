package com.ledgerflow.query.api.routes;

import com.ledgerflow.query.services.StreamService;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@RestController
public class StreamController {

  private final StreamService streams;

  public StreamController(StreamService streams) {
    this.streams = streams;
  }

  @GetMapping("/events/stream")
  public SseEmitter stream(HttpServletResponse response) {
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    // nginx would otherwise buffer the stream and deliver nothing until it
    // decides the response is finished.
    response.setHeader("X-Accel-Buffering", "no");
    return streams.subscribe();
  }
}
