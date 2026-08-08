import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/pool';
import { currentCorrelationId } from '../lib/logger';

export interface OutboxRow {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
}

/**
 * Transactional outbox write: the event goes into the same DB transaction as
 * the business data, so we can never publish an event for a rolled-back
 * payment, nor commit a payment whose event was lost. That is the dual-write
 * problem, and one commit is the only real answer to it.
 */
export async function enqueue(
  db: Queryable,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.query('INSERT INTO outbox (event_type, payload) VALUES ($1, $2)', [
    eventType,
    JSON.stringify({
      // Publishing is at-least-once (a crash between the Kafka send and the
      // COMMIT re-sends the row), so every event carries a stable id and
      // consumers apply it once. Generated here, not at publish time, so a
      // re-publish carries the *same* id.
      eventId: randomUUID(),
      type: eventType,
      // Rides along in the payload so it survives the trip through Kafka and
      // the read side can log under the same id.
      correlationId: currentCorrelationId(),
      ...payload,
    }),
  ]);
}

/**
 * Claims unpublished rows for this poller pass.
 *
 * SKIP LOCKED means several instances could poll concurrently without
 * publishing the same row twice.
 */
export async function claimUnpublished(
  db: Queryable,
  limit: number,
): Promise<OutboxRow[]> {
  const { rows } = await db.query<OutboxRow>(
    `SELECT id, event_type, payload
       FROM outbox
      WHERE published_at IS NULL
      ORDER BY id
        FOR UPDATE SKIP LOCKED
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function markPublished(db: Queryable, ids: string[]): Promise<void> {
  await db.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [
    ids,
  ]);
}
