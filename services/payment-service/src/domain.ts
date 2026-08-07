/**
 * Pure domain logic for the payment service.
 *
 * A payment is a two-step saga, not a single transfer:
 *
 *     PROCESSING   sender  -> CLEARING   (authorise leg, one DB transaction)
 *        |         ...a real gap: separate transaction, separate worker...
 *        +-------> CLEARING -> receiver  (settle leg, second DB transaction)
 *                    = COMPLETED
 *        |
 *        +-------> settle failed = AWAITING_REFUND (money sits in clearing)
 *                    compensate: CLEARING -> sender = REFUNDED
 *
 * Money is never in nobody's hands: between the two legs it belongs to the
 * clearing account, so the double-entry ledger balances at every instant even
 * though the payment is only half done. That is what a suspense/clearing
 * account is for, and it is why a "stuck" payment is a recoverable state
 * rather than lost money.
 *
 * Deliberately framework-free - zero imports of express/pg/ioredis/kafkajs.
 * (node:crypto is the standard library, and maps onto java.security
 * .MessageDigest.) Every function here is pure, so the same rules could be
 * lifted into a Java/Axon aggregate untouched.
 */
import { createHash } from 'node:crypto';

export type PaymentStatus =
  /** Sender debited, funds held in the clearing account. */
  | 'PROCESSING'
  /** Receiver credited. Terminal. */
  | 'COMPLETED'
  /** Rejected before any money moved. Terminal. */
  | 'FAILED'
  /** Settlement failed; funds are stranded in clearing, owed back to sender. */
  | 'AWAITING_REFUND'
  /** Stranded funds returned to the sender. Terminal. */
  | 'REFUNDED';

export type Direction = 'DEBIT' | 'CREDIT';

export type FailureReason =
  | 'INVALID_AMOUNT'
  | 'SAME_ACCOUNT'
  | 'INSUFFICIENT_FUNDS';

export interface Account {
  id: string;
  balanceCents: number;
}

export interface LedgerEntry {
  accountId: string;
  direction: Direction;
  amountCents: number;
}

/** Double-entry: every leg is exactly one debit and one credit. */
export type EntryPair = [LedgerEntry, LedgerEntry];

export interface AppliedMove {
  ok: true;
  fromBalanceCents: number;
  toBalanceCents: number;
  entries: EntryPair;
}

export type MoveResult = AppliedMove | { ok: false; failureReason: FailureReason };

/** Money is integer cents. Floats and non-positive amounts are never valid. */
export function isValidAmount(amountCents: unknown): amountCents is number {
  return (
    typeof amountCents === 'number' &&
    Number.isSafeInteger(amountCents) &&
    amountCents > 0
  );
}

/**
 * The single money primitive. Every leg of the saga is one of these:
 *
 *   authorise   moveFunds(sender,   clearing)
 *   settle      moveFunds(clearing, receiver)
 *   compensate  moveFunds(clearing, sender)
 *
 * One function, so there is exactly one place where a balance can change and
 * exactly one definition of "you cannot spend what you do not have".
 */
