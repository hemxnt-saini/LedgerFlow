import { Router } from 'express';
import * as accountService from '../../services/account.service';
import { asyncRoute } from '../async-route';
import { parseAccountName, parseOpeningBalance, requireUuid } from '../validation';

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
