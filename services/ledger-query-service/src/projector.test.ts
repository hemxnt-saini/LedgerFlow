import {
  ACTIVITY_KEY,
  accountKey,
  applyEvent,
  dayOf,
  dayStatsKey,
  paymentIndexKey,
  paymentKey,
  statsKey,
  type PaymentEvent,
  type RedisLike,
} from './projector';

/** In-memory stand-in for Redis - no server needed to test the projection. */
function fakeRedis() {
  const hashes = new Map<string, Record<string, string>>();
  const lists = new Map<string, string[]>();
  const sets = new Map<string, Set<string>>();
  const zsets = new Map<string, Map<string, number>>();
  const expiries = new Map<string, number>();

  const client: RedisLike = {
    async hset(key, values) {
      const hash = hashes.get(key) ?? {};
      for (const [field, value] of Object.entries(values)) hash[field] = String(value);
      hashes.set(key, hash);
    },
    async hincrby(key, field, increment) {
      const hash = hashes.get(key) ?? {};
      hash[field] = String(Number(hash[field] ?? 0) + increment);
      hashes.set(key, hash);
    },
    async lpush(key, value) {
      lists.set(key, [value, ...(lists.get(key) ?? [])]);
    },
    async ltrim(key, start, stop) {
      lists.set(key, (lists.get(key) ?? []).slice(start, stop + 1));
    },
    async zadd(key, score, member) {
      const zset = zsets.get(key) ?? new Map<string, number>();
      zset.set(member, score);
      zsets.set(key, zset);
    },
    async zremrangebyrank(key, start, stop) {
      const zset = zsets.get(key);
      if (!zset) return;
      const ranked = [...zset].sort((a, b) => a[1] - b[1]);
      const size = ranked.length;
      const first = start < 0 ? Math.max(size + start, 0) : start;
      const last = stop < 0 ? size + stop : Math.min(stop, size - 1);
      for (let i = first; i <= last && i < size; i++) zset.delete(ranked[i][0]);
    },
    async expire(key, seconds) {
      expiries.set(key, seconds);
    },
    async sadd(key, member) {
      const set = sets.get(key) ?? new Set<string>();
      sets.set(key, set);
      if (set.has(member)) return 0;
      set.add(member);
      return 1;
    },
  };

  return {
    client,
    balance: (id: string) => Number(hashes.get(accountKey(id))?.balanceCents),
    hash: (key: string) => hashes.get(key),
    payment: (id: string) => hashes.get(paymentKey(id)),
    feed: (id: string) =>
      [...(zsets.get(paymentIndexKey(id)) ?? new Map())]
        .sort((a, b) => b[1] - a[1])
        .map(([member]) => member),
    activity: () => (lists.get(ACTIVITY_KEY) ?? []).map((raw) => JSON.parse(raw)),
    ttl: (key: string) => expiries.get(key),
  };
}

const AT = '2024-03-05T10:00:00.000Z';
let nextEventId = 0;
beforeEach(() => {
  nextEventId = 0;
});
const id = () => `evt-${++nextEventId}`;

const created = (account: string, balanceCents: number): PaymentEvent => ({
  eventId: id(),
  type: 'account.created',
  accountId: account,
  name: `acct-${account}`,
  balanceCents,
  occurredAt: AT,
});

type PaymentType = Exclude<PaymentEvent['type'], 'account.created'>;

const event = (
  type: PaymentType,
  overrides: Partial<{
    paymentId: string;
    amountCents: number;
    occurredAt: string;
    failureReason: string;
  }> = {},
): PaymentEvent =>
  ({
    eventId: id(),
    type,
    paymentId: overrides.paymentId ?? 'pay-1',
    fromAccountId: 'a',
    toAccountId: 'b',
    amountCents: overrides.amountCents ?? 2_500,
    note: 'lunch',
    occurredAt: overrides.occurredAt ?? AT,
    failureReason: overrides.failureReason ?? 'SETTLEMENT_FAILED_SIMULATED',
  }) as PaymentEvent;

