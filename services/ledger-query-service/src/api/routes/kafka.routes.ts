import { Router } from 'express';
import { config } from '../../config';
import type { ConsumerControls, KafkaAdmin } from '../../services/kafka-admin.service';
import * as readModel from '../../repositories/read-model.repository';
import { subscriberCount } from '../../services/stream.service';
import { asyncRoute } from '../async-route';

/**
 * The Kafka control room's backend. Everything reported here comes from the
 * broker's own admin protocol - partitions, log watermarks, committed offsets
 * - rather than being a number this service invents.
 */
export function createKafkaRoutes(admin: KafkaAdmin, controls: ConsumerControls): Router {
  const router = Router();

  router.get(
    '/kafka/overview',
    asyncRoute(async (_req, res) => {
      const overview = await admin.overview([
        config.kafka.groupId,
        config.kafka.dlqGroupId,
      ]);
      res.json({
        ...overview,
        mainTopic: config.kafka.topic,
        dlqTopic: config.kafka.dlqTopic,
        consumerPaused: controls.isPaused(),
        subscribers: subscriberCount(),
      });
    }),
  );

  /**
   * Pause consumption. The producer keeps writing, the log keeps growing, lag
   * climbs - and nothing is lost. Resume and it drains.
   */
  router.post(
    '/kafka/consumer/pause',
    asyncRoute(async (_req, res) => {
      controls.pause();
      res.json({ paused: true });
    }),
  );

  router.post(
    '/kafka/consumer/resume',
    asyncRoute(async (_req, res) => {
      controls.resume();
      res.json({ paused: false });
    }),
  );

  /**
   * Throw the read model away and rebuild it from the log. It comes back
   * identical, because the log is the source of truth and Redis is a cache
   * of it.
   */
  router.post(
    '/kafka/consumer/rebuild',
    asyncRoute(async (_req, res) => {
      const cleared = await readModel.clearProjection();
      controls.rewind(
        Array.from({ length: config.kafka.partitions }, (_, index) => index),
      );
      res.json({ cleared, rewoundPartitions: config.kafka.partitions });
    }),
  );

  return router;
}
