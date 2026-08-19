package com.ledgerflow.payment.config;

import java.util.HashMap;
import java.util.Map;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.common.serialization.StringSerializer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.core.DefaultKafkaProducerFactory;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.core.ProducerFactory;

/**
 * The broker client. Only the outbox publisher uses it - this service never
 * consumes, it only ever hands events off.
 *
 * Every timeout here is short on purpose. A dead broker must make the publisher
 * fail quickly so the tick can be retried on the next beat; the payment itself
 * has already been committed to Postgres, so the outbox row simply waits. That
 * is the whole reason the outbox exists: "kill the broker and payments keep
 * working".
 */
@Configuration
public class KafkaConfig {

  @Bean
  public ProducerFactory<String, String> producerFactory() {
    Map<String, Object> props = new HashMap<>();
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, Config.Kafka.BROKERS);
    props.put(ProducerConfig.CLIENT_ID_CONFIG, Config.Kafka.CLIENT_ID);
    props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
    props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
    // Every replica that has to have it, has it. A payment event is not worth
    // losing to a leader failover.
    props.put(ProducerConfig.ACKS_CONFIG, "all");
    props.put(ProducerConfig.MAX_BLOCK_MS_CONFIG, 5_000);
    props.put(ProducerConfig.REQUEST_TIMEOUT_MS_CONFIG, 5_000);
    props.put(ProducerConfig.DELIVERY_TIMEOUT_MS_CONFIG, 10_000);
    props.put(ProducerConfig.RETRIES_CONFIG, 10);
    return new DefaultKafkaProducerFactory<>(props);
  }

  @Bean
  public KafkaTemplate<String, String> kafkaTemplate(ProducerFactory<String, String> factory) {
    return new KafkaTemplate<>(factory);
  }
}