async function seed(redis: RedisLike) {
  await applyEvent(redis, created('a', 10_000));
  await applyEvent(redis, created('b', 500));
}

describe('account.created', () => {
  it('writes the opening balance', async () => {
    const r = fakeRedis();
    await applyEvent(r.client, created('a', 10_000));
    expect(r.hash(accountKey('a'))).toEqual({
      id: 'a',
      name: 'acct-a',
      balanceCents: '10000',
    });
  });

  // With more than one partition there is no ordering guarantee between
  // events keyed by account and events keyed by payment. Every balance
  // mutation is therefore a delta, so any arrival order lands on the same
  // number - which is what makes partitioning safe here.
  it('lands on the same balance whichever order the events arrive in', async () => {
    const opening = created('a', 10_000);
    const spend = event('payment.initiated', { amountCents: 2_500 });

    const inOrder = fakeRedis();
    await applyEvent(inOrder.client, opening);
    await applyEvent(inOrder.client, spend);

    const reversed = fakeRedis();
    await applyEvent(reversed.client, spend);
    await applyEvent(reversed.client, opening);

    expect(inOrder.balance('a')).toBe(7_500);
    expect(reversed.balance('a')).toBe(7_500);
  });

  it('still records identity when the account event arrives last', async () => {
    const r = fakeRedis();
    await applyEvent(r.client, event('payment.initiated', { amountCents: 100 }));
    await applyEvent(r.client, created('a', 10_000));
    expect(r.hash(accountKey('a'))).toMatchObject({ id: 'a', name: 'acct-a' });
    expect(r.balance('a')).toBe(9_900);
  });
});

// The read model has to be correct at every step of the saga, not just at the
// end - a wallet showing the wrong balance for one second is a wrong wallet.
describe('the saga, projected step by step', () => {
  it('initiated debits the sender only - the money is in clearing', async () => {
    const r = fakeRedis();
    await seed(r.client);
    await applyEvent(r.client, event('payment.initiated'));

    expect(r.balance('a')).toBe(7_500);
    expect(r.balance('b')).toBe(500); // receiver has NOT been paid yet
    expect(r.payment('pay-1')).toMatchObject({ status: 'PROCESSING' });
  });

  it('completed credits the receiver and finishes the payment', async () => {
    const r = fakeRedis();
    await seed(r.client);
    await applyEvent(r.client, event('payment.initiated'));
    await applyEvent(r.client, event('payment.completed'));

    expect(r.balance('a')).toBe(7_500);
    expect(r.balance('b')).toBe(3_000);
    expect(r.payment('pay-1')).toMatchObject({ status: 'COMPLETED' });
  });

  it('stuck leaves balances alone - the money is still in clearing', async () => {
    const r = fakeRedis();
    await seed(r.client);
    await applyEvent(r.client, event('payment.initiated'));
    await applyEvent(r.client, event('payment.stuck'));

    expect(r.balance('a')).toBe(7_500); // still debited
    expect(r.balance('b')).toBe(500); // still not paid
    expect(r.payment('pay-1')).toMatchObject({
      status: 'AWAITING_REFUND',
      failureReason: 'SETTLEMENT_FAILED_SIMULATED',
    });
  });

  it('refunded returns the sender to exactly where they started', async () => {
    const r = fakeRedis();
    await seed(r.client);
    await applyEvent(r.client, event('payment.initiated'));
    await applyEvent(r.client, event('payment.stuck'));
    await applyEvent(r.client, event('payment.refunded'));

    expect(r.balance('a')).toBe(10_000);
    expect(r.balance('b')).toBe(500); // receiver never saw a cent
    expect(r.payment('pay-1')).toMatchObject({ status: 'REFUNDED' });
  });

  it('failed touches no balance at all', async () => {
    const r = fakeRedis();
    await seed(r.client);
    await applyEvent(r.client, event('payment.failed', { failureReason: 'INSUFFICIENT_FUNDS' }));

    expect(r.balance('a')).toBe(10_000);
    expect(r.balance('b')).toBe(500);
    expect(r.payment('pay-1')).toMatchObject({
      status: 'FAILED',
      failureReason: 'INSUFFICIENT_FUNDS',
    });
  });

  it('keeps one row per payment, not one per lifecycle event', async () => {
    const r = fakeRedis();
    await seed(r.client);
    await applyEvent(r.client, event('payment.initiated'));
    await applyEvent(r.client, event('payment.completed'));

    expect(r.feed('a')).toEqual(['pay-1']);
    expect(r.feed('b')).toEqual(['pay-1']);
  });

  it('keeps a payment in place in the feed as its status changes', async () => {
    const r = fakeRedis();
    await seed(r.client);
    await applyEvent(r.client, event('payment.initiated', { paymentId: 'old', occurredAt: '2024-03-05T09:00:00.000Z' }));
    await applyEvent(r.client, event('payment.initiated', { paymentId: 'new', occurredAt: '2024-03-05T11:00:00.000Z' }));
    // The older payment settles last - it must not jump to the top.
    await applyEvent(r.client, event('payment.completed', { paymentId: 'old', occurredAt: '2024-03-05T09:00:00.000Z' }));

    expect(r.feed('a')).toEqual(['new', 'old']);
  });

  it('records every lifecycle step in the global activity log', async () => {
    const r = fakeRedis();
    await seed(r.client);
    await applyEvent(r.client, event('payment.initiated'));
    await applyEvent(r.client, event('payment.completed'));

    expect(r.activity().map((a) => a.type)).toEqual([
      'payment.completed',
      'payment.initiated',
    ]);
  });
});

