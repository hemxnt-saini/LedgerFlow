import type { ActivityEntry, PaymentStatus } from '../types/api';

export const STATUS_LABEL: Record<PaymentStatus, string> = {
  PROCESSING: 'Processing',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  AWAITING_REFUND: 'Awaiting refund',
  REFUNDED: 'Refunded',
};

/**
 * Backend error codes are stable machine strings. These are what a person
 * should read instead - a decline is a normal outcome, not a stack trace.
 */
const REASON_LABEL: Record<string, string> = {
  INSUFFICIENT_FUNDS: "You don't have enough for that",
  SAME_ACCOUNT: 'You cannot pay yourself',
  INVALID_AMOUNT: 'That amount is not valid',
  SETTLEMENT_FAILED_SIMULATED: 'Settlement failed (simulated)',
  RECEIVER_UNAVAILABLE: 'The receiver could not be credited',
  IDEMPOTENCY_KEY_REUSED:
    'That idempotency key was already used for a different payment',
  NOT_REFUNDABLE_FROM_COMPLETED: 'This payment arrived - there is nothing to refund',
  AMOUNT_ABOVE_LIMIT: 'That is more than your per-payment limit',
  DAILY_LIMIT_EXCEEDED: "That would take you past today's sending limit",
  VELOCITY_EXCEEDED: 'You are sending too quickly - wait a moment',
  ACCOUNT_NOT_FOUND: 'That account no longer exists',
  NOT_FOUND: 'Not found',
};

export const humanise = (code: string | null | undefined): string =>
  (code ? REASON_LABEL[code] : undefined) ??
  (code ? code.replace(/_/g, ' ').toLowerCase() : 'Something went wrong');

/** One line of the global ticker: "Alice paid Bob $12.50". */
export function activityLine(
  entry: ActivityEntry,
  nameOf: (id: string) => string,
  amount: string,
): string {
  const from = nameOf(entry.fromAccountId);
  const to = nameOf(entry.toAccountId);
  switch (entry.type) {
    case 'payment.initiated':
      return `${from} started paying ${to} ${amount}`;
    case 'payment.completed':
      return `${from} paid ${to} ${amount}`;
    case 'payment.failed':
      return `${from} → ${to} ${amount} declined`;
    case 'payment.stuck':
      return `${from} → ${to} ${amount} stuck, awaiting refund`;
    case 'payment.refunded':
      return `${amount} refunded to ${from}`;
    default:
      return `${entry.type} ${amount}`;
  }
}
