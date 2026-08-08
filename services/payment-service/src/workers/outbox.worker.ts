import type { Producer } from 'kafkajs';
import { config } from '../config';
import { pool } from '../db/pool';
import { kafka } from '../lib/kafka';
import { log } from '../lib/logger';
import { startPoller, type Poller } from '../lib/poller';
import * as outbox from '../repositories/outbox.repository';

/**
 * Publishes unpublished outbox rows to Kafka.
 *
 * Delivery is at-least-once: a crash between the send and the COMMIT re-sends
 * those rows. That is why every event carries an id assigned when it was
 * enqueued - a re-publish carries the same id, and the read model applies it
 * once.
 */
export function startOutboxPublisher(): Poller {
  let producer: Producer | undefined;

  const poller = startPoller('outbox', config.outbox.pollMs, async () => {
    try {
      if (!producer) {
        producer = kafka.producer();
        await producer.connect();
        log.info('outbox producer connected');
      }
      // Drain in batches so a backlog clears fast instead of one batch a tick.
      let sent = 0;
      let batch = 0;
      do {
        batch = await publishBatch(producer);
        sent += batch;
      } while (batch === config.outbox.batchSize);
      if (sent > 0) log.info('published outbox events', { count: sent });
    } catch (err) {
      // Drop the producer so the next tick reconnects (e.g. broker restarted).
      await producer?.disconnect().catch(() => undefined);
      producer = undefined;
      throw err;
    }
  });

  return {
    async stop() {
      await poller.stop();
      await producer?.disconnect().catch(() => undefined);
    },
  };
}

/** Publishes up to one batch of rows. Returns how many were sent. */
async function publishBatch(producer: Producer): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await outbox.claimUnpublished(client, config.outbox.batchSize);

    if (rows.length > 0) {
      const publishedAt = String(Date.now());
      await producer.send({
        topic: config.kafka.topic,
        messages: rows.map((row) => ({
          // Keyed by payment or account id, so every event about one payment
          // lands on the same partition and keeps its order.
          key: String(row.payload.paymentId ?? row.payload.accountId ?? row.id),
          value: JSON.stringify(row.payload),
          headers: {
            // A header, not the payload: the payload was fixed when the event
            // was enqueued, and this is when it actually left. The gap between
            // the two is real outbox latency.
            publishedAt,
            correlationId: String(row.payload.correlationId ?? ''),
          },
        })),
      });
      await outbox.markPublished(
        client,
        rows.map((row) => row.id),
      );
    }

    await client.query('COMMIT');
    return rows.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
