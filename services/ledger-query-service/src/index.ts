import express, { type NextFunction, type Request, type Response } from 'express';
import Redis from 'ioredis';
import { Kafka } from 'kafkajs';
import {
  ACTIVITY_KEY,
  accountKey,
  applyEvent,
  dayStatsKey,
  isKnownEventType,
  paymentIndexKey,
  paymentKey,
  statsKey,
  type PaymentEvent,
} from './projector';
import { createDeadLetterQueue, DLQ_TOPIC } from './dlq';
import { log, newCorrelationId, withContext } from './logger';
import { createConsumerControls, createKafkaAdmin } from './kafka-admin';

const PORT = Number(process.env.PORT ?? 4001);
const TOPIC = process.env.KAFKA_TOPIC ?? 'payment-events';
const PARTITIONS = Number(process.env.KAFKA_PARTITIONS ?? 3);
const PIPELINE_KEY = 'pipeline:traces';
const MAX_TRACES = 200;

/**
 * Counters worth watching. `duplicatesSkipped` climbing is not a fault - it
 * is at-least-once delivery being caught by the dedup set, which is exactly
 * what should happen. It climbing *fast* means something is re-publishing.
 */
const counters = { applied: 0, duplicatesSkipped: 0, deadLettered: 0 };

// Redis use #2: this is the whole database of the read side. There is no
// Postgres here - every value served below was projected from a Kafka event.
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

const kafka = new Kafka({
  clientId: 'ledger-query-service',
  brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(','),
  retry: { retries: 10 },
});

// fromBeginning: a brand new consumer group replays the entire topic and
// rebuilds the read model from scratch - the point of keeping the events.
const consumer = kafka.consumer({
  groupId: process.env.KAFKA_GROUP_ID ?? 'ledger-query-service',
});

const GROUP_ID = process.env.KAFKA_GROUP_ID ?? 'ledger-query-service';
const DLQ_GROUP_ID = process.env.KAFKA_DLQ_GROUP_ID ?? 'ledger-query-service-dlq';

const dlq = createDeadLetterQueue(kafka, redis, TOPIC);
const kafkaAdmin = createKafkaAdmin(kafka, [TOPIC, DLQ_TOPIC]);
const controls = createConsumerControls(consumer, TOPIC);

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Correlation-Id');
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.set('Access-Control-Expose-Headers', 'X-Correlation-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);

  const correlationId = req.header('X-Correlation-Id')?.trim() || newCorrelationId();
  res.set('X-Correlation-Id', correlationId);
  // The event stream is long-lived; logging it on finish would be misleading.
  const isStream = req.path === '/events/stream';
  const startedAt = Date.now();
  withContext({ correlationId }, () => {
    if (!isStream) {
      res.on('finish', () =>
        log.info('request', {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
        }),
      );
    }
    next();
  });
});

const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

const clampLimit = (raw: unknown, fallback: number, max: number) =>
  // Clamped both ways: a negative limit would turn into a negative range
  // index, which Redis reads as "from the end" and quietly returns the
  // wrong slice.
  Math.min(Math.max(Number(raw ?? fallback) || fallback, 1), max);

// ---------------------------------------------------------------------------
// Live push
// ---------------------------------------------------------------------------

/**
 * Every open browser tab. Server-Sent Events rather than WebSockets: all the
 * traffic is server -> client, EventSource reconnects on its own, and it needs
 * no library on either end.
 */
const subscribers = new Set<Response>();

function broadcast(name: string, data: unknown): void {
  const frame = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of subscribers) client.write(frame);
}

app.get('/events/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ connected: true })}\n\n`);
  subscribers.add(res);
  req.on('close', () => subscribers.delete(res));
});

// Proxies and browsers drop an idle stream; a comment line is the cheapest
// way to keep it warm and costs nothing to parse.
const keepAlive = setInterval(() => {
  for (const client of subscribers) client.write(': keep-alive\n\n');
}, 20_000);

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) =>
  res.json({
    status: 'ok',
    service: 'ledger-query-service',
    subscribers: subscribers.size,
    consumerPaused: controls.isPaused(),
    counters,
  }),
);

