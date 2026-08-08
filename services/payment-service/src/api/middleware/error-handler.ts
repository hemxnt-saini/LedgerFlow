import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../../lib/http-error';
import { currentCorrelationId, log } from '../../lib/logger';

/** A JSON API should answer an unknown path in JSON, not Express' HTML page. */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: 'NOT_FOUND' });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.code });
    return;
  }

  // express.json() rejects a malformed body with status already set to 400;
  // without this it would surface as a misleading 500.
  const status = (err as { status?: number }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: 'INVALID_REQUEST_BODY' });
    return;
  }

  log.error('unhandled error', { err });
  // The correlation id goes back with the failure so the caller can quote one
  // string and have the whole request found in the logs.
  res.status(500).json({ error: 'INTERNAL_ERROR', correlationId: currentCorrelationId() });
}
