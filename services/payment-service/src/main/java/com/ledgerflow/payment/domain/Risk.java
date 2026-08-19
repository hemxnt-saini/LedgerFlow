package com.ledgerflow.payment.domain;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

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
public final class Risk {

  private Risk() {}

  public enum RiskFlag {
    /** Large in absolute terms, whoever it is going to. */
    LARGE_AMOUNT,
    /** First payment to this payee, and not a trivial one. */
    NEW_PAYEE_LARGE,
    /** A burst of payments in a short window. */
    RAPID_FIRE
  }

  /**
   * @param largeAmountCents at or above this, review regardless of payee.
   * @param newPayeeAmountCents at or above this, review if the payee has never
   *     been paid before.
   * @param rapidFireCount this many recent payments makes the next one worth a
   *     look.
   */
  public record RiskPolicy(long largeAmountCents, long newPayeeAmountCents, int rapidFireCount) {}

  /**
   * @param payeeIsNew true when the sender has never successfully paid this
   *     payee.
   * @param recentCount payments the sender has made inside the recent window.
   */
  public record RiskSignals(long amountCents, boolean payeeIsNew, int recentCount) {}

  /** @param flags every rule that fired, not just the first. */
  public record RiskAssessment(boolean hold, List<RiskFlag> flags) {}

  /**
   * All matching flags are returned, unlike a limit breach where only the most
   * specific reason matters. A reviewer deciding whether to release someone
   * else's money wants the whole picture, not the first thing that tripped.
   */
  public static RiskAssessment assessRisk(RiskSignals signals, RiskPolicy policy) {
    List<RiskFlag> flags = new ArrayList<>();

    if (signals.amountCents() >= policy.largeAmountCents()) {
      flags.add(RiskFlag.LARGE_AMOUNT);
    }
    if (signals.payeeIsNew() && signals.amountCents() >= policy.newPayeeAmountCents()) {
      flags.add(RiskFlag.NEW_PAYEE_LARGE);
    }
    if (signals.recentCount() >= policy.rapidFireCount()) {
      flags.add(RiskFlag.RAPID_FIRE);
    }

    return new RiskAssessment(!flags.isEmpty(), List.copyOf(flags));
  }

  private static final Map<RiskFlag, String> FLAG_TEXT =
      new EnumMap<>(
          Map.of(
              RiskFlag.LARGE_AMOUNT, "Large amount",
              RiskFlag.NEW_PAYEE_LARGE, "First payment to this payee",
              RiskFlag.RAPID_FIRE, "Several payments in quick succession"));

  /** What a reviewer reads. Empty string when nothing fired. */
  public static String describeFlags(List<RiskFlag> flags) {
    return flags.stream().map(FLAG_TEXT::get).collect(Collectors.joining(" · "));
  }
}
