package com.ledgerflow.query.services;

import com.ledgerflow.query.config.Config;
import com.ledgerflow.query.lib.Log;
import org.springframework.kafka.config.KafkaListenerEndpointRegistry;
import org.springframework.kafka.listener.MessageListenerContainer;
import org.springframework.stereotype.Service;

/**
 * Pausing the consumer is the clearest demonstration this project has: keep
 * paying, watch lag climb partition by partition, resume, watch it drain. The
 * broker held everything in the meantime and nothing was lost - which is the
 * entire reason the queue is there.
 */
@Service
public class ConsumerControls {

  private static final String LISTENER_ID = "projection";

  private final KafkaListenerEndpointRegistry registry;
  private final ProjectionService projection;
  private volatile boolean paused;

  public ConsumerControls(KafkaListenerEndpointRegistry registry, ProjectionService projection) {
    this.registry = registry;
    this.projection = projection;
  }

  private MessageListenerContainer container() {
    return registry.getListenerContainer(LISTENER_ID);
  }

  public boolean isPaused() {
    return paused;
  }

  public void pause() {
    if (paused) return;
    container().pause();
    paused = true;
    Log.warn("consumer paused - lag will build up", "topic", Config.Kafka.TOPIC);
  }

  public void resume() {
    if (!paused) return;
    container().resume();
    paused = false;
    Log.info("consumer resumed - draining the backlog", "topic", Config.Kafka.TOPIC);
  }

  /** Rewind every partition to the start of the log. */
  public void rewind() {
    projection.rewind();
  }
}
