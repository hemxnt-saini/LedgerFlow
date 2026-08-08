import { Kafka } from 'kafkajs';
import { config } from '../config';

/**
 * The broker client. Only the outbox publisher uses it - this service never
 * consumes, it only ever hands events off.
 */
export const kafka = new Kafka({
  clientId: config.kafka.clientId,
  brokers: config.kafka.brokers,
  retry: { retries: 10 },
});
