import type { NextFunction, Request, Response } from 'express';
import { log, newCorrelationId, withContext } from '../../lib/logger';

/**
 * Every request runs inside a correlation id - taken from the caller if they
 * sent one, minted here if not - and it is echoed back so a client can quote
 * it in a bug report.
 *
 * Because the id lives in AsyncLocalStorage, everything logged downstream
 * carries it without being passed it, including work that happens seconds
 * later in a background worker.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const correlationId = req.header('X-Correlation-Id')?.trim() || newCorrelationId();
  res.set('X-Correlation-Id', correlationId);

  const startedAt = Date.now();
  withContext({ correlationId }, () => {
    res.on('finish', () => {
      const fields = {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      };
      if (res.statusCode >= 500) log.error('request failed', fields);
      else log.info('request', fields);
    });
    next();
  });
}
