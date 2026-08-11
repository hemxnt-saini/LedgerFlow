import { Router } from 'express';
import * as accountService from '../../services/account.service';
import { asyncRoute } from '../async-route';
import {
  parseAccountName,
  parseLimits,
  parseOpeningBalance,
  requireUuid,
} from '../validation';

export const accountRoutes = Router();

accountRoutes.post(
  '/accounts',
  asyncRoute(async (req, res) => {
    const name = parseAccountName(req.body?.name);
    const openingBalance = parseOpeningBalance(req.body?.initialBalanceCents);
    res.status(201).json(await accountService.createAccount(name, openingBalance));
  }),
);

accountRoutes.get(
  '/accounts',
  asyncRoute(async (req, res) => {
    res.json(await accountService.listAccounts(req.query.includeSystem === 'true'));
  }),
);

accountRoutes.get(
  '/accounts/:id',
  asyncRoute(async (req, res) => {
    const id = requireUuid(req.params.id, 'INVALID_ACCOUNT_ID');
    res.json(await accountService.getAccount(id));
  }),
);

/** Spending controls and how much of today's allowance is gone. */
accountRoutes.get(
  '/accounts/:id/limits',
  asyncRoute(async (req, res) => {
    const id = requireUuid(req.params.id, 'INVALID_ACCOUNT_ID');
    res.json(await accountService.getLimits(id));
  }),
);

/**
 * Change an account's spending controls.
 *
 * A real product would put this behind an operator role. Here it is open,
 * which is also what makes the limits demonstrable - drop the daily cap to
 * $100 and the next payment shows the control refusing.
 */
accountRoutes.put(
  '/accounts/:id/limits',
  asyncRoute(async (req, res) => {
    const id = requireUuid(req.params.id, 'INVALID_ACCOUNT_ID');
    res.json(await accountService.setLimits(id, parseLimits(req.body ?? {})));
  }),
);
