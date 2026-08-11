import { assessRisk, describeFlags, type RiskPolicy, type RiskSignals } from './risk';

const POLICY: RiskPolicy = {
  largeAmountCents: 50_000, // $500
  newPayeeAmountCents: 10_000, // $100
  rapidFireCount: 5,
};

const signals = (overrides: Partial<RiskSignals> = {}): RiskSignals => ({
  amountCents: 1_000,
  payeeIsNew: false,
  recentCount: 0,
  ...overrides,
});

describe('assessRisk', () => {
  it('lets an ordinary payment through untouched', () => {
    expect(assessRisk(signals(), POLICY)).toEqual({ hold: false, flags: [] });
  });

  describe('large amount', () => {
    it('holds at the threshold', () => {
      const result = assessRisk(signals({ amountCents: 50_000 }), POLICY);
      expect(result.hold).toBe(true);
      expect(result.flags).toEqual(['LARGE_AMOUNT']);
    });

    it('lets one cent under it through', () => {
      expect(assessRisk(signals({ amountCents: 49_999 }), POLICY).hold).toBe(false);
    });
  });

  describe('new payee', () => {
    it('holds a first payment at or above the threshold', () => {
      const result = assessRisk(
        signals({ amountCents: 10_000, payeeIsNew: true }),
        POLICY,
      );
      expect(result.flags).toEqual(['NEW_PAYEE_LARGE']);
    });

    // A small first payment is how people check an account number works.
    it('lets a small first payment through', () => {
      expect(
        assessRisk(signals({ amountCents: 9_999, payeeIsNew: true }), POLICY).hold,
      ).toBe(false);
    });

    it('ignores the payee rule once they have been paid before', () => {
      expect(
        assessRisk(signals({ amountCents: 40_000, payeeIsNew: false }), POLICY).hold,
      ).toBe(false);
    });
  });

  describe('rapid fire', () => {
    it('holds at the threshold', () => {
      expect(assessRisk(signals({ recentCount: 5 }), POLICY).flags).toEqual(['RAPID_FIRE']);
    });

    it('lets one under it through', () => {
      expect(assessRisk(signals({ recentCount: 4 }), POLICY).hold).toBe(false);
    });
  });

  // A reviewer releasing someone else's money wants the whole picture, so
  // every rule that fired is reported rather than only the first.
  it('reports every rule that fired', () => {
    const result = assessRisk(
      signals({ amountCents: 90_000, payeeIsNew: true, recentCount: 9 }),
      POLICY,
    );
    expect(result.hold).toBe(true);
    expect(result.flags).toEqual(['LARGE_AMOUNT', 'NEW_PAYEE_LARGE', 'RAPID_FIRE']);
  });

  describe('degenerate policy', () => {
    it('a zero large-amount threshold reviews everything', () => {
      const paranoid = { ...POLICY, largeAmountCents: 0 };
      expect(assessRisk(signals({ amountCents: 1 }), paranoid).hold).toBe(true);
    });

    it('thresholds above any real amount review nothing', () => {
      const relaxed: RiskPolicy = {
        largeAmountCents: Number.MAX_SAFE_INTEGER,
        newPayeeAmountCents: Number.MAX_SAFE_INTEGER,
        rapidFireCount: Number.MAX_SAFE_INTEGER,
      };
      const result = assessRisk(
        signals({ amountCents: 10_000_000, payeeIsNew: true, recentCount: 500 }),
        relaxed,
      );
      expect(result).toEqual({ hold: false, flags: [] });
    });
  });
});

describe('describeFlags', () => {
  it('reads as a sentence for a reviewer', () => {
    expect(describeFlags(['LARGE_AMOUNT', 'NEW_PAYEE_LARGE'])).toBe(
      'Large amount · First payment to this payee',
    );
  });

  it('is empty when nothing fired', () => {
    expect(describeFlags([])).toBe('');
  });
});
