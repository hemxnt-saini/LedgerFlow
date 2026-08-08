import type { NextFunction, Request, Response } from 'express';

/**
 * Express 4 does not catch a rejected promise from a handler, so an async
 * route that throws would hang instead of reaching the error middleware.
 */
export const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);
