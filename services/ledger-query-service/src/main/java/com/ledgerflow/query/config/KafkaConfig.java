package com.ledgerflow.query.config;

import com.ledgerflow.query.lib.Log;
import java.util.HashMap;
import java.util.Map;
import org.apache.kafka.clients.admin.AdminClient;
import org.apache.kafka.clients.admin.AdminClientConfig;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.apache.kafka.common.serialization.StringSerializer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.ConcurrentKafkaListenerContainerFactory;
import org.springframework.kafka.config.TopicBuilder;
import org.springframework.kafka.core.ConsumerFactory;
import org.springframework.kafka.core.DefaultKafkaConsumerFactory;
import org.springframework.kafka.core.DefaultKafkaProducerFactory;
import org.springframework.kafka.core.KafkaAdmin;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.core.ProducerFactory;
import org.springframework.kafka.listener.ContainerProperties.AckMode;
import org.springframework.kafka.listener.DefaultErrorHandler;
import org.apache.kafka.clients.admin.NewTopic;
import org.springframework.util.backoff.FixedBackOff;

/**
 * The broker wiring for the read side: one consumer group projecting the main
 * topic, one watching the parking topic, and a producer for parking and
 * replaying messages.
 */
@Configuration
public class KafkaConfig {

  private Map<String, Object> common() {
    Map<String, Object> props = new HashMap<>();
    props.put(AdminClientConfig.BOOTSTRAP_SERVERS_CONFIG, Config.Kafka.BROKERS);
    props.put(AdminClientConfig.CLIENT_ID_CONFIG, Config.Kafka.CLIENT_ID);
    return props;
  }

  @Bean
  public ConsumerFactory<String, String> consumerFactory() {
    Map<String, Object> props = common();
    props.put(ConsumerConfig.GROUP_ID_CONFIG, Config.Kafka.GROUP_ID);
    props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
    props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
    // A brand new consumer group replays the entire topic and rebuilds the read
    // model from scratch - the point of keeping the events.
    props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
    // Offsets are committed by the container once a record has been handled, so
    // an event is never marked read before it has been applied.
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);
    return new DefaultKafkaConsumerFactory<>(props);
  }

  /**
   * A record that keeps failing is retried forever rather than skipped.
   *
   * That is deliberate, and it is the opposite of the framework default. A
   * projection failure almost always means Redis is unwell; dropping thousands
   * of perfectly good events during an outage would turn a blip into a
   * data-repair job. Blocking is recoverable, so it blocks.
   */
  @Bean
  public ConcurrentKafkaListenerContainerFactory<String, String> kafkaListenerContainerFactory(
      ConsumerFactory<String, String> consumerFactory) {
    ConcurrentKafkaListenerContainerFactory<String, String> factory =
        new ConcurrentKafkaListenerContainerFactory<>();
    factory.setConsumerFactory(consumerFactory);
    factory.getContainerProperties().setAckMode(AckMode.RECORD);

    DefaultErrorHandler errorHandler =
        new DefaultErrorHandler(
            (record, exception) ->
                Log.error(
                    "record handling failed, retrying",
                    "topic",
                    record.topic(),
                    "partition",
                    record.partition(),
                    "offset",
                    record.offset(),
                    "err",
                    exception),
            new FixedBackOff(1_000L, Long.MAX_VALUE));
    factory.setCommonErrorHandler(errorHandler);
    return factory;
  }

  @Bean
  public ProducerFactory<String, String> producerFactory() {
    Map<String, Object> props = common();
    props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
    props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
    props.put(ProducerConfig.ACKS_CONFIG, "all");
    props.put(ProducerConfig.MAX_BLOCK_MS_CONFIG, 5_000);
    props.put(ProducerConfig.REQUEST_TIMEOUT_MS_CONFIG, 5_000);
    props.put(ProducerConfig.DELIVERY_TIMEOUT_MS_CONFIG, 10_000);
    return new DefaultKafkaProducerFactory<>(props);
  }

  @Bean
  public KafkaTemplate<String, String> kafkaTemplate(ProducerFactory<String, String> factory) {
    return new KafkaTemplate<>(factory);
  }

  @Bean
  public KafkaAdmin kafkaAdmin() {
    KafkaAdmin admin = new KafkaAdmin(common());
    // A broker that is not up yet must not stop this service from starting: the
    // consumer will find the topic when it appears.
    admin.setFatalIfBrokerNotAvailable(false);
    return admin;
  }

  /**
   * On a cold start the read side is usually up before the first payment is ever
   * made, so the topic does not exist yet. Declaring it here creates it with the
   * right partition count instead of leaving the broker to guess.
   */
  @Bean
  public NewTopic paymentEventsTopic() {
    return TopicBuilder.name(Config.Kafka.TOPIC)
        .partitions(Config.Kafka.PARTITIONS)
        .replicas(1)
        .build();
  }

  /** The parking topic is a queue for a person to read, so one partition is right. */
  @Bean
  public NewTopic deadLetterTopic() {
    return TopicBuilder.name(Config.Kafka.DLQ_TOPIC).partitions(1).replicas(1).build();
  }

  /** The read-only window onto the broker that the Kafka page reads. */
  @Bean(destroyMethod = "close")
  public AdminClient adminClient() {
    return AdminClient.create(common());
  }
}
