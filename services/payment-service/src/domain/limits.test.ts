import {
  checkLimits,
  explainBreach,
  type AccountLimits,
  type SpendSoFar,
} from './limits';

const LIMITS: AccountLimits = {
  maxPaymentCents: 50_000, // $500 a payment
  dailyLimitCents: 200_000, // $2,000 a day
  velocityMax: 5,
};

const spend = (todayCents = 0, recentCount = 0): SpendSoFar => ({ todayCents, recentCount });

describe('checkLimits', () => {
  it('allows a payment well inside every limit', () => {
    const result = checkLimits(2_500, LIMITS, spend());
    expect(result).toEqual({
      allowed: true,
      breach: null,
      remainingTodayCents: 200_000,
    });
  });

  describe('per-payment cap', () => {
    it('allows exactly the cap', () => {
      expect(checkLimits(50_000, LIMITS, spend()).allowed).toBe(true);
    });

    it('rejects one cent over', () => {
      expect(checkLimits(50_001, LIMITS, spend()).breach).toBe('AMOUNT_ABOVE_LIMIT');
    });
  });

  describe('daily cap', () => {
    it('allows a payment that lands exactly on the cap', () => {
      expect(checkLimits(50_000, LIMITS, spend(150_000)).allowed).toBe(true);
    });

    // Deliberately under the per-payment cap, so the daily rule is what
    // catches it rather than the amount rule.
    it('rejects the cent that would cross it', () => {
      expect(checkLimits(45_000, LIMITS, spend(155_001)).breach).toBe(
        'DAILY_LIMIT_EXCEEDED',
      );
    });

    it('reports what is left before the payment is applied', () => {
      expect(checkLimits(1_000, LIMITS, spend(120_000)).remainingTodayCents).toBe(80_000);
    });

    it('never reports a negative remainder once the cap is spent', () => {
      expect(checkLimits(100, LIMITS, spend(250_000)).remainingTodayCents).toBe(0);
    });

    it('rejects anything at all once the cap is used up', () => {
      expect(checkLimits(1, LIMITS, spend(200_000)).breach).toBe('DAILY_LIMIT_EXCEEDED');
    });
  });

  describe('velocity', () => {
    it('allows the last payment inside the window', () => {
      expect(checkLimits(100, LIMITS, spend(0, 4)).allowed).toBe(true);
    });

    it('rejects the one after that', () => {
      expect(checkLimits(100, LIMITS, spend(0, 5)).breach).toBe('VELOCITY_EXCEEDED');
    });
  });

  describe('precedence', () => {
    // A payment can break several rules at once. The most specific reason is
    // the most actionable, so it wins.
    it('reports the amount cap ahead of the daily cap', () => {
      expect(checkLimits(90_000, LIMITS, spend(199_000)).breach).toBe(
        'AMOUNT_ABOVE_LIMIT',
      );
    });

    it('reports the daily cap ahead of velocity', () => {
      expect(checkLimits(40_000, LIMITS, spend(199_000, 9)).breach).toBe(
        'DAILY_LIMIT_EXCEEDED',
      );
    });
  });

  describe('degenerate limits', () => {
    it('a zero daily limit blocks everything', () => {
      const frozen = { ...LIMITS, dailyLimitCents: 0 };
      expect(checkLimits(1, frozen, spend()).breach).toBe('DAILY_LIMIT_EXCEEDED');
    });

    it('a zero velocity limit blocks everything', () => {
      const frozen = { ...LIMITS, velocityMax: 0 };
      expect(checkLimits(1, frozen, spend()).breach).toBe('VELOCITY_EXCEEDED');
    });
  });

  // The property the concurrency guarantee rests on: a sequence of payments
  // checked against the running total stops at exactly the right one, and the
  // total never exceeds the cap.
  it('stops a sequence at the cap and never lets the total past it', () => {
    let today = 0;
    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      const result = checkLimits(30_000, { ...LIMITS, velocityMax: 1_000 }, spend(today));
      if (!result.allowed) continue;
      today += 30_000;
      allowed++;
    }
    expect(allowed).toBe(6); // 6 x $300 = $1,800; a seventh would pass $2,000
    expect(today).toBeLessThanOrEqual(LIMITS.dailyLimitCents);
  });
});

describe('explainBreach', () => {
  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  it('names the per-payment cap', () => {
    expect(explainBreach('AMOUNT_ABOVE_LIMIT', LIMITS, spend(), 60, money)).toBe(
      'Single payments are capped at $500.00',
    );
  });

  it('names the daily cap and what is left of it', () => {
    const message = explainBreach('DAILY_LIMIT_EXCEEDED', LIMITS, spend(180_000), 60, money);
    expect(message).toContain('$2000.00 daily limit');
    expect(message).toContain('$200.00 left');
  });

  it('does not report a negative remainder', () => {
    const message = explainBreach('DAILY_LIMIT_EXCEEDED', LIMITS, spend(250_000), 60, money);
    expect(message).toContain('$0.00 left');
  });

  it('names the velocity window', () => {
    expect(explainBreach('VELOCITY_EXCEEDED', LIMITS, spend(), 60, money)).toBe(
      '5 payments in 60 seconds is the most allowed',
    );
  });
});
