import { config } from '../config';
import { isDerivedKey } from '../domain/payment';
import { conflict } from '../lib/http-error';
import { redis } from '../lib/redis';
import type { PaymentDto } from '../models/payment.model';

const cacheKey = (key: string) => `idempotency:${key}`;

/** What gets cached in Redis under an idempotency key. */
interface CachedResult {
  fingerprint: string;
  response: PaymentDto;
}

/**
 * First line of defence against a double charge: a replayed request never
 * reaches Postgres.
 *
 * Returns the original response if this key has been seen with the *same*
 * request, and throws if it has been seen with a different one. Returning the
 * first payment in that case would be worse than failing - the caller asked a
 * different question and would get a confident wrong answer.
 */
export async function findReplay(
  key: string,
  fingerprint: string,
): Promise<PaymentDto | null> {
  const cached = await redis.get(cacheKey(key));
  if (!cached) return null;

  const entry: CachedResult = JSON.parse(cached);
  if (entry.fingerprint !== fingerprint) throw conflict('IDEMPOTENCY_KEY_REUSED');
  return entry.response;
}

/**
 * A client-supplied key is a promise about a specific payment, so it is kept
 * for a day. A derived one is only a double-submit guard, so it expires in a
 * minute - otherwise a legitimate repeat payment of the same amount to the
 * same person would be silently swallowed.
 */
export async function remember(
  key: string,
  fingerprint: string,
  response: PaymentDto,
): Promise<void> {
  const entry: CachedResult = { fingerprint, response };
  const ttl = isDerivedKey(key)
    ? config.idempotency.derivedTtlSeconds
    : config.idempotency.ttlSeconds;
  await redis.set(cacheKey(key), JSON.stringify(entry), 'EX', ttl);
}
