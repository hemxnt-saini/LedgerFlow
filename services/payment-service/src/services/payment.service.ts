import { config } from '../config';
import { pool } from '../db/pool';
import { withTransaction } from '../db/transaction';
import { checkLimits } from '../domain/limits';
import {
  canRefund,
  deriveIdempotencyKey,
  isUnderReview,
  moveFunds,
  requestFingerprint,
  type PaymentStatus,
  type SimulateMode,
} from '../domain/payment';
import { assessRisk } from '../domain/risk';
import { HttpError, conflict, notFound } from '../lib/http-error';
import { currentCorrelationId } from '../lib/logger';
import { toLedgerEntryDto, type LedgerEntryDto } from '../models/ledger.model';
import { toEventBody, toPaymentDto, type PaymentDto } from '../models/payment.model';
import * as accounts from '../repositories/account.repository';
import * as ledger from '../repositories/ledger.repository';
import * as outbox from '../repositories/outbox.repository';
import * as payments from '../repositories/payment.repository';
import * as idempotency from './idempotency.service';
import { compensate } from './saga.service';

const { clearingId } = config.systemAccounts;

export interface InitiatePaymentInput {
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  note: string | null;
  simulateMode: SimulateMode;
  /** Null when the caller sent no Idempotency-Key header. */
  suppliedKey: string | null;
}

export interface InitiatePaymentResult {
  payment: PaymentDto;
  /** The key actually used - echoed back so a client can see a derived one. */
  idempotencyKey: string;
  /** True when this request was answered from the cache, not executed. */
  replayed: boolean;
}

/**
 * Leg 1 of the saga: take the money off the sender and hold it in clearing.
 *
 * Returns as soon as the funds are held. The payment is PROCESSING, not
 * finished - the settlement worker moves it on to the receiver a moment later.
 */
export async function initiatePayment(
  input: InitiatePaymentInput,
): Promise<InitiatePaymentResult> {
  const { fromAccountId, toAccountId, amountCents, note, simulateMode, suppliedKey } =
    input;

  // Every payment gets a key whether the caller sent one or not. No key at all
  // would mean no protection at all, and a randomly generated one would differ
  // on every retry and protect nobody - so an absent key is derived from the
  // request content instead.
  const idempotencyKey =
    suppliedKey ?? deriveIdempotencyKey(fromAccountId, toAccountId, amountCents, note ?? '');
  const fingerprint = requestFingerprint(
    fromAccountId,
    toAccountId,
    amountCents,
    note ?? '',
  );

  const replay = await idempotency.findReplay(idempotencyKey, fingerprint);
  if (replay) return { payment: replay, idempotencyKey, replayed: true };

  let payment: PaymentDto;
  try {
    payment = await withTransaction(async (client) => {
      const locked = await accounts.lockMany(client, [
        fromAccountId,
        clearingId,
        toAccountId,
      ]);
      const sender = locked.get(fromAccountId);
      const clearing = locked.get(clearingId);
      const receiver = locked.get(toAccountId);
      if (!sender || !receiver) throw notFound('ACCOUNT_NOT_FOUND');
      if (!clearing) throw new HttpError(500, 'CLEARING_ACCOUNT_MISSING');

      // Spending controls, checked with the sender's row already locked.
      //
      // That ordering is the whole guarantee. Concurrent payments from one
      // account queue on that lock, so each one reads a spend total that
      // already includes every payment committed before it - twenty
      // simultaneous requests against a daily cap let exactly the right
      // number through instead of all of them slipping past a stale read.
      const limits = await accounts.findLimits(client, sender.id);
      if (!limits) throw notFound('ACCOUNT_NOT_FOUND');
      const spend = await accounts.spendSoFar(
        client,
        sender.id,
        config.controls.velocityWindowSeconds,
      );
      const decision = checkLimits(amountCents, limits, spend);

      // A limit breach is a decline, not an error: recorded as a FAILED
      // payment the same way insufficient funds is, so it shows up in history
      // with a reason rather than vanishing into a 4xx.
      const authorise = decision.allowed
        ? moveFunds(sender, clearing, amountCents)
        : ({ ok: false, failureReason: decision.breach } as const);

      // Risk screening, after the limits and only if the money can actually
      // move. A hold is not a refusal - the funds are secured in clearing
      // first and a person then decides whether to release them. Reviewing
      // before securing would let the balance be spent elsewhere while
      // someone deliberates.
      const risk = authorise.ok
        ? assessRisk(
            {
              amountCents,
              payeeIsNew: !(await payments.hasPaidBefore(client, sender.id, receiver.id)),
              recentCount: spend.recentCount,
            },
            config.risk,
          )
        : { hold: false, flags: [] };

      const status: PaymentStatus = !authorise.ok
        ? 'FAILED'
        : risk.hold
          ? 'HELD_FOR_REVIEW'
          : 'PROCESSING';

      // Balances, the payment row, the ledger entries and the outbox event all
      // commit together - or none of them do.
      const row = await payments.insert(client, {
        fromAccountId: sender.id,
        toAccountId: receiver.id,
        amountCents,
        note,
        status,
        failureReason: authorise.ok ? null : authorise.failureReason,
        // Only a client-supplied key is persisted. A derived key is a content
        // hash, and the UNIQUE constraint would then permanently block the
        // same payer sending the same payee the same amount ever again.
        idempotencyKey: suppliedKey,
        simulateMode,
        holdReasons: risk.flags,
        settleDelayMs: config.saga.settleDelayMs,
        correlationId: currentCorrelationId() ?? null,
      });

      const body = toEventBody(row, row.created_at);

      if (!authorise.ok) {
        await outbox.enqueue(client, 'payment.failed', {
          ...body,
          failureReason: authorise.failureReason,
        });
        return toPaymentDto(row);
      }

      // The authorise leg is identical whether the payment is held or not -
      // the money is in clearing either way. Only what happens next differs.
      await accounts.updateBalance(client, sender.id, authorise.fromBalanceCents);
      await accounts.updateBalance(client, clearing.id, authorise.toBalanceCents);
      await ledger.postJournal(client, row.id, 'AUTHORISE', authorise.entries);

      await outbox.enqueue(
        client,
        risk.hold ? 'payment.held' : 'payment.initiated',
        risk.hold ? { ...body, holdReasons: risk.flags } : body,
      );
      return toPaymentDto(row);
    });
  } catch (err) {
    // Second line of defence: the UNIQUE constraint on idempotency_key.
    // Catches two identical requests racing past the cache together - the
    // loser's INSERT blocks on the index until the winner commits, then raises
    // 23505, so the row below is guaranteed to be visible.
    if (suppliedKey && (err as { code?: string }).code === '23505') {
      const existing = await payments.findByIdempotencyKey(pool, suppliedKey);
      if (existing) {
        return { payment: toPaymentDto(existing), idempotencyKey, replayed: true };
      }
    }
    throw err;
  }

  await idempotency.remember(idempotencyKey, fingerprint, payment);
  return { payment, idempotencyKey, replayed: false };
}

