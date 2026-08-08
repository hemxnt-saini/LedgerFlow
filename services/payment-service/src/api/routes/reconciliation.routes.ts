import { Router } from 'express';
import { config } from '../../config';
import * as reconciliationService from '../../services/reconciliation.service';
import { asyncRoute } from '../async-route';
import { clampLimit } from '../validation';

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
