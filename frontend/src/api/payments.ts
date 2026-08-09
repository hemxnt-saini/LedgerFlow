import { WRITE_URL } from '../lib/config';
import type { Payment, PaymentWithLedger, SimulateMode } from '../types/api';
import { jsonHeaders, request } from './client';

export interface SendPaymentInput {
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  note?: string;
  simulate?: SimulateMode;
}

/**
 * Leg 1 of the saga. Returns as soon as the money is held in clearing - the
 * payment comes back PROCESSING, not finished.
 *
 * The idempotency key is generated here, once per attempt. The user never sees
 * or types one, and it is stable across retries of this attempt - which is the
 * whole trick. A key minted per HTTP request would change on every retry and
 * protect nobody.
 */
export const sendPayment = (input: SendPaymentInput) =>
  request<Payment>(`${WRITE_URL}/payments`, {
    method: 'POST',
    headers: { ...jsonHeaders, 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      amountCents: input.amountCents,
      note: input.note || undefined,
      simulate: input.simulate && input.simulate !== 'NONE' ? input.simulate : undefined,
    }),
  });

/** The payment plus every ledger leg it produced - its audit trail. */
export const getPayment = (id: string) =>
  request<PaymentWithLedger>(`${WRITE_URL}/payments/${id}`);

/** Manual compensation. Only stranded money can be refunded. */
export const refundPayment = (id: string) =>
  request<Payment>(`${WRITE_URL}/payments/${id}/refund`, { method: 'POST' });
