/**
 * Pure read-model projection: payment event -> Redis state.
 *
 * Zero imports of express/ioredis/kafkajs. The Redis client is passed in as
 * `RedisLike`, a structural interface that ioredis happens to satisfy - so
 * production passes the real client and tests pass an in-memory fake. Same
 * trick as an Axon @EventHandler taking an injected repository.
 *
 * The interface is deliberately write-only. The projection never reads back
 * what it wrote, so it cannot develop opinions about state it did not just
 * receive, and every key it touches is derivable from the event alone.
 */

export type PaymentEvent =
  | AccountCreated
  | PaymentInitiated
  | PaymentRetrying
  | PaymentCompleted
  | PaymentFailed
  | PaymentStuck
  | PaymentRefunded;

export interface AccountCreated {
  /** Stable per event, assigned by the producer's outbox. */
  eventId: string;
  type: 'account.created';
  accountId: string;
  name: string;
  balanceCents: number;
  occurredAt: string;
}

interface PaymentEventBase {
  eventId: string;
  paymentId: string;
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  note: string | null;
  occurredAt: string;
}

/** Leg 1 committed: sender debited, funds held in clearing. */
export interface PaymentInitiated extends PaymentEventBase {
  type: 'payment.initiated';
}

/**
 * Leg 2 failed but has retries left. No money moves; the payment stays
 * PROCESSING and will be tried again after a backoff.
 */
export interface PaymentRetrying extends PaymentEventBase {
  type: 'payment.settlement_retrying';
  failureReason: string;
  attempts: number;
  maxAttempts: number;
  retryInMs: number;
}

/** Leg 2 committed: receiver credited. */
export interface PaymentCompleted extends PaymentEventBase {
  type: 'payment.completed';
  attempts?: number;
}

/** Rejected before any money moved. */
export interface PaymentFailed extends PaymentEventBase {
  type: 'payment.failed';
  failureReason: string;
}

/** Leg 2 failed: the sender's money is stranded in clearing, owed back. */
export interface PaymentStuck extends PaymentEventBase {
  type: 'payment.stuck';
  failureReason: string;
}

/** Compensation committed: stranded funds returned to the sender. */
export interface PaymentRefunded extends PaymentEventBase {
  type: 'payment.refunded';
}

/** The only Redis surface the projection needs, all of it writes. */
export interface RedisLike {
  hset(key: string, values: Record<string, string | number>): Promise<unknown>;
  hincrby(key: string, field: string, increment: number): Promise<unknown>;
  lpush(key: string, value: string): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zremrangebyrank(key: string, start: number, stop: number): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  /** Returns 1 if the member was new, 0 if it was already in the set. */
  sadd(key: string, member: string): Promise<number>;
}

const MAX_PAYMENTS_PER_ACCOUNT = 100;
const MAX_ACTIVITY = 200;
const DAY_BUCKET_TTL_SECONDS = 40 * 24 * 60 * 60;

export const accountKey = (id: string) => `account:${id}`;
export const paymentKey = (id: string) => `payment:${id}`;
export const paymentIndexKey = (accountId: string) => `account:${accountId}:payments`;
export const statsKey = (accountId: string) => `stats:${accountId}`;
export const dayStatsKey = (accountId: string, day: string) =>
  `stats:${accountId}:d:${day}`;
export const ACTIVITY_KEY = 'activity';
export const APPLIED_EVENTS_KEY = 'projection:applied';

/** Read-model status implied by each event. One row per payment, mutated in place. */
const STATUS_BY_EVENT = {
  'payment.initiated': 'PROCESSING',
  // Still in flight: a retry is not a new state, it is the same state with
  // another attempt spent.
  'payment.settlement_retrying': 'PROCESSING',
  'payment.completed': 'COMPLETED',
  'payment.failed': 'FAILED',
  'payment.stuck': 'AWAITING_REFUND',
  'payment.refunded': 'REFUNDED',
} as const;

/** ISO timestamps sort and slice; no Date parsing needed for a UTC day bucket. */
export const dayOf = (occurredAt: string) => occurredAt.slice(0, 10);

/**
 * Whether this version knows how to project a type. Checked *before* the
 * event id is claimed: claiming first would mean that after adding support
 * and replaying the event, the dedup set would skip it forever.
 */
export const isKnownEventType = (type: string): boolean =>
  type === 'account.created' || type in STATUS_BY_EVENT;

/**
 * Applies one event to the read model, exactly once.
 *
 * Delivery is at-least-once from both ends: the outbox publisher can re-send
 * a row after crashing between the Kafka send and its COMMIT, and Kafka can
 * redeliver on a consumer rebalance. `HINCRBY` applied twice would invent
 * money out of nothing, so the event id is claimed first and a second sighting
 * is a no-op. Wiping Redis clears the claims too, which is what makes
 * "delete the read model and replay the topic" rebuild it correctly.
 *
 * Returns true if the event was applied, false if it was a duplicate.
 */