export async function listPayments(
  accountId: string | null,
  limit: number,
): Promise<PaymentDto[]> {
  const rows = await payments.list(pool, accountId, limit);
  return rows.map(toPaymentDto);
}

/**
 * A payment plus the ledger legs it produced - the audit trail behind the
 * status. A completed payment shows AUTHORISE then SETTLE; a refunded one
 * shows AUTHORISE then COMPENSATE and never a SETTLE.
 */
export async function getPaymentWithLedger(
  id: string,
): Promise<PaymentDto & { ledger: LedgerEntryDto[] }> {
  const row = await payments.findById(pool, id);
  if (!row) throw notFound('PAYMENT_NOT_FOUND');

  const entries = await ledger.findByPaymentId(pool, id);
  return { ...toPaymentDto(row), ledger: entries.map(toLedgerEntryDto) };
}

/** The review queue: payments whose funds are held pending a decision. */
export async function listHeldForReview(limit: number): Promise<PaymentDto[]> {
  const rows = await payments.listHeld(pool, limit);
  return rows.map(toPaymentDto);
}

/**
 * Release held funds.
 *
 * Puts the payment back on the ordinary settlement path rather than settling
 * it here, so there is exactly one route to COMPLETED and the retry, backoff
 * and compensation behaviour is the same as for any other payment.
 */
export async function approvePayment(id: string): Promise<PaymentDto> {
  return withTransaction(async (client) => {
    const row = await payments.findByIdForUpdate(client, id);
    if (!row) throw notFound('PAYMENT_NOT_FOUND');
    if (!isUnderReview(row.status)) throw conflict(`NOT_UNDER_REVIEW_FROM_${row.status}`);

    const updatedAt = await payments.markApproved(client, id);
    await outbox.enqueue(client, 'payment.approved', toEventBody(row, updatedAt));

    const updated = await payments.findById(client, id);
    return toPaymentDto(updated!);
  });
}

/**
 * Refuse held funds: the same compensating action a stranded payment uses, so
 * both paths post an identical COMPENSATE journal and cannot drift apart.
 */
export async function rejectPayment(id: string): Promise<PaymentDto> {
  return withTransaction(async (client) => {
    const row = await payments.findByIdForUpdate(client, id);
    if (!row) throw notFound('PAYMENT_NOT_FOUND');
    if (!isUnderReview(row.status)) throw conflict(`NOT_UNDER_REVIEW_FROM_${row.status}`);

    await compensate(client, row, 'REJECTED_IN_REVIEW');
    const updated = await payments.findById(client, id);
    return toPaymentDto(updated!);
  });
}

/**
 * Manual compensation. The worker does this automatically after a few seconds;
 * this only skips the wait. Only stranded money can be refunded - a completed
 * payment arrived, so there is nothing to recover.
 */
export async function refundPayment(id: string): Promise<PaymentDto> {
  return withTransaction(async (client) => {
    // Lock the row first so two concurrent refunds cannot both see
    // AWAITING_REFUND.
    const original = await payments.findByIdForUpdate(client, id);
    if (!original) throw notFound('PAYMENT_NOT_FOUND');
    if (!canRefund(original.status)) {
      throw conflict(`NOT_REFUNDABLE_FROM_${original.status}`);
    }

    await compensate(client, original);
    const updated = await payments.findById(client, id);
    return toPaymentDto(updated!);
  });
}
