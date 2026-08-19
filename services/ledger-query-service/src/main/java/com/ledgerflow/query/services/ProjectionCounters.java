package com.ledgerflow.query.services;

import java.util.concurrent.atomic.AtomicLong;
import org.springframework.stereotype.Component;

/**
 * Counters worth watching. `duplicatesSkipped` climbing is not a fault - it is
 * at-least-once delivery being caught by the dedup set, which is exactly what
 * should happen. It climbing *fast* means something is re-publishing.
 *
 * Exposed on /health, because a 200 there only proves the web server is alive;
 * these prove the consumer is actually consuming.
 */
@Component
public class ProjectionCounters {

  private final AtomicLong applied = new AtomicLong();
  private final AtomicLong duplicatesSkipped = new AtomicLong();
  private final AtomicLong deadLettered = new AtomicLong();

  public void countApplied() {
    applied.incrementAndGet();
  }

  public void countDuplicate() {
    duplicatesSkipped.incrementAndGet();
  }

  public void countDeadLettered() {
    deadLettered.incrementAndGet();
  }

  public record Snapshot(long applied, long duplicatesSkipped, long deadLettered) {}

  public Snapshot snapshot() {
    return new Snapshot(applied.get(), duplicatesSkipped.get(), deadLettered.get());
  }
}
