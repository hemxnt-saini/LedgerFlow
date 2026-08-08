import type { NextFunction, Request, Response } from 'express';
import { log } from '../../lib/logger';

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
  log.error('unhandled error', { err });
  res.status(500).json({ error: 'INTERNAL_ERROR' });
}
