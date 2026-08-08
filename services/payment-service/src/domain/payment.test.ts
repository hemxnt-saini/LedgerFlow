import {
  MAX_SETTLE_ATTEMPTS,
  backoffMs,
  canRefund,
  canSettle,
  canTransition,
  deriveIdempotencyKey,
  isDerivedKey,
  isTerminal,
  isExhausted,
  isValidAmount,
  moveFunds,
  requestFingerprint,
  shouldSimulateFailure,
  type Account,
  type PaymentStatus,
} from './payment';

const account = (id: string, balanceCents: number): Account => ({ id, balanceCents });

const alice = () => account('alice', 10_000);
const bob = () => account('bob', 500);
const clearing = () => account('clearing', 0);

const applied = (result: ReturnType<typeof moveFunds>) => {
  if (!result.ok) throw new Error(`expected a successful move, got ${result.failureReason}`);
  return result;
};

describe('moveFunds', () => {
  it('moves money and writes one debit + one credit', () => {
    expect(moveFunds(alice(), bob(), 2_500)).toEqual({
      ok: true,
      fromBalanceCents: 7_500,
      toBalanceCents: 3_000,
      entries: [
        { accountId: 'alice', direction: 'DEBIT', amountCents: 2_500 },
        { accountId: 'bob', direction: 'CREDIT', amountCents: 2_500 },
      ],
    });
  });

  it('conserves total money', () => {
    const result = applied(moveFunds(alice(), bob(), 2_500));
    expect(result.fromBalanceCents + result.toBalanceCents).toBe(10_500);
  });

  it('refuses to spend money that is not there', () => {
    expect(moveFunds(bob(), alice(), 501)).toEqual({
      ok: false,
      failureReason: 'INSUFFICIENT_FUNDS',
    });
  });

  it('allows spending the exact balance down to zero', () => {
    const result = applied(moveFunds(bob(), alice(), 500));
    expect(result.fromBalanceCents).toBe(0);
    expect(result.toBalanceCents).toBe(10_500);
  });

  it('rejects a self-transfer', () => {
    expect(moveFunds(alice(), alice(), 100)).toEqual({
      ok: false,
      failureReason: 'SAME_ACCOUNT',
    });
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejects amount %p', (amount) => {
    expect(moveFunds(alice(), bob(), amount)).toEqual({
      ok: false,
      failureReason: 'INVALID_AMOUNT',
    });
  });

  it('rejects amounts that are not numbers at all', () => {
    expect(isValidAmount('100')).toBe(false);
    expect(isValidAmount(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
    expect(isValidAmount(1)).toBe(true);
  });
});

// The saga is three applications of moveFunds. These tests walk each path end
// to end and assert the thing that actually matters: the books balance and
// nobody's money vanishes.
describe('the payment saga', () => {
  const AMOUNT = 2_500;

  it('happy path: sender -> clearing -> receiver, clearing left empty', () => {
    const authorise = applied(moveFunds(alice(), clearing(), AMOUNT));
    expect(authorise.fromBalanceCents).toBe(7_500);
    expect(authorise.toBalanceCents).toBe(AMOUNT); // held in clearing

    const settle = applied(
      moveFunds(account('clearing', authorise.toBalanceCents), bob(), AMOUNT),
    );
    expect(settle.fromBalanceCents).toBe(0); // clearing drained
    expect(settle.toBalanceCents).toBe(3_000);

    // Money is conserved across the whole saga.
    expect(authorise.fromBalanceCents + settle.toBalanceCents).toBe(10_500);
  });

  it('mid-saga, the money is in clearing - not lost', () => {
    const authorise = applied(moveFunds(alice(), clearing(), AMOUNT));
    const total = authorise.fromBalanceCents + authorise.toBalanceCents + bob().balanceCents;
    expect(total).toBe(10_500);
  });

  it('every leg writes a balanced debit/credit pair', () => {
    const legs = [
      applied(moveFunds(alice(), clearing(), AMOUNT)),
      applied(moveFunds(account('clearing', AMOUNT), bob(), AMOUNT)),
      applied(moveFunds(account('clearing', AMOUNT), alice(), AMOUNT)),
    ];
    for (const leg of legs) {
      const [debit, credit] = leg.entries;
      expect(debit.direction).toBe('DEBIT');
      expect(credit.direction).toBe('CREDIT');
      expect(debit.amountCents).toBe(credit.amountCents);
    }
  });

  it('compensation returns the sender to exactly where they started', () => {
    const start = alice();
    const authorise = applied(moveFunds(start, clearing(), AMOUNT));
    // Settlement fails, so instead of clearing -> receiver we run
    // clearing -> sender.
    const compensate = applied(
      moveFunds(
        account('clearing', authorise.toBalanceCents),
        account('alice', authorise.fromBalanceCents),
        AMOUNT,
      ),
    );

    expect(compensate.fromBalanceCents).toBe(0); // clearing drained
    expect(compensate.toBalanceCents).toBe(start.balanceCents);
  });

  it('a refunded payment leaves the receiver untouched', () => {
    const receiver = bob();
    applied(moveFunds(alice(), clearing(), AMOUNT));
    applied(moveFunds(account('clearing', AMOUNT), alice(), AMOUNT));
    expect(receiver.balanceCents).toBe(500);
  });

  it('cannot authorise more than the sender has, so nothing enters clearing', () => {
    const result = moveFunds(bob(), clearing(), 999_999);
    expect(result).toEqual({ ok: false, failureReason: 'INSUFFICIENT_FUNDS' });
  });
});

describe('lifecycle', () => {
  it('only a PROCESSING payment can be settled', () => {
    expect(canSettle('PROCESSING')).toBe(true);
    for (const status of ['COMPLETED', 'FAILED', 'AWAITING_REFUND', 'REFUNDED'] as const) {
      expect(canSettle(status)).toBe(false);
    }
  });

  it('only stranded money can be refunded', () => {
    expect(canRefund('AWAITING_REFUND')).toBe(true);
    // A completed payment arrived. There is nothing to recover.
    expect(canRefund('COMPLETED')).toBe(false);
    expect(canRefund('PROCESSING')).toBe(false);
    expect(canRefund('FAILED')).toBe(false);
    expect(canRefund('REFUNDED')).toBe(false);
  });

  it('knows which states are the end of the road', () => {
    expect(isTerminal('COMPLETED')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('REFUNDED')).toBe(true);
    expect(isTerminal('PROCESSING')).toBe(false);
    expect(isTerminal('AWAITING_REFUND')).toBe(false);
  });

  it('allows exactly the legal transitions', () => {
    expect(canTransition('PROCESSING', 'COMPLETED')).toBe(true);
    expect(canTransition('PROCESSING', 'AWAITING_REFUND')).toBe(true);
    expect(canTransition('AWAITING_REFUND', 'REFUNDED')).toBe(true);
  });

  it('refuses everything else, including going backwards', () => {
    const all: PaymentStatus[] = [
      'PROCESSING',
      'COMPLETED',
      'FAILED',
      'AWAITING_REFUND',
      'REFUNDED',
    ];
    const legal = new Set([
      'PROCESSING->COMPLETED',
      'PROCESSING->AWAITING_REFUND',
      'AWAITING_REFUND->REFUNDED',
    ]);
    for (const from of all) {
      for (const to of all) {
        expect(canTransition(from, to)).toBe(legal.has(`${from}->${to}`));
      }
    }
  });

  it('never lets a terminal payment move again', () => {
    for (const status of ['COMPLETED', 'FAILED', 'REFUNDED'] as const) {
      expect(canSettle(status)).toBe(false);
      expect(canRefund(status)).toBe(false);
    }
  });
});

describe('the retry policy', () => {
  it('backs off exponentially', () => {
    const delays = [1, 2, 3, 4].map((attempt) => backoffMs(attempt, { jitter: 1 }));
    expect(delays).toEqual([500, 1_000, 2_000, 4_000]);
  });

  it('never waits longer than the cap', () => {
    expect(backoffMs(50, { jitter: 1 })).toBe(30_000);
    expect(backoffMs(50, { maxMs: 5_000, jitter: 1 })).toBe(5_000);
  });

  it('spreads the herd: jitter moves the delay without changing its scale', () => {
    // Full jitter puts the delay somewhere in [half, full] - so retries from
    // many workers do not land on the dependency at the same instant.
    const none = backoffMs(3, { jitter: 0 });
    const half = backoffMs(3, { jitter: 0.5 });
    const full = backoffMs(3, { jitter: 1 });
    expect(none).toBe(1_000);
    expect(half).toBe(1_500);
    expect(full).toBe(2_000);
  });

  it('clamps a nonsense jitter instead of producing a nonsense delay', () => {
    expect(backoffMs(1, { jitter: -5 })).toBe(250);
    expect(backoffMs(1, { jitter: 99 })).toBe(500);
  });

  it('returns nothing for a zeroth attempt', () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(-1)).toBe(0);
  });

  it('gives up only after the configured number of attempts', () => {
    expect(isExhausted(MAX_SETTLE_ATTEMPTS - 1)).toBe(false);
    expect(isExhausted(MAX_SETTLE_ATTEMPTS)).toBe(true);
    expect(isExhausted(MAX_SETTLE_ATTEMPTS + 1)).toBe(true);
  });
});

