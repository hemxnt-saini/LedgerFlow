package com.ledgerflow.query.services;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import com.ledgerflow.query.lib.Log;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * The live push channel: every open browser tab, held on a Server-Sent Events
 * stream.
 *
 * SSE rather than WebSockets because all the traffic is server to client,
 * EventSource reconnects on its own, and it needs no library on either end.
 */
@Service
public class StreamService {

  /** No timeout: a wallet left open all afternoon must not be disconnected. */
  private static final long NEVER = 0L;

  private final Set<SseEmitter> subscribers = new CopyOnWriteArraySet<>();
  private final ObjectMapper mapper;

  public StreamService(ObjectMapper mapper) {
    this.mapper = mapper;
  }

  public int subscriberCount() {
    return subscribers.size();
  }

  public SseEmitter subscribe() {
    SseEmitter emitter = new SseEmitter(NEVER);
    emitter.onCompletion(() -> subscribers.remove(emitter));
    emitter.onTimeout(() -> subscribers.remove(emitter));
    emitter.onError(error -> subscribers.remove(emitter));
    subscribers.add(emitter);

    try {
      emitter.send(SseEmitter.event().name("hello").data(Map.of("connected", true)));
    } catch (Exception e) {
      subscribers.remove(emitter);
    }
    return emitter;
  }

  public void broadcast(String name, Object data) {
    String json;
    try {
      json = mapper.writeValueAsString(data);
    } catch (Exception e) {
      Log.error("cannot serialise a stream frame", "event", name, "err", e);
      return;
    }
    for (SseEmitter subscriber : subscribers) {
      try {
        // The payload is already JSON, so it goes out as one text frame rather
        // than being serialised a second time by the emitter.
        subscriber.send(SseEmitter.event().name(name).data(json));
      } catch (Exception e) {
        // A tab that has gone away is not an error worth logging on every event.
        subscribers.remove(subscriber);
        subscriber.complete();
      }
    }
  }

  /** A comment line is the cheapest way to keep an idle stream warm. */
  @Scheduled(fixedDelayString = "${STREAM_KEEP_ALIVE_MS:20000}")
  public void keepAlive() {
    for (SseEmitter subscriber : subscribers) {
      try {
        subscriber.send(SseEmitter.event().comment("keep-alive"));
      } catch (Exception e) {
        subscribers.remove(subscriber);
        subscriber.complete();
      }
    }
  }

  @PreDestroy
  public void closeAll() {
    for (SseEmitter subscriber : subscribers) subscriber.complete();
    subscribers.clear();
  }
}