app.get(
  '/accounts/:id/balance',
  asyncRoute(async (req, res) => {
    const hash = await redis.hgetall(accountKey(req.params.id));
    if (!hash || Object.keys(hash).length === 0) {
      // Either the account does not exist, or its event has not been
      // projected yet - eventual consistency, not an error on the write side.
      return res.status(404).json({ error: 'ACCOUNT_NOT_IN_READ_MODEL' });
    }
    res.json({
      accountId: req.params.id,
      name: hash.name,
      balanceCents: Number(hash.balanceCents),
      source: 'redis-read-model',
    });
  }),
);

/** All balances in one call, so a dashboard does not need N round trips. */
app.get(
  '/balances',
  asyncRoute(async (req, res) => {
    const ids = String(req.query.ids ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 100);
    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.hgetall(accountKey(id));
    const results = (await pipeline.exec()) ?? [];

    const balances: Record<string, number> = {};
    ids.forEach((id, index) => {
      const hash = results[index]?.[1] as Record<string, string> | undefined;
      if (hash?.balanceCents !== undefined) balances[id] = Number(hash.balanceCents);
    });
    res.json({ balances, source: 'redis-read-model' });
  }),
);

const readPayments = async (accountId: string, limit: number) => {
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
};

app.get(
  '/accounts/:id/transactions',
  asyncRoute(async (req, res) => {
    res.json({
      accountId: req.params.id,
      transactions: await readPayments(req.params.id, clampLimit(req.query.limit, 50, 100)),
      source: 'redis-read-model',
    });
  }),
);

const readCounters = async (key: string) => {
  const hash = await redis.hgetall(key);
  return {
    sentCents: Number(hash.sentCents ?? 0),
    receivedCents: Number(hash.receivedCents ?? 0),
    sentCount: Number(hash.sentCount ?? 0),
    receivedCount: Number(hash.receivedCount ?? 0),
  };
};

const sumCounters = (buckets: Awaited<ReturnType<typeof readCounters>>[]) =>
  buckets.reduce(
    (total, bucket) => ({
      sentCents: total.sentCents + bucket.sentCents,
      receivedCents: total.receivedCents + bucket.receivedCents,
      sentCount: total.sentCount + bucket.sentCount,
      receivedCount: total.receivedCount + bucket.receivedCount,
    }),
    { sentCents: 0, receivedCents: 0, sentCount: 0, receivedCount: 0 },
  );

/**
 * Totals come from counters the projection maintains, not from scanning
 * history - the read side answers in O(1) because the write path already did
 * the arithmetic. "This week" is seven day-buckets added up.
 */
app.get(
  '/accounts/:id/stats',
  asyncRoute(async (req, res) => {
    const accountId = req.params.id;
    const today = new Date().toISOString().slice(0, 10);
    const days = Array.from({ length: 7 }, (_, offset) => {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() - offset);
      return date.toISOString().slice(0, 10);
    });

    const [allTime, ...weekBuckets] = await Promise.all([
      readCounters(statsKey(accountId)),
      ...days.map((day) => readCounters(dayStatsKey(accountId, day))),
    ]);

    res.json({
      accountId,
      allTime,
      today: weekBuckets[days.indexOf(today)] ?? sumCounters([]),
      thisWeek: sumCounters(weekBuckets),
      source: 'redis-read-model',
    });
  }),
);

/** The global "John paid Alice" ticker. */
app.get(
  '/activity',
  asyncRoute(async (req, res) => {
    const raw = await redis.lrange(ACTIVITY_KEY, 0, clampLimit(req.query.limit, 50, 200) - 1);
    res.json({ activity: raw.map((entry) => JSON.parse(entry)), source: 'redis-read-model' });
  }),
);

/** Measured stage latencies for the developer dashboard. */
app.get(
  '/pipeline',
  asyncRoute(async (req, res) => {
    const raw = await redis.lrange(PIPELINE_KEY, 0, clampLimit(req.query.limit, 50, 200) - 1);
    res.json({ traces: raw.map((entry) => JSON.parse(entry)) });
  }),
);

// ---------------------------------------------------------------------------
// Kafka control room
// ---------------------------------------------------------------------------

/** Partitions, log watermarks, consumer groups and their lag - from Kafka itself. */
app.get(
  '/kafka/overview',
  asyncRoute(async (_req, res) => {
    const overview = await kafkaAdmin.overview([GROUP_ID, DLQ_GROUP_ID]);
    res.json({
      ...overview,
      mainTopic: TOPIC,
      dlqTopic: DLQ_TOPIC,
      consumerPaused: controls.isPaused(),
      subscribers: subscribers.size,
    });
  }),
);

