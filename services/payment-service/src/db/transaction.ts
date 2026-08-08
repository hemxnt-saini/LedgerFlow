import type { PoolClient } from 'pg';
import { pool } from './pool';

/**
 * Runs fn inside a single transaction; rolls back on any throw.
 *
 * This is what makes the outbox pattern work: the business rows and the event
 * row are written through the same client, so they commit together or not at
 * all. There is no window in which one exists without the other.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
