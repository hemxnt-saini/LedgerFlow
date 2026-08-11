import { Router } from 'express';
import { config } from '../../config';
import type { DeadLetterQueue } from '../../services/dlq.service';
import { asyncRoute } from '../async-route';
import { clampLimit } from '../validation';

/**
 * Inspecting and replaying parked messages.
 *
 * Replay is safe to repeat: the read model claims each event id before
 * applying it, so putting something back that already worked changes nothing,
 * and putting back something still unprocessable simply parks it again.
 */
export function createDlqRoutes(dlq: DeadLetterQueue): Router {
  const router = Router();

  /**
   * Publish a message the consumer cannot parse, so it can be watched being
   * parked rather than dropped. 404s unless demo endpoints are enabled.
   */
  router.post(
    '/dlq/demo/poison',
    asyncRoute(async (_req, res) => {
      if (!config.demo.enabled) return res.status(404).json({ error: 'NOT_FOUND' });
      res.json(await dlq.poison());
    }),
  );

  router.get(
    '/dlq',
    asyncRoute(async (req, res) => {
      const entries = await dlq.list(
        clampLimit(req.query.limit, 50, config.limits.feedPageSize),
      );
      res.json({
        topic: config.kafka.dlqTopic,
        pending: entries.filter((entry) => !entry.replayedAt).length,
        entries,
      });
    }),
  );

  router.post(
    '/dlq/replay-all',
    asyncRoute(async (_req, res) => {
      const entries = await dlq.list(config.retention.dlqEntries);
      const replayed: string[] = [];
      for (const entry of entries.filter((item) => !item.replayedAt)) {
        const result = await dlq.replay(entry.dlqId);
        if (result) replayed.push(result.dlqId);
      }
      res.json({ replayed: replayed.length, dlqIds: replayed });
    }),
  );

  router.post(
    '/dlq/:dlqId/replay',
    asyncRoute(async (req, res) => {
      const entry = await dlq.replay(req.params.dlqId);
      if (!entry) {
        res.status(404).json({ error: 'DLQ_ENTRY_NOT_FOUND' });
        return;
      }
      res.json(entry);
    }),
  );

  /** Removes it from the browsable list. The parking topic keeps the record. */
  router.delete(
    '/dlq/:dlqId',
    asyncRoute(async (req, res) => {
      const removed = await dlq.discard(req.params.dlqId);
      if (!removed) {
        res.status(404).json({ error: 'DLQ_ENTRY_NOT_FOUND' });
        return;
      }
      res.json({ discarded: req.params.dlqId });
    }),
  );

  return router;
}
