import type { NextFunction, Request, Response } from 'express';

/**
 * The frontend is served from a different origin (nginx on :8080), so the
 * browser needs permission to call this service at all.
 *
 * Expose-Headers matters more than it looks: without it `fetch()` cannot read
 * `Idempotent-Replay` or the echoed `Idempotency-Key`, because CORS only
 * surfaces a handful of simple response headers by default. The wallet's
 * "this was replayed, no money moved" message depends on it.
 */
export function cors(req: Request, res: Response, next: NextFunction): void {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key, X-Correlation-Id');
  // Cache the preflight so a burst of writes does not double its request count.
  res.set('Access-Control-Max-Age', '86400');
  // PUT and DELETE were missing, so a browser preflight for
  // PUT /accounts/:id/limits or DELETE /dlq/:id was refused. It went unnoticed
  // because the tests call those from Node, where CORS does not apply.
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.set(
    'Access-Control-Expose-Headers',
    'Idempotent-Replay, Idempotency-Key, X-Correlation-Id',
  );
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}