export function moveFunds(
  from: Account,
  to: Account,
  amountCents: number,
): MoveResult {
  if (!isValidAmount(amountCents)) {
    return { ok: false, failureReason: 'INVALID_AMOUNT' };
  }
  if (from.id === to.id) {
    return { ok: false, failureReason: 'SAME_ACCOUNT' };
  }
  if (from.balanceCents < amountCents) {
    return { ok: false, failureReason: 'INSUFFICIENT_FUNDS' };
  }
  return {
    ok: true,
    fromBalanceCents: from.balanceCents - amountCents,
    toBalanceCents: to.balanceCents + amountCents,
    entries: [
      { accountId: from.id, direction: 'DEBIT', amountCents },
      { accountId: to.id, direction: 'CREDIT', amountCents },
    ],
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Only a half-finished payment can be settled. */
export const canSettle = (status: PaymentStatus): boolean =>
  status === 'PROCESSING';

/**
 * Refunds exist for exactly one situation: the sender's money left, the
 * receiver never got it, and it is sitting in clearing. A COMPLETED payment
 * is not refundable - the money arrived, so there is nothing to recover.
 */
export const canRefund = (status: PaymentStatus): boolean =>
  status === 'AWAITING_REFUND';

export const isTerminal = (status: PaymentStatus): boolean =>
  status === 'COMPLETED' || status === 'FAILED' || status === 'REFUNDED';

/** Every legal move in the state machine. Anything else is a bug. */
const TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  PROCESSING: ['COMPLETED', 'AWAITING_REFUND'],
  AWAITING_REFUND: ['REFUNDED'],
  COMPLETED: [],
  FAILED: [],
  REFUNDED: [],
};

export const canTransition = (from: PaymentStatus, to: PaymentStatus): boolean =>
  TRANSITIONS[from].includes(to);

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

/**
 * How many times settlement is attempted before the payment is given up on
 * and the money returned. Compensating on the first hiccup would unwind
 * perfectly good payments over a momentary blip; never compensating would
 * strand money forever. Both are wrong, so the saga does a bounded number of
 * attempts and then gives the money back.
 */
export const MAX_SETTLE_ATTEMPTS = Number(process.env.MAX_SETTLE_ATTEMPTS ?? 3);

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /**
   * 0..1, supplied by the caller rather than generated here so this stays a
   * pure function. In production it is Math.random(); in tests it is fixed.
   * Without it, every worker in a fleet retries in lockstep and hammers a
   * struggling dependency in synchronised waves.
   */
  jitter?: number;
}

/** Exponential backoff with full jitter, capped. Attempt 1 is the first retry. */
export function backoffMs(attempt: number, options: BackoffOptions = {}): number {
  const { baseMs = 500, maxMs = 30_000, jitter = 0 } = options;
  if (attempt < 1) return 0;
  const exponential = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
  // Full jitter: anywhere in [half the delay, the full delay]. Keeps the
  // growth curve while spreading the herd.
  const spread = exponential / 2;
  return Math.round(exponential - spread + spread * Math.min(Math.max(jitter, 0), 1));
}

/** True once settlement has failed enough times to stop trying. */
export const isExhausted = (attempts: number): boolean =>
  attempts >= MAX_SETTLE_ATTEMPTS;

/** How settlement is made to fail on purpose, for demonstrating the saga. */
export type SimulateMode = 'NONE' | 'TRANSIENT' | 'PERMANENT';

/**
 * A transient fault heals: it fails while there are still retries to burn and
 * succeeds on the last one, so the payment completes without ever needing to
 * be refunded. A permanent fault never heals and ends in compensation.
 */
export function shouldSimulateFailure(mode: SimulateMode, attempts: number): boolean {
  if (mode === 'PERMANENT') return true;
  if (mode === 'TRANSIENT') return attempts < MAX_SETTLE_ATTEMPTS - 1;
  return false;
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * A stable hash of everything that makes a payment request what it is.
 *
 * Two jobs: it is the auto-derived key when a client sends none, and it is
 * stored alongside a cached response so that reusing one key for a *different*
 * request can be rejected instead of silently returning the wrong payment.
 */
export function requestFingerprint(
  fromAccountId: string,
  toAccountId: string,
  amountCents: number,
  note = '',
): string {
  // JSON-encoded rather than joined with a separator, so no combination of
  // field values can fingerprint the same as a different combination.
  return createHash('sha256')
    .update(JSON.stringify([fromAccountId, toAccountId, amountCents, note]))
    .digest('hex');
}

/**
 * The key used when the caller supplies no `Idempotency-Key` header.
 *
 * Deliberately content-derived, not random: a random key would be different
 * on every retry and would protect nobody. Because it is only as unique as
 * the request itself, it is cached for a short window only - it is a
 * double-submit guard, not a permanent payment identity. A client that
 * genuinely needs to send the same amount to the same payee twice in quick
 * succession supplies its own key.
 */
export const DERIVED_KEY_PREFIX = 'auto:';

export function deriveIdempotencyKey(
  fromAccountId: string,
  toAccountId: string,
  amountCents: number,
  note = '',
): string {
  return (
    DERIVED_KEY_PREFIX +
    requestFingerprint(fromAccountId, toAccountId, amountCents, note).slice(0, 32)
  );
}

export const isDerivedKey = (key: string) => key.startsWith(DERIVED_KEY_PREFIX);