describe('statistics', () => {
  it('counts money only once it has actually arrived', async () => {
    const r = fakeRedis();
    await seed(r.client);
    await applyEvent(r.client, event('payment.initiated'));

    // In flight is not sent.
    expect(r.hash(statsKey('a'))).toBeUndefined();

    await applyEvent(r.client, event('payment.completed'));
    expect(r.hash(statsKey('a'))).toMatchObject({ sentCents: '2500', sentCount: '1' });
    expect(r.hash(statsKey('b'))).toMatchObject({ receivedCents: '2500', receivedCount: '1' });
  });

  it('does not count a payment that got stuck and refunded', async () => {
    const r = fakeRedis();
    await seed(r.client);
    await applyEvent(r.client, event('payment.initiated'));
    await applyEvent(r.client, event('payment.stuck'));
    await applyEvent(r.client, event('payment.refunded'));

    expect(r.hash(statsKey('a'))).toBeUndefined();
    expect(r.hash(statsKey('b'))).toBeUndefined();
  });

  it('buckets by UTC day and expires the bucket', async () => {
    const r = fakeRedis();
    await seed(r.client);
    await applyEvent(r.client, event('payment.completed'));

    expect(dayOf(AT)).toBe('2024-03-05');
    expect(r.hash(dayStatsKey('a', '2024-03-05'))).toMatchObject({ sentCents: '2500' });
    expect(r.ttl(dayStatsKey('a', '2024-03-05'))).toBeGreaterThan(0);
    // Lifetime totals must never expire.
    expect(r.ttl(statsKey('a'))).toBeUndefined();
  });

  it('accumulates across payments and days', async () => {
    const r = fakeRedis();
    await seed(r.client);
    await applyEvent(r.client, event('payment.completed', { paymentId: 'p1', amountCents: 1_000 }));
    await applyEvent(r.client, event('payment.completed', { paymentId: 'p2', amountCents: 250, occurredAt: '2024-03-06T08:00:00.000Z' }));

    expect(r.hash(statsKey('a'))).toMatchObject({ sentCents: '1250', sentCount: '2' });
    expect(r.hash(dayStatsKey('a', '2024-03-05'))).toMatchObject({ sentCents: '1000' });
    expect(r.hash(dayStatsKey('a', '2024-03-06'))).toMatchObject({ sentCents: '250' });
  });
});

