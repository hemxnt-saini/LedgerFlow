/**
 * Spending controls: the rules that decide whether a payment is allowed to
 * happen at all.
 *
 * A payment system that can only decline for insufficient funds is a
 * money-mover, not a payments platform. Real ones refuse for reasons that have
 * nothing to do with the balance: this is more than you may send in one go,
 * more than you may send in a day, or faster than you may send at all.
 *
 * These are checked *before* the funds check, because "that is above your
 * per-payment limit" is a more useful thing to be told than "you cannot
 * afford it" - and because a limit breach should not depend on how much
 * happens to be in the account.
 *
 * Pure. The caller supplies the limits and the spend so far; every rule below
 * is a function of those two things.
 */

export type LimitBreach =
  /** One payment larger than the per-payment cap. */
  | 'AMOUNT_ABOVE_LIMIT'
  /** Would take today's total past the daily cap. */
  | 'DAILY_LIMIT_EXCEEDED'
  /** Too many payments inside the rolling velocity window. */
  | 'VELOCITY_EXCEEDED';

export interface AccountLimits {
  maxPaymentCents: number;
  dailyLimitCents: number;
  /** Payments allowed inside one velocity window. */
  velocityMax: number;
}

/**
 * What the account has already spent, as of now.
 *
 * Counts payments that took funds - processing, completed, and awaiting
 * refund. A declined payment moved nothing and must not consume anyone's
 * allowance, and a refunded one gave the money back.
 */
export interface SpendSoFar {
  todayCents: number;
  recentCount: number;
}

export interface LimitDecision {
  allowed: boolean;
  breach: LimitBreach | null;
  /** How much of the daily cap is still available, before this payment. */
  remainingTodayCents: number;
}

/**
 * The order matters. A payment that breaks several rules is reported against
 * the first one, and the most specific reason is the most useful: being told
 * the amount is too large is actionable, being told you are going too fast
 * when the real problem is a $50,000 transfer is not.
 */
export function checkLimits(
  amountCents: number,
  limits: AccountLimits,
  spend: SpendSoFar,
): LimitDecision {
  const remainingTodayCents = Math.max(0, limits.dailyLimitCents - spend.todayCents);

  const breach: LimitBreach | null =
    amountCents > limits.maxPaymentCents
      ? 'AMOUNT_ABOVE_LIMIT'
      : spend.todayCents + amountCents > limits.dailyLimitCents
        ? 'DAILY_LIMIT_EXCEEDED'
        : spend.recentCount >= limits.velocityMax
          ? 'VELOCITY_EXCEEDED'
          : null;

  return { allowed: breach === null, breach, remainingTodayCents };
}

/**
 * Human-facing explanation of a breach, with the numbers filled in.
 *
 * A decline that does not say what the limit was leaves the payer with no way
 * to act on it, so every message carries the figure it tripped over.
 */
export function explainBreach(
  breach: LimitBreach,
  limits: AccountLimits,
  spend: SpendSoFar,
  windowSeconds: number,
  money: (cents: number) => string,
): string {
  switch (breach) {
    case 'AMOUNT_ABOVE_LIMIT':
      return `Single payments are capped at ${money(limits.maxPaymentCents)}`;
    case 'DAILY_LIMIT_EXCEEDED':
      return `That would take today past your ${money(limits.dailyLimitCents)} daily limit - ${money(
        Math.max(0, limits.dailyLimitCents - spend.todayCents),
      )} left`;
    case 'VELOCITY_EXCEEDED':
      return `${limits.velocityMax} payments in ${windowSeconds} seconds is the most allowed`;
  }
}