/**
 * Pause consumption. The producer keeps writing, the log keeps growing, lag
 * climbs - and nothing is lost. Resume and it drains.
 */
app.post(
  '/kafka/consumer/pause',
  asyncRoute(async (_req, res) => {
    controls.pause();
    res.json({ paused: true });
  }),
);

app.post(
  '/kafka/consumer/resume',
  asyncRoute(async (_req, res) => {
    controls.resume();
    res.json({ paused: false });
  }),
);

/**
 * Throw the read model away and rebuild it from the log.
 *
 * Deletes only the projected keys - the idempotency cache belongs to the
 * payment service and the parked messages are their own record - then rewinds
 * every partition to offset zero. The dedup claims go with the read model, so
 * every event applies again and the result is identical.
 */
app.post(
  '/kafka/consumer/rebuild',
  asyncRoute(async (_req, res) => {
    // ponytail: KEYS is fine at demo scale; SCAN if the keyspace ever grows.
    const patterns = ['account:*', 'payment:*', 'stats:*'];
    const keys = [ACTIVITY_KEY, PIPELINE_KEY, 'projection:applied'];
    for (const pattern of patterns) keys.push(...(await redis.keys(pattern)));
    if (keys.length > 0) await redis.del(...keys);

    controls.rewind(Array.from({ length: PARTITIONS }, (_, index) => index));
    res.json({ cleared: keys.length, rewoundPartitions: PARTITIONS });
  }),
);

// ---------------------------------------------------------------------------
// Dead letter queue
// ---------------------------------------------------------------------------

app.get(
  '/dlq',
  asyncRoute(async (req, res) => {
    const entries = await dlq.list(clampLimit(req.query.limit, 50, 200));
    res.json({
      topic: DLQ_TOPIC,
      pending: entries.filter((entry) => !entry.replayedAt).length,
      entries,
    });
  }),
);

/** Put a parked message back on the main topic. Safe to repeat: replays dedupe. */
app.post(
  '/dlq/:dlqId/replay',
  asyncRoute(async (req, res) => {
    const entry = await dlq.replay(req.params.dlqId);
    if (!entry) return res.status(404).json({ error: 'DLQ_ENTRY_NOT_FOUND' });
    res.json(entry);
  }),
);

app.post(
  '/dlq/replay-all',
  asyncRoute(async (_req, res) => {
    const entries = await dlq.list(200);
    const replayed = [];
    for (const entry of entries.filter((item) => !item.replayedAt)) {
      const result = await dlq.replay(entry.dlqId);
      if (result) replayed.push(result.dlqId);
    }
    res.json({ replayed: replayed.length, dlqIds: replayed });
  }),
);

/** Removes it from the browsable list. The parking topic keeps the record. */
app.delete(
  '/dlq/:dlqId',
  asyncRoute(async (req, res) => {
    const removed = await dlq.discard(req.params.dlqId);
    if (!removed) return res.status(404).json({ error: 'DLQ_ENTRY_NOT_FOUND' });
    res.json({ discarded: req.params.dlqId });
  }),
);

app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.error('unhandled error', { err });
  res.status(500).json({ error: 'INTERNAL_ERROR' });
});

// ---------------------------------------------------------------------------
// Consumer
// ---------------------------------------------------------------------------

/**
 * Real timings for every event, not invented lifecycle steps: when the write
 * side committed, when the outbox actually published, when this consumer got
 * it, when the read model reflected it. The gaps between those four numbers
 * are exactly the eventual-consistency window the UI warns about.
 */
function traceOf(
  event: PaymentEvent,
  publishedAt: number,
  receivedAt: number,
  projectedAt: number,
  location: { partition: number; offset: string },
) {
  const committedAt = Date.parse(event.occurredAt);
  return {
    eventId: event.eventId,
    type: event.type,
    paymentId: 'paymentId' in event ? event.paymentId : null,
    // Where it actually lived in the log.
    partition: location.partition,
    offset: location.offset,
    committedAt: new Date(committedAt).toISOString(),
    publishedAt: new Date(publishedAt).toISOString(),
    receivedAt: new Date(receivedAt).toISOString(),
    projectedAt: new Date(projectedAt).toISOString(),
    stages: {
      outboxMs: Math.max(publishedAt - committedAt, 0),
      transportMs: Math.max(receivedAt - publishedAt, 0),
      projectionMs: Math.max(projectedAt - receivedAt, 0),
      totalMs: Math.max(projectedAt - committedAt, 0),
    },
  };
}