describe('feed limits', () => {
  it('keeps only the most recent 100 payments per account', async () => {
    const r = fakeRedis();
    await seed(r.client);
    for (let i = 0; i < 120; i++) {
      await applyEvent(
        r.client,
        event('payment.initiated', {
          paymentId: `p${String(i).padStart(3, '0')}`,
          occurredAt: new Date(Date.parse(AT) + i * 1000).toISOString(),
        }),
      );
    }
    const feed = r.feed('a');
    expect(feed).toHaveLength(100);
    expect(feed[0]).toBe('p119'); // newest kept
    expect(feed).not.toContain('p000'); // oldest dropped
  });

  it('caps the global activity log', async () => {
    const r = fakeRedis();
    await seed(r.client);
    for (let i = 0; i < 250; i++) {
      await applyEvent(r.client, event('payment.initiated', { paymentId: `p${i}` }));
    }
    expect(r.activity()).toHaveLength(200);
  });
});

// Delivery is at-least-once from both ends - the outbox can re-publish after
// a crash, and Kafka can redeliver on a rebalance. Applying twice would
// invent money, so these are the tests that matter most.
describe('at-least-once delivery', () => {
  it('ignores a redelivered event instead of double-counting', async () => {
    const r = fakeRedis();
    await seed(r.client);
    const initiated = event('payment.initiated');

    expect(await applyEvent(r.client, initiated)).toBe(true);
    expect(await applyEvent(r.client, initiated)).toBe(false);
    expect(await applyEvent(r.client, initiated)).toBe(false);

    expect(r.balance('a')).toBe(7_500);
    expect(r.activity()).toHaveLength(1);
  });

  it('does not double-count a redelivered completion, or its statistics', async () => {
    const r = fakeRedis();
    await seed(r.client);
    await applyEvent(r.client, event('payment.initiated'));
    const completed = event('payment.completed');
    await applyEvent(r.client, completed);
    await applyEvent(r.client, completed);

    expect(r.balance('b')).toBe(3_000);
    expect(r.hash(statsKey('b'))).toMatchObject({ receivedCents: '2500', receivedCount: '1' });
  });

  it('treats two distinct events with identical payloads as two payments', async () => {
    const r = fakeRedis();
    await seed(r.client);
    await applyEvent(r.client, event('payment.initiated', { paymentId: 'x' }));
    await applyEvent(r.client, event('payment.initiated', { paymentId: 'y' }));

    expect(r.balance('a')).toBe(5_000);
    expect(r.feed('a')).toHaveLength(2);
  });

  it('replaying the whole stream is a no-op on an already-built read model', async () => {
    const stream: PaymentEvent[] = [
      created('a', 10_000),
      created('b', 500),
      event('payment.initiated'),
      event('payment.completed'),
    ];
    const r = fakeRedis();
    for (const e of stream) await applyEvent(r.client, e);
    const snapshot = [r.balance('a'), r.balance('b'), r.activity().length];

    for (const e of stream) await applyEvent(r.client, e);
    expect([r.balance('a'), r.balance('b'), r.activity().length]).toEqual(snapshot);
  });

  it('rebuilds identical state when replayed into an empty read model', async () => {
    const stream: PaymentEvent[] = [
      created('a', 10_000),
      created('b', 500),
      event('payment.initiated'),
      event('payment.stuck'),
      event('payment.refunded'),
    ];

    const original = fakeRedis();
    for (const e of stream) await applyEvent(original.client, e);
    const rebuilt = fakeRedis();
    for (const e of stream) await applyEvent(rebuilt.client, e);

    expect(rebuilt.balance('a')).toBe(original.balance('a'));
    expect(rebuilt.balance('b')).toBe(original.balance('b'));
    expect(rebuilt.payment('pay-1')).toEqual(original.payment('pay-1'));
    expect(rebuilt.activity()).toEqual(original.activity());
  });
});
