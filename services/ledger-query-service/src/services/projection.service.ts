import { config } from '../config';
import { applyEvent, isKnownEventType, type PaymentEvent } from '../domain/projector';
import { consumer, kafka } from '../lib/kafka';
import { log, newCorrelationId, withContext } from '../lib/logger';
import { redis } from '../lib/redis';
import * as readModel from '../repositories/read-model.repository';
import type { DeadLetterQueue, DeadLetterReason } from './dlq.service';
import { broadcast } from './stream.service';

/**
 * Counters worth watching. `duplicatesSkipped` climbing is not a fault - it is
 * at-least-once delivery being caught by the dedup set, which is exactly what
 * should happen. It climbing *fast* means something is re-publishing.
 *
 * Exposed on /health, because a 200 there only proves Express is alive; these
 * prove the consumer is actually consuming.
 */
export const counters = { applied: 0, duplicatesSkipped: 0, deadLettered: 0 };

/**
 * Real timings for every event, not invented lifecycle steps: when the write
 * side committed, when the outbox actually published, when this consumer got
 * it, and when the read model reflected it. The gaps between those four
 * numbers are exactly the eventual-consistency window the UI warns about.
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

export async function startProjection(dlq: DeadLetterQueue): Promise<void> {
  // On a cold start the read side is usually up before the first payment is
  // ever made, so the topic does not exist yet and subscribe() would fail with
  // UNKNOWN_TOPIC_OR_PARTITION. Creating it here is a no-op if it exists.
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({
    topics: [{ topic: config.kafka.topic, numPartitions: config.kafka.partitions }],
  });
  await admin.disconnect();

  // A stopped consumer is the worst failure this service has: the HTTP side
  // keeps answering 200 while the read model silently freezes. Exiting makes
  // it visible and lets the restart policy recover it.
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    log.error('consumer crashed, exiting to restart', { err: payload.error });
    process.exit(1);
  });

  await consumer.connect();
  await consumer.subscribe({ topic: config.kafka.topic, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) =>
      // The id travelled with the event, so this side's log lines line up with
      // the ones the write side produced for the same payment.
      withContext(
        { correlationId: message.headers?.correlationId?.toString() || newCorrelationId() },
        async () => {
          const receivedAt = Date.now();
          if (!message.value) return;

          const raw = message.value.toString();
          const park = (reason: DeadLetterReason, detail: string) =>
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
            // Park it rather than drop it. Something produced this, and that
            // is a fact worth keeping even when we cannot read it.
            await park('UNPARSEABLE', String(err));
            return;
          }

          // Trust boundary. An event without an id cannot be de-duplicated,
          // and one without a usable timestamp would poison the feed's sort
          // score and the day buckets. Neither is safe to apply to a balance.
          if (
            !event?.eventId ||
            !event?.type ||
            !Number.isFinite(Date.parse(event?.occurredAt))
          ) {
            await park('MALFORMED', 'needs eventId, type and a parseable occurredAt');
            return;
          }

          // Checked before applyEvent so the id is not claimed. Otherwise
          // adding support for the type later and replaying it would be a
          // permanent no-op.
          if (!isKnownEventType(event.type)) {
            await park('UNKNOWN_TYPE', `no projection for ${event.type}`);
            return;
          }

          // Throwing here makes kafkajs retry the message rather than commit
          // the offset, so a Redis blip does not silently lose an event.
          const applied = await applyEvent(redis, event);
          if (!applied) {
            counters.duplicatesSkipped += 1;
            log.debug('skipped duplicate', { type: event.type, eventId: event.eventId });
            return;
          }
          counters.applied += 1;

          // The read model is already updated and the offset is about to
          // commit. Telemetry and fan-out are best-effort from here: a failure
          // in either must not throw, because kafkajs treats an error out of
          // eachMessage as fatal and stops the consumer for good.
          try {
            const header = Number(message.headers?.publishedAt?.toString());
            const publishedAt = Number.isFinite(header) ? header : receivedAt;
            const trace = traceOf(event, publishedAt, receivedAt, Date.now(), {
              partition,
              offset: message.offset,
            });
            await readModel.appendPipelineTrace(trace);
            log.info('projected event', {
              type: event.type,
              paymentId: 'paymentId' in event ? event.paymentId : undefined,
              totalMs: trace.stages.totalMs,
            });
            // The whole point of the read side: the moment state changes,
            // every open tab hears about it without polling.
            broadcast('payment-event', { event, trace });
          } catch (err) {
            log.error('event applied, telemetry failed', { err });
          }
        },
      ),
  });

  log.info('consuming from the beginning', { topic: config.kafka.topic });
}
