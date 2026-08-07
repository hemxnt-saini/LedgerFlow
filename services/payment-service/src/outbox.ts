import { Kafka, type Producer } from 'kafkajs';
import { pool } from './db';
import { startPoller, type Poller } from './poller';
import { log } from './logger';

const TOPIC = process.env.KAFKA_TOPIC ?? 'payment-events';
const POLL_MS = Number(process.env.OUTBOX_POLL_MS ?? 400);
const BATCH = 100;

const kafka = new Kafka({
  clientId: 'payment-service',
  brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(','),
  retry: { retries: 10 },
});

/**
 * Polls the outbox and publishes to Kafka.
 *
 * FOR UPDATE SKIP LOCKED means several instances of this service could poll
 * concurrently without publishing the same row twice. Delivery is at-least-
 * once: a crash between publish and COMMIT re-sends the row, which is why
 * every event carries an eventId and the read model applies it once.
 */
export function startOutboxPublisher(): Poller {
  let producer: Producer | undefined;

  const poller = startPoller('outbox', POLL_MS, async () => {
    try {
      if (!producer) {
        producer = kafka.producer();
        await producer.connect();
        log.info('outbox producer connected');
      }
      // Drain in batches so a backlog clears fast instead of 100 rows/second.
      let sent = 0;
      let batch = 0;
      do {
        batch = await publishBatch(producer);
        sent += batch;
      } while (batch === BATCH);
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

/** Publishes up to BATCH unpublished rows. Returns how many were sent. */
async function publishBatch(producer: Producer): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{
      id: string;
      event_type: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT id, event_type, payload
         FROM outbox
        WHERE published_at IS NULL
        ORDER BY id
          FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [BATCH],
    );

    if (rows.length > 0) {
      const publishedAt = String(Date.now());
      await producer.send({
        topic: TOPIC,
        messages: rows.map((row) => ({
          // Keyed by payment/account id so related events keep their order
          // if the topic is ever given more than one partition.
          key: String(row.payload.paymentId ?? row.payload.accountId ?? row.id),
          value: JSON.stringify(row.payload),
          // Header, not payload: the payload is fixed when the event is
          // enqueued, but this is when it actually left. The read side uses
          // the gap between the two to show real outbox latency.
          headers: {
            publishedAt,
            // Also a header, so a consumer can pick it up without parsing.
            correlationId: String(row.payload.correlationId ?? ''),
          },
        })),
      });
      await client.query(
        'UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])',
        [rows.map((row) => row.id)],
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
