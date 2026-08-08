import { config } from '../config';
import {
  ACTIVITY_KEY,
  accountKey,
  dayStatsKey,
  paymentIndexKey,
  paymentKey,
  statsKey,
} from '../domain/projector';
import { redis } from '../lib/redis';

/**
 * Every read of the projected state. Nothing outside this file knows what the
 * Redis keys look like, so the storage layout can change without touching a
 * route or a service.
 */

export const PIPELINE_KEY = 'pipeline:traces';
const APPLIED_EVENTS_KEY = 'projection:applied';

export interface ProjectedAccount {
  id: string;
  name: string;
  balanceCents: number;
}

export interface ProjectedPayment {
  paymentId: string;
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  note: string | null;
  status: string;
  failureReason: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface Counters {
  sentCents: number;
  receivedCents: number;
  sentCount: number;
  receivedCount: number;
}

export async function findAccount(id: string): Promise<ProjectedAccount | null> {
  const hash = await redis.hgetall(accountKey(id));
  if (!hash || Object.keys(hash).length === 0) return null;
  return { id, name: hash.name, balanceCents: Number(hash.balanceCents) };
}

/** One round trip for a whole dashboard rather than N. */
export async function findBalances(ids: string[]): Promise<Record<string, number>> {
  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.hgetall(accountKey(id));
  const results = (await pipeline.exec()) ?? [];

  const balances: Record<string, number> = {};
  ids.forEach((id, index) => {
    const hash = results[index]?.[1] as Record<string, string> | undefined;
    if (hash?.balanceCents !== undefined) balances[id] = Number(hash.balanceCents);
  });
  return balances;
}

/**
 * A payment is one row whose status changes, not one row per lifecycle event -
 * so this reads an index of ids and then the current state of each.
 */
export async function findPaymentsForAccount(
  accountId: string,
  limit: number,
): Promise<ProjectedPayment[]> {
  const ids = await redis.zrevrange(paymentIndexKey(accountId), 0, limit - 1);
  if (ids.length === 0) return [];

  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.hgetall(paymentKey(id));
  const results = (await pipeline.exec()) ?? [];

  return results
    .map(([, hash]) => hash as Record<string, string>)
    .filter((hash) => hash && Object.keys(hash).length > 0)
    .map((hash) => ({
      paymentId: hash.paymentId,
      fromAccountId: hash.fromAccountId,
      toAccountId: hash.toAccountId,
      amountCents: Number(hash.amountCents),
      note: hash.note || null,
      status: hash.status,
      failureReason: hash.failureReason || null,
      attempts: Number(hash.attempts ?? 0),
      createdAt: hash.createdAt,
      updatedAt: hash.updatedAt,
    }));
}

const readCounters = async (key: string): Promise<Counters> => {
  const hash = await redis.hgetall(key);
  return {
    sentCents: Number(hash.sentCents ?? 0),
    receivedCents: Number(hash.receivedCents ?? 0),
    sentCount: Number(hash.sentCount ?? 0),
    receivedCount: Number(hash.receivedCount ?? 0),
  };
};

export const findLifetimeCounters = (accountId: string) =>
  readCounters(statsKey(accountId));

export const findDayCounters = (accountId: string, day: string) =>
  readCounters(dayStatsKey(accountId, day));

export async function findActivity(limit: number): Promise<unknown[]> {
  const raw = await redis.lrange(ACTIVITY_KEY, 0, limit - 1);
  return raw.map((entry) => JSON.parse(entry));
}

export async function findPipelineTraces(limit: number): Promise<unknown[]> {
  const raw = await redis.lrange(PIPELINE_KEY, 0, limit - 1);
  return raw.map((entry) => JSON.parse(entry));
}

export async function appendPipelineTrace(trace: unknown): Promise<void> {
  await redis.lpush(PIPELINE_KEY, JSON.stringify(trace));
  await redis.ltrim(PIPELINE_KEY, 0, config.retention.pipelineTraces - 1);
}

/**
 * Deletes everything the projection owns, so it can be rebuilt from the log.
 *
 * Only the projected keys: the idempotency cache belongs to the payment
 * service and parked messages are their own record. The dedup claims go with
 * it, which is what lets every event apply again.
 *
 * ponytail: KEYS is fine at demo scale; SCAN if the keyspace ever grows.
 */
export async function clearProjection(): Promise<number> {
  const keys = [ACTIVITY_KEY, PIPELINE_KEY, APPLIED_EVENTS_KEY];
  for (const pattern of ['account:*', 'payment:*', 'stats:*']) {
    keys.push(...(await redis.keys(pattern)));
  }
  if (keys.length > 0) await redis.del(...keys);
  return keys.length;
}