async function startConsumer() {
  // On a cold start the read side is usually up before the first payment is
  // ever made, so the topic does not exist yet and subscribe() would fail
  // with UNKNOWN_TOPIC_OR_PARTITION. Creating it here is a no-op if it is
  // already there.
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: PARTITIONS }] });
  await admin.disconnect();

  // A stopped consumer is the worst failure this service has: the HTTP side
  // keeps answering 200 while the read model silently freezes. Exiting makes
  // it visible and lets the restart policy recover it.
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    log.error('consumer crashed, exiting to restart', { err: payload.error });
    process.exit(1);
  });

  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) =>
      // The id travelled with the event, so a payment's log lines on this
      // side line up with the ones the write side produced.
      withContext(
        {
          correlationId:
            message.headers?.correlationId?.toString() || newCorrelationId(),
        },
        async () => {
      const receivedAt = Date.now();
      if (!message.value) return;

      const raw = message.value.toString();
      const park = (reason: 'UNPARSEABLE' | 'MALFORMED' | 'UNKNOWN_TYPE', detail: string) =>
        dlq.deadLetter({
          reason,
          detail,
          sourceTopic: topic,
          partition,
          offset: message.offset,
          key: message.key?.toString() ?? null,
          payload: raw,
        });

      let event: PaymentEvent;
      try {
        event = JSON.parse(raw);
      } catch (err) {
        // Park it rather than drop it. Something produced this; that is a
        // fact worth keeping even when we cannot read it.
        await park('UNPARSEABLE', String(err));
        return;
      }
      // Trust boundary. An event without an id cannot be de-duplicated, and
      // one without a usable timestamp would poison the feed's sort score and
      // the day buckets. Neither is safe to apply to a balance.
      if (
        !event?.eventId ||
        !event?.type ||
        !Number.isFinite(Date.parse(event?.occurredAt))
      ) {
        await park('MALFORMED', 'needs eventId, type and a parseable occurredAt');
        return;
      }
      // Checked before applyEvent so the id is not claimed. Otherwise adding
      // support for the type later and replaying it would be a no-op.
      if (!isKnownEventType(event.type)) {
        await park('UNKNOWN_TYPE', `no projection for ${event.type}`);
        return;
      }

      // Throwing here makes kafkajs retry the message rather than commit the
      // offset, so a Redis blip does not silently lose an event.
      const applied = await applyEvent(redis, event);
      if (!applied) {
        counters.duplicatesSkipped += 1;
        log.debug('skipped duplicate', { type: event.type, eventId: event.eventId });
        return;
      }
      counters.applied += 1;

      // The read model is already updated and the offset is about to commit.
      // Telemetry and fan-out are best-effort from here: a failure in either
      // must not throw, because kafkajs treats an error out of eachMessage as
      // fatal and stops the consumer for good.
      try {
        const header = Number(message.headers?.publishedAt?.toString());
        const publishedAt = Number.isFinite(header) ? header : receivedAt;
        const trace = traceOf(event, publishedAt, receivedAt, Date.now(), {
          partition,
          offset: message.offset,
        });
        await redis.lpush(PIPELINE_KEY, JSON.stringify(trace));
        await redis.ltrim(PIPELINE_KEY, 0, MAX_TRACES - 1);
        log.info('projected event', {
          type: event.type,
          paymentId: 'paymentId' in event ? event.paymentId : undefined,
          totalMs: trace.stages.totalMs,
        });
        // The whole point of the read side: the moment state changes, every
        // open tab hears about it without polling.
        broadcast('payment-event', { event, trace });
      } catch (err) {
        log.error('event applied, telemetry failed', { err });
      }
        },
      ),
  });
  log.info('consuming from the beginning', { topic: TOPIC });
}

async function main() {
  await dlq.startConsumer();
  // Parked messages appear live in the monitor alongside everything else.
  dlq.onEntry((entry) => {
    counters.deadLettered += 1;
    broadcast('dead-letter', entry);
  });
  await startConsumer();
  const server = app.listen(PORT, () => log.info('listening', { port: PORT }));

  const shutdown = async () => {
    clearInterval(keepAlive);
    for (const client of subscribers) client.end();
    server.close();
    await dlq.stop();
    await kafkaAdmin.stop();
    await consumer.disconnect();
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.error('failed to start', { err });
  process.exit(1);
});
