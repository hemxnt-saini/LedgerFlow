import type { NextFunction, Request, Response } from 'express';
import { log, newCorrelationId, withContext } from '../../lib/logger';

/**
 * CORS plus a correlation id for every request. The id is adopted from the
 * caller when present, so a wallet action and the query that follows it share
 * one identifier across both services.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Correlation-Id');
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.set('Access-Control-Expose-Headers', 'X-Correlation-Id');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  const correlationId = req.header('X-Correlation-Id')?.trim() || newCorrelationId();
  res.set('X-Correlation-Id', correlationId);

  // The event stream is long-lived; logging it on finish would be misleading,
  // since "finished" means the browser went away.
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
}
