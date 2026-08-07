import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { Consumer, Kafka, Producer } from 'kafkajs';
import { log } from './logger';

/**
 * The dead letter queue.
 *
 * Logging a bad message and moving on is data loss, and in a system that
 * moves money that is not acceptable - an event we could not understand is
 * still evidence that something happened. So an unprocessable message is
 * republished to a parking topic, where it can be looked at, fixed and
 * replayed instead of silently disappearing.
 *
 * Only *poison* messages come here: ones that will never succeed no matter
 * how many times they are tried (unparseable JSON, a missing event id, a type
 * this version does not know). A projection failure is different - that
 * usually means Redis is unwell, and dead-lettering thousands of perfectly
 * good events during an outage would turn a blip into a data-repair job. Those
 * are retried and then left to block, because blocking is recoverable.
 */

export const DLQ_TOPIC = process.env.KAFKA_DLQ_TOPIC ?? 'payment-events-dlq';
const DLQ_KEY = 'dlq:entries';
const MAX_DLQ_ENTRIES = 200;

export type DeadLetterReason =
  /** The message body was not JSON at all. */
  | 'UNPARSEABLE'
  /** Parsed, but missing the fields needed to handle it safely. */
  | 'MALFORMED'
  /** A well-formed event of a type this version cannot project. */
  | 'UNKNOWN_TYPE';

export interface DeadLetter {
  dlqId: string;
  reason: DeadLetterReason;
  detail: string;
  sourceTopic: string;
  partition: number;
  offset: string;
  key: string | null;
  /** The original bytes, verbatim, so a replay is byte-for-byte the same. */
  payload: string;
  failedAt: string;
  replayedAt?: string;
}

export function createDeadLetterQueue(kafka: Kafka, redis: Redis, mainTopic: string) {
  let producer: Producer | undefined;
  let consumer: Consumer | undefined;
  const listeners = new Set<(entry: DeadLetter) => void>();

  const getProducer = async (): Promise<Producer> => {
    if (!producer) {
      producer = kafka.producer();
      await producer.connect();
    }
    return producer;
  };

  return {
    onEntry(listener: (entry: DeadLetter) => void) {
      listeners.add(listener);
    },

    /** Park a message that can never be processed as-is. */
    async deadLetter(input: {
      reason: DeadLetterReason;
      detail: string;
      sourceTopic: string;
      partition: number;
      offset: string;
      key: string | null;
      payload: string;
    }): Promise<void> {
      const entry: DeadLetter = {
        dlqId: randomUUID(),
        failedAt: new Date().toISOString(),
        ...input,
      };
      const sender = await getProducer();
      // Kafka is the durable record. If this throws, the caller lets the
      // message block rather than dropping it - which is the whole point.
      await sender.send({
        topic: DLQ_TOPIC,
        messages: [{ key: entry.dlqId, value: JSON.stringify(entry) }],
      });
      log.warn('parked a poison message', {
        dlqId: entry.dlqId,
        reason: entry.reason,
        detail: entry.detail,
        sourceTopic: entry.sourceTopic,
        partition: entry.partition,
        offset: entry.offset,
      });
    },

    /**
     * A browsable copy of the parking topic. Kafka holds the truth; this makes
     * it listable without spinning up a consumer per request.
     */
    async startConsumer(): Promise<void> {
      const admin = kafka.admin();
      await admin.connect();
      await admin.createTopics({ topics: [{ topic: DLQ_TOPIC, numPartitions: 1 }] });
      await admin.disconnect();

      consumer = kafka.consumer({
        groupId: process.env.KAFKA_DLQ_GROUP_ID ?? 'ledger-query-service-dlq',
      });
      await consumer.connect();
      await consumer.subscribe({ topic: DLQ_TOPIC, fromBeginning: true });
      await consumer.run({
        eachMessage: async ({ message }) => {
          if (!message.value) return;
          let entry: DeadLetter;
          try {
            entry = JSON.parse(message.value.toString());
          } catch {
            return; // nothing sensible to do with a broken DLQ record
          }
          await redis.lpush(DLQ_KEY, JSON.stringify(entry));
          await redis.ltrim(DLQ_KEY, 0, MAX_DLQ_ENTRIES - 1);
          for (const listener of listeners) listener(entry);
        },
      });
      log.info('watching the parking topic', { topic: DLQ_TOPIC });
    },

    async list(limit: number): Promise<DeadLetter[]> {
      const raw = await redis.lrange(DLQ_KEY, 0, limit - 1);
      return raw.map((entry) => JSON.parse(entry));
    },

    /**
     * Put a parked message back on the main topic.
     *
     * Safe to do more than once: the read model claims each event id before
     * applying it, so replaying something already projected changes nothing.
     * Replaying a message that is still poison simply lands back here.
     */
    async replay(dlqId: string): Promise<DeadLetter | null> {
      const raw = await redis.lrange(DLQ_KEY, 0, MAX_DLQ_ENTRIES - 1);
      const index = raw.findIndex((item) => JSON.parse(item).dlqId === dlqId);
      if (index === -1) return null;

      const entry: DeadLetter = JSON.parse(raw[index]);
      const sender = await getProducer();
      await sender.send({
        topic: mainTopic,
        messages: [{ key: entry.key, value: entry.payload }],
      });

      const replayed = { ...entry, replayedAt: new Date().toISOString() };
      await redis.lset(DLQ_KEY, index, JSON.stringify(replayed));
      log.info('replayed a parked message', { dlqId, topic: mainTopic });
      return replayed;
    },

    async discard(dlqId: string): Promise<boolean> {
      const raw = await redis.lrange(DLQ_KEY, 0, MAX_DLQ_ENTRIES - 1);
      const found = raw.find((item) => JSON.parse(item).dlqId === dlqId);
      if (!found) return false;
      // Removes it from the browsable copy only. The parking topic keeps the
      // record - discarding is a UI action, not an erasure of history.
      await redis.lrem(DLQ_KEY, 1, found);
      return true;
    },

    async stop(): Promise<void> {
      await consumer?.disconnect().catch(() => undefined);
      await producer?.disconnect().catch(() => undefined);
    },
  };
}

export type DeadLetterQueue = ReturnType<typeof createDeadLetterQueue>;
