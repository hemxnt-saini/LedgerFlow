import { Router } from 'express';
import { config } from '../../config';
import * as reconciliationService from '../../services/reconciliation.service';
import { asyncRoute } from '../async-route';
import { clampLimit } from '../validation';
import { notFound } from '../../lib/http-error';

export const reconciliationRoutes = Router();

/** The latest verdict plus recent history, so drift has a first sighting. */
reconciliationRoutes.get(
  '/reconciliation',
  asyncRoute(async (req, res) => {
    const limit = clampLimit(req.query.limit, 20, config.limits.reconciliationPageSize);
    res.json(await reconciliationService.listRuns(limit));
  }),
);

/** Run the control now rather than waiting for the next scheduled pass. */
reconciliationRoutes.post(
  '/reconciliation/run',
  asyncRoute(async (_req, res) => {
    res.json(await reconciliationService.runReconciliation());
  }),
);

/**
 * Remediation: recompute every cached balance from the journal.
 *
 * Detection and repair are separate operations on purpose. A control that
 * silently fixed what it found would destroy the evidence of how the drift
 * happened, so this is a decision someone makes after reading the findings.
 */
reconciliationRoutes.post(
  '/reconciliation/repair',
  asyncRoute(async (_req, res) => {
    res.json(await reconciliationService.repairBalances());
  }),
);

/**
 * Breaks a balance on purpose so the control can be seen catching it.
 * 404s unless demo endpoints are enabled - see `config.demo`.
 */
reconciliationRoutes.post(
  '/reconciliation/demo/inject-drift',
  asyncRoute(async (req, res) => {
    if (!config.demo.enabled) throw notFound('NOT_FOUND');
    const amount = Number(req.body?.driftCents);
    const driftCents = Number.isSafeInteger(amount) && amount !== 0 ? amount : 5_000;
    res.json(await reconciliationService.injectDrift(driftCents));
  }),
);
