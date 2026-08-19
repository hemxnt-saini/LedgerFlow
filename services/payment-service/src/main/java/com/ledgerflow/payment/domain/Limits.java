package com.ledgerflow.payment.domain;

import java.util.function.LongFunction;

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
public final class Limits {

  private Limits() {}

  public enum LimitBreach {
    /** One payment larger than the per-payment cap. */
    AMOUNT_ABOVE_LIMIT,
    /** Would take today's total past the daily cap. */
    DAILY_LIMIT_EXCEEDED,
    /** Too many payments inside the rolling velocity window. */
    VELOCITY_EXCEEDED
  }

  /** @param velocityMax payments allowed inside one velocity window. */
  public record AccountLimits(long maxPaymentCents, long dailyLimitCents, int velocityMax) {}

  /**
   * What the account has already spent, as of now.
   *
   * Counts payments that took funds - processing, completed, and awaiting
   * refund. A declined payment moved nothing and must not consume anyone's
   * allowance, and a refunded one gave the money back.
   */
  public record SpendSoFar(long todayCents, int recentCount) {}

  /**
   * @param remainingTodayCents how much of the daily cap is still available,
   *     before this payment.
   */
  public record LimitDecision(boolean allowed, LimitBreach breach, long remainingTodayCents) {}

  /**
   * The order matters. A payment that breaks several rules is reported against
   * the first one, and the most specific reason is the most useful: being told
   * the amount is too large is actionable, being told you are going too fast
   * when the real problem is a $50,000 transfer is not.
   */
  public static LimitDecision checkLimits(
      long amountCents, AccountLimits limits, SpendSoFar spend) {
    long remainingTodayCents = Math.max(0, limits.dailyLimitCents() - spend.todayCents());

    LimitBreach breach;
    if (amountCents > limits.maxPaymentCents()) {
      breach = LimitBreach.AMOUNT_ABOVE_LIMIT;
    } else if (spend.todayCents() + amountCents > limits.dailyLimitCents()) {
      breach = LimitBreach.DAILY_LIMIT_EXCEEDED;
    } else if (spend.recentCount() >= limits.velocityMax()) {
      breach = LimitBreach.VELOCITY_EXCEEDED;
    } else {
      breach = null;
    }

    return new LimitDecision(breach == null, breach, remainingTodayCents);
  }

  /**
   * Human-facing explanation of a breach, with the numbers filled in.
   *
   * A decline that does not say what the limit was leaves the payer with no way
   * to act on it, so every message carries the figure it tripped over.
   */
  public static String explainBreach(
      LimitBreach breach,
      AccountLimits limits,
      SpendSoFar spend,
      int windowSeconds,
      LongFunction<String> money) {
    return switch (breach) {
      case AMOUNT_ABOVE_LIMIT ->
          "Single payments are capped at " + money.apply(limits.maxPaymentCents());
      case DAILY_LIMIT_EXCEEDED ->
          "That would take today past your "
              + money.apply(limits.dailyLimitCents())
              + " daily limit - "
              + money.apply(Math.max(0, limits.dailyLimitCents() - spend.todayCents()))
              + " left";
      case VELOCITY_EXCEEDED ->
          limits.velocityMax() + " payments in " + windowSeconds + " seconds is the most allowed";
    };
  }
}
