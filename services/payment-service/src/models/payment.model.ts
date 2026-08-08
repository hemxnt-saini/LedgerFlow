import { MAX_SETTLE_ATTEMPTS, type PaymentStatus, type SimulateMode } from '../domain/payment';

export interface PaymentRow {
  id: string;
  from_account_id: string;
  to_account_id: string;
  amount_cents: number;
  note: string | null;
  status: PaymentStatus;
  failure_reason: string | null;
  simulate_mode: SimulateMode;
  attempts: number;
  next_attempt_at: Date;
  correlation_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PaymentDto {
  id: string;
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  note: string | null;
  status: PaymentStatus;
  failureReason: string | null;
  simulateMode: SimulateMode;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const toPaymentDto = (row: PaymentRow): PaymentDto => ({
  id: row.id,
  fromAccountId: row.from_account_id,
  toAccountId: row.to_account_id,
  amountCents: row.amount_cents,
  note: row.note,
  status: row.status,
  failureReason: row.failure_reason,
  simulateMode: row.simulate_mode,
  attempts: row.attempts,
  // Sent alongside the count so a client can render "attempt 2 of 3" without
  // hardcoding the policy.
  maxAttempts: MAX_SETTLE_ATTEMPTS,
  nextAttemptAt: row.next_attempt_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** The event body every payment lifecycle event shares. */
export const toEventBody = (row: PaymentRow, occurredAt: Date) => ({
  paymentId: row.id,
  fromAccountId: row.from_account_id,
  toAccountId: row.to_account_id,
  amountCents: row.amount_cents,
  note: row.note,
  occurredAt: occurredAt.toISOString(),
});
