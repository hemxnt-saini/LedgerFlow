/**
 * Risk screening: deciding that a payment needs a person to look at it.
 *
 * Distinct from the spending limits next door. A limit is a hard refusal - the
 * money never moves. A risk hold is a pause: the funds are already secured in
 * the clearing account, and the question is whether to release them. That is
 * how real systems do it, and it is the only order that is safe. Reviewing
 * before securing the funds would let the balance be spent elsewhere while
 * someone deliberates.
 *
 * So a held payment is a normal authorised payment that simply has not been
 * settled yet. Approving it drops it straight back onto the settlement path;
 * rejecting it runs the same compensating action a stuck payment uses.
 *
 * Pure: the caller gathers the signals, this decides.
 */

export type RiskFlag =
  /** Large in absolute terms, whoever it is going to. */
  | 'LARGE_AMOUNT'
  /** First payment to this payee, and not a trivial one. */
  | 'NEW_PAYEE_LARGE'
  /** A burst of payments in a short window. */
  | 'RAPID_FIRE';

export interface RiskPolicy {
  /** At or above this, review regardless of payee. */
  largeAmountCents: number;
  /** At or above this, review if the payee has never been paid before. */
  newPayeeAmountCents: number;
  /** This many recent payments makes the next one worth a look. */
  rapidFireCount: number;
}

export interface RiskSignals {
  amountCents: number;
  /** True when the sender has never successfully paid this payee. */
  payeeIsNew: boolean;
  /** Payments the sender has made inside the recent window. */
  recentCount: number;
}

export interface RiskAssessment {
  hold: boolean;
  /** Every rule that fired, not just the first. */
  flags: RiskFlag[];
}

/**
 * All matching flags are returned, unlike a limit breach where only the most
 * specific reason matters. A reviewer deciding whether to release someone
 * else's money wants the whole picture, not the first thing that tripped.
 */
export function assessRisk(signals: RiskSignals, policy: RiskPolicy): RiskAssessment {
  const flags: RiskFlag[] = [];

  if (signals.amountCents >= policy.largeAmountCents) {
    flags.push('LARGE_AMOUNT');
  }
  if (signals.payeeIsNew && signals.amountCents >= policy.newPayeeAmountCents) {
    flags.push('NEW_PAYEE_LARGE');
  }
  if (signals.recentCount >= policy.rapidFireCount) {
    flags.push('RAPID_FIRE');
  }

  return { hold: flags.length > 0, flags };
}

const FLAG_TEXT: Record<RiskFlag, string> = {
  LARGE_AMOUNT: 'Large amount',
  NEW_PAYEE_LARGE: 'First payment to this payee',
  RAPID_FIRE: 'Several payments in quick succession',
};

/** What a reviewer reads. Empty string when nothing fired. */
export const describeFlags = (flags: RiskFlag[]): string =>
  flags.map((flag) => FLAG_TEXT[flag]).join(' · ');
