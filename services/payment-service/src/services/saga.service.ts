import type { PoolClient } from 'pg';
import { config } from '../config';
import {
  MAX_SETTLE_ATTEMPTS,
  backoffMs,
  canCompensate,
  canSettle,
  isExhausted,
  moveFunds,
  shouldSimulateFailure,
  type PaymentStatus,
} from '../domain/payment';
import { toEventBody, type PaymentRow } from '../models/payment.model';
import * as accounts from '../repositories/account.repository';
import * as ledger from '../repositories/ledger.repository';
import * as outbox from '../repositories/outbox.repository';
import * as payments from '../repositories/payment.repository';

const { clearingId } = config.systemAccounts;

/**
 * Leg 2 of the saga: move the held funds from clearing to the receiver.
 *
 * Runs in its own transaction, some time after leg 1 - that separation is the
 * entire reason a payment can get stuck, and the reason a compensating action
 * has to exist at all.
 */
export async function settle(
  client: PoolClient,
  row: PaymentRow,
): Promise<PaymentStatus> {
  if (!canSettle(row.status)) return row.status;

  /** Out of retries: the money stays in clearing, owed back to the sender. */
  const strand = async (reason: string): Promise<PaymentStatus> => {
    const updatedAt = await payments.markStranded(
      client,
      row.id,
      reason,
      row.attempts + 1,
      config.saga.compensateDelayMs,
    );
    await outbox.enqueue(client, 'payment.stuck', {
      ...toEventBody(row, updatedAt),
      failureReason: reason,
      attempts: row.attempts + 1,
    });
    return 'AWAITING_REFUND';
  };

  /**
   * A failure is not automatically fatal. Most things that break between two
   * services break briefly, so try again with a backoff and only give the
   * money back once the attempts are used up. Compensating on the first
   * hiccup would unwind perfectly good payments.
   */
  const retryOrStrand = async (reason: string): Promise<PaymentStatus> => {
    const attempts = row.attempts + 1;
    if (isExhausted(attempts)) return strand(reason);

    const delay = backoffMs(attempts, { jitter: Math.random() });
    const updatedAt = await payments.scheduleRetry(client, row.id, attempts, reason, delay);
    await outbox.enqueue(client, 'payment.settlement_retrying', {
      ...toEventBody(row, updatedAt),
      failureReason: reason,
      attempts,
      maxAttempts: MAX_SETTLE_ATTEMPTS,
      retryInMs: delay,
    });
    return 'PROCESSING';
  };

  if (shouldSimulateFailure(row.simulate_mode, row.attempts)) {
    return retryOrStrand('SETTLEMENT_FAILED_SIMULATED');
  }

  const locked = await accounts.lockMany(client, [clearingId, row.to_account_id]);
  const clearing = locked.get(clearingId);
  const receiver = locked.get(row.to_account_id);
  if (!clearing || !receiver) return retryOrStrand('RECEIVER_UNAVAILABLE');

  const move = moveFunds(clearing, receiver, row.amount_cents);
  if (!move.ok) return retryOrStrand(move.failureReason);

  await accounts.updateBalance(client, clearing.id, move.fromBalanceCents);
  await accounts.updateBalance(client, receiver.id, move.toBalanceCents);
  await ledger.postJournal(client, row.id, 'SETTLE', move.entries);

  const updatedAt = await payments.markCompleted(client, row.id, row.attempts + 1);
  await outbox.enqueue(client, 'payment.completed', {
    ...toEventBody(row, updatedAt),
    attempts: row.attempts + 1,
  });
  return 'COMPLETED';
}

/**
 * The compensating action: return stranded funds from clearing to the sender.
 *
 * Shared by the automatic worker, the manual refund endpoint and a rejected
 * review, so all three take exactly the same path and cannot drift apart.
 */
export async function compensate(
  client: PoolClient,
  row: PaymentRow,
  reason?: string,
): Promise<PaymentStatus> {
  if (!canCompensate(row.status)) return row.status;

  const locked = await accounts.lockMany(client, [clearingId, row.from_account_id]);
  const clearing = locked.get(clearingId)!;
  const sender = locked.get(row.from_account_id)!;

  const move = moveFunds(clearing, sender, row.amount_cents);
  if (!move.ok) {
    // Clearing not holding the money means the ledger has been tampered with.
    // Refuse loudly rather than invent a balance.
    throw new Error(`cannot compensate ${row.id}: clearing account ${move.failureReason}`);
  }

  await accounts.updateBalance(client, clearing.id, move.fromBalanceCents);
  await accounts.updateBalance(client, sender.id, move.toBalanceCents);
  await ledger.postJournal(client, row.id, 'COMPENSATE', move.entries);

  const updatedAt = await payments.markRefunded(client, row.id, reason);
  await outbox.enqueue(client, 'payment.refunded', {
    ...toEventBody(row, updatedAt),
    ...(reason ? { failureReason: reason } : {}),
  });
  return 'REFUNDED';
}