export async function applyEvent(
  redis: RedisLike,
  event: PaymentEvent,
): Promise<boolean> {
  // ponytail: the claim set grows without bound. Fine for a demo topic; swap
  // for per-event keys with a TTL longer than the retention if it ever matters.
  if ((await redis.sadd(APPLIED_EVENTS_KEY, event.eventId)) === 0) return false;

  await project(redis, event);
  return true;
}

async function project(redis: RedisLike, event: PaymentEvent): Promise<void> {
  if (event.type === 'account.created') {
    // Identity is set absolutely - it never changes, so writing it twice is
    // harmless. The opening balance is applied as a *delta*, not a set.
    //
    // That distinction is what makes more than one partition safe. Events for
    // one account and events for one payment hash to different partitions, so
    // there is no ordering guarantee between them; an absolute write arriving
    // after an increment would wipe it out. Every balance mutation in this
    // file is therefore commutative, and the dedup set stops any of them being
    // applied twice.
    await redis.hset(accountKey(event.accountId), {
      id: event.accountId,
      name: event.name,
    });
    await redis.hincrby(accountKey(event.accountId), 'balanceCents', event.balanceCents);
    return;
  }

  // Callers screen unknown types out before the id is claimed, so by here the
  // status is always defined.
  const status = STATUS_BY_EVENT[event.type];

  // Balances mirror the ledger legs exactly, one delta per event, so the read
  // model is correct at every step of the saga - not only at the end.
  //
  //   initiated  sender -= amount   (money is now in clearing)
  //   completed  receiver += amount (clearing paid it out)
  //   refunded   sender += amount   (clearing gave it back)
  //   failed/stuck  no balance change
  switch (event.type) {
    case 'payment.initiated':
      await redis.hincrby(accountKey(event.fromAccountId), 'balanceCents', -event.amountCents);
      break;
    case 'payment.completed':
      await redis.hincrby(accountKey(event.toAccountId), 'balanceCents', event.amountCents);
      await countCompleted(redis, event);
      break;
    case 'payment.refunded':
      await redis.hincrby(accountKey(event.fromAccountId), 'balanceCents', event.amountCents);
      break;
  }

  await upsertPayment(redis, event, status);
  await recordActivity(redis, event);
}

/**
 * One hash per payment plus a per-account index, rather than an append-only
 * list: a payment is a single thing whose status changes, and a wallet shows
 * it as one row, not one row per lifecycle event.
 */
async function upsertPayment(
  redis: RedisLike,
  event: Exclude<PaymentEvent, AccountCreated>,
  status: string,
): Promise<void> {
  await redis.hset(paymentKey(event.paymentId), {
    paymentId: event.paymentId,
    fromAccountId: event.fromAccountId,
    toAccountId: event.toAccountId,
    amountCents: event.amountCents,
    note: event.note ?? '',
    status,
    failureReason: 'failureReason' in event ? event.failureReason : '',
    attempts: 'attempts' in event && event.attempts !== undefined ? event.attempts : 0,
    updatedAt: event.occurredAt,
  });

  // Score by the initiating event so a payment keeps its place in the feed as
  // it moves through the saga instead of jumping to the top on every update.
  if (event.type === 'payment.initiated' || event.type === 'payment.failed') {
    await redis.hset(paymentKey(event.paymentId), { createdAt: event.occurredAt });
  }
  const score = Date.parse(event.occurredAt);

  for (const accountId of [event.fromAccountId, event.toAccountId]) {
    await redis.zadd(paymentIndexKey(accountId), score, event.paymentId);
    await redis.zremrangebyrank(
      paymentIndexKey(accountId),
      0,
      -(MAX_PAYMENTS_PER_ACCOUNT + 1),
    );
  }
}

/** Money only counts as sent or received once it has actually arrived. */
async function countCompleted(
  redis: RedisLike,
  event: PaymentCompleted,
): Promise<void> {
  const day = dayOf(event.occurredAt);
  const buckets: [string, string, number][] = [
    [statsKey(event.fromAccountId), 'sent', event.amountCents],
    [dayStatsKey(event.fromAccountId, day), 'sent', event.amountCents],
    [statsKey(event.toAccountId), 'received', event.amountCents],
    [dayStatsKey(event.toAccountId, day), 'received', event.amountCents],
  ];
  for (const [key, field, amount] of buckets) {
    await redis.hincrby(key, `${field}Cents`, amount);
    await redis.hincrby(key, `${field}Count`, 1);
    if (key.includes(':d:')) await redis.expire(key, DAY_BUCKET_TTL_SECONDS);
  }
}

/** The global "John paid Alice" ticker. Append-only: this one really is a log. */
async function recordActivity(
  redis: RedisLike,
  event: Exclude<PaymentEvent, AccountCreated>,
): Promise<void> {
  await redis.lpush(
    ACTIVITY_KEY,
    JSON.stringify({
      eventId: event.eventId,
      type: event.type,
      paymentId: event.paymentId,
      fromAccountId: event.fromAccountId,
      toAccountId: event.toAccountId,
      amountCents: event.amountCents,
      note: event.note ?? '',
      failureReason: 'failureReason' in event ? event.failureReason : null,
      occurredAt: event.occurredAt,
    }),
  );
  await redis.ltrim(ACTIVITY_KEY, 0, MAX_ACTIVITY - 1);
}
