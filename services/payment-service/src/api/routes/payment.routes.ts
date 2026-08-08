import { Router } from 'express';
import { config } from '../../config';
import * as paymentService from '../../services/payment.service';
import { asyncRoute } from '../async-route';
import {
  clampLimit,
  isUuid,
  parseIdempotencyKey,
  parseNote,
  parseSimulateMode,
  parseTransfer,
  requireUuid,
} from '../validation';
import { badRequest } from '../../lib/http-error';

export const paymentRoutes = Router();

/**
 * Leg 1 of the saga. Returns 201 with status PROCESSING - the money has left
 * the sender and is held in clearing, but the payment is not finished.
 */
paymentRoutes.post(
  '/payments',
  asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const transfer = parseTransfer(body);
    const note = parseNote(body.note);
    const simulateMode = parseSimulateMode(body.simulate, body.simulateFailure);
    const suppliedKey = parseIdempotencyKey(req.header('Idempotency-Key'));

    const result = await paymentService.initiatePayment({
      ...transfer,
      note,
      simulateMode,
      suppliedKey,
    });

    // Echoed so a client that sent no key can see the one derived for it.
    res.set('Idempotency-Key', result.idempotencyKey);
    if (result.replayed) {
      res.status(200).set('Idempotent-Replay', 'true').json(result.payment);
      return;
    }
    res.status(201).json(result.payment);
  }),
);

paymentRoutes.get(
  '/payments',
  asyncRoute(async (req, res) => {
    const accountId = req.query.accountId ? String(req.query.accountId) : null;
    if (accountId && !isUuid(accountId)) throw badRequest('INVALID_ACCOUNT_ID');
    const limit = clampLimit(req.query.limit, 50, config.limits.paymentsPageSize);
    res.json(await paymentService.listPayments(accountId, limit));
  }),
);

/** The payment plus the ledger legs it produced - its audit trail. */
paymentRoutes.get(
  '/payments/:id',
  asyncRoute(async (req, res) => {
    const id = requireUuid(req.params.id, 'INVALID_PAYMENT_ID');
    res.json(await paymentService.getPaymentWithLedger(id));
  }),
);

/** Manual compensation. Only stranded money can be refunded. */
paymentRoutes.post(
  '/payments/:id/refund',
  asyncRoute(async (req, res) => {
    const id = requireUuid(req.params.id, 'INVALID_PAYMENT_ID');
    res.json(await paymentService.refundPayment(id));
  }),
);
