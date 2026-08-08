import { Kafka } from 'kafkajs';
import { config } from '../config';

export const kafka = new Kafka({
  clientId: config.kafka.clientId,
  brokers: config.kafka.brokers,
  retry: { retries: 10 },
});

/**
 * fromBeginning: a brand new consumer group replays the entire topic and
 * rebuilds the read model from scratch - the point of keeping the events.
 */
export const consumer = kafka.consumer({ groupId: config.kafka.groupId });