describe('simulated faults', () => {
  it('a transient fault heals before the retries run out', () => {
    const outcomes = Array.from({ length: MAX_SETTLE_ATTEMPTS }, (_, attempts) =>
      shouldSimulateFailure('TRANSIENT', attempts),
    );
    // Fails at first, succeeds on the final attempt - so the payment completes
    // and is never refunded.
    expect(outcomes[0]).toBe(true);
    expect(outcomes[outcomes.length - 1]).toBe(false);
  });

  it('a permanent fault never heals', () => {
    for (let attempts = 0; attempts <= MAX_SETTLE_ATTEMPTS + 2; attempts++) {
      expect(shouldSimulateFailure('PERMANENT', attempts)).toBe(true);
    }
  });

  it('no simulation means no interference', () => {
    expect(shouldSimulateFailure('NONE', 0)).toBe(false);
    expect(shouldSimulateFailure('NONE', 99)).toBe(false);
  });
});

describe('idempotency keys', () => {
  it('derives the same key for an identical request', () => {
    expect(deriveIdempotencyKey('a', 'b', 2_500)).toBe(deriveIdempotencyKey('a', 'b', 2_500));
  });

  it('derives a different key when anything about the payment changes', () => {
    const base = deriveIdempotencyKey('a', 'b', 2_500);
    expect(deriveIdempotencyKey('a', 'b', 2_501)).not.toBe(base);
    expect(deriveIdempotencyKey('a', 'c', 2_500)).not.toBe(base);
    expect(deriveIdempotencyKey('c', 'b', 2_500)).not.toBe(base);
    expect(deriveIdempotencyKey('b', 'a', 2_500)).not.toBe(base);
    // Two payments of the same amount with different notes are two payments.
    expect(deriveIdempotencyKey('a', 'b', 2_500, 'lunch')).not.toBe(base);
  });

  it('is not confused by field values that concatenate the same way', () => {
    expect(deriveIdempotencyKey('a|b', 'c', 1)).not.toBe(deriveIdempotencyKey('a', 'b|c', 1));
  });

  it('marks derived keys so they can be treated differently', () => {
    expect(isDerivedKey(deriveIdempotencyKey('a', 'b', 1))).toBe(true);
    expect(isDerivedKey('client-supplied-key')).toBe(false);
  });

  it('fingerprints requests so a reused key with different params is caught', () => {
    expect(requestFingerprint('a', 'b', 2_500)).toBe(requestFingerprint('a', 'b', 2_500));
    expect(requestFingerprint('a', 'b', 2_500)).not.toBe(requestFingerprint('a', 'b', 9_999));
    expect(requestFingerprint('a', 'b', 2_500, 'x')).not.toBe(
      requestFingerprint('a', 'b', 2_500, 'y'),
    );
  });
});
