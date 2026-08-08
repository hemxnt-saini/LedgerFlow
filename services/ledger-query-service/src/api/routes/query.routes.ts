import { Router } from 'express';
import { config } from '../../config';
import * as query from '../../services/query.service';
import { asyncRoute } from '../async-route';
import { clampLimit } from '../validation';

export const queryRoutes = Router();

queryRoutes.get(
  '/accounts/:id/balance',
  asyncRoute(async (req, res) => {
    const balance = await query.getBalance(req.params.id);
    if (!balance) {
      // Either the account does not exist, or its event has not been projected
      // yet - eventual consistency, not an error on the write side.
      res.status(404).json({ error: 'ACCOUNT_NOT_IN_READ_MODEL' });
      return;
    }
    res.json(balance);
  }),
);

/** All balances in one call, so a dashboard does not need N round trips. */
queryRoutes.get(
  '/balances',
  asyncRoute(async (req, res) => {
    const ids = String(req.query.ids ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, config.limits.bulkBalanceIds);
    res.json(await query.getBalances(ids));
  }),
);

queryRoutes.get(
  '/accounts/:id/transactions',
  asyncRoute(async (req, res) => {
    const limit = clampLimit(req.query.limit, 50, config.limits.transactionsPageSize);
    res.json(await query.getTransactions(req.params.id, limit));
  }),
);

/**
 * Totals come from counters the projection maintains, not from scanning
 * history - the read side answers in O(1) because the write path already did
 * the arithmetic.
 */
queryRoutes.get(
  '/accounts/:id/stats',
  asyncRoute(async (req, res) => {
    res.json(await query.getStats(req.params.id));
  }),
);

/** The global "John paid Alice" ticker. */
queryRoutes.get(
  '/activity',
  asyncRoute(async (req, res) => {
    const limit = clampLimit(req.query.limit, 50, config.limits.feedPageSize);
    res.json(await query.getActivity(limit));
  }),
);

/** Measured stage latencies for the pipeline monitor. */
queryRoutes.get(
  '/pipeline',
  asyncRoute(async (req, res) => {
    const limit = clampLimit(req.query.limit, 50, config.limits.feedPageSize);
    res.json(await query.getPipelineTraces(limit));
  }),
);
