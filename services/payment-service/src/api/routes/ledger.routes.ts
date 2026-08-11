import { Router } from 'express';
import * as ledgerService from '../../services/ledger.service';
import { asyncRoute } from '../async-route';
import { clampLimit, requireUuid } from '../validation';

export const ledgerRoutes = Router();

/** Debit column, credit column, and the difference between them. */
ledgerRoutes.get(
  '/ledger/trial-balance',
  asyncRoute(async (_req, res) => {
    res.json(await ledgerService.getTrialBalance());
  }),
);

/** The general journal. `accountId` narrows it to entries touching one account. */
ledgerRoutes.get(
  '/ledger/journal',
  asyncRoute(async (req, res) => {
    const raw = req.query.accountId;
    const accountId = raw === undefined || raw === '' ? null : requireUuid(raw, 'INVALID_ACCOUNT_ID');
    res.json(await ledgerService.getJournal(clampLimit(req.query.limit, 50, 200), accountId));
  }),
);

/** One account's lines with a running balance. */
ledgerRoutes.get(
  '/ledger/accounts/:id',
  asyncRoute(async (req, res) => {
    const id = requireUuid(req.params.id, 'INVALID_ACCOUNT_ID');
    res.json(await ledgerService.getStatement(id, clampLimit(req.query.limit, 100, 500)));
  }),
);
