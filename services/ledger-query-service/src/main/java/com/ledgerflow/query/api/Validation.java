package com.ledgerflow.query.api;

/**
 * Clamped both ways: a negative limit would become a negative range index,
 * which Redis reads as "from the end" and quietly returns the wrong slice.
 */
public final class Validation {

  private Validation() {}

  public static int clampLimit(String raw, int fallback, int max) {
    double wanted = fallback;
    if (raw != null) {
      try {
        double parsed = Double.parseDouble(raw.trim());
        wanted = Double.isFinite(parsed) && parsed != 0 ? parsed : fallback;
      } catch (NumberFormatException e) {
        wanted = fallback;
      }
    }
    return (int) Math.min(Math.max(wanted, 1), max);
  }
}
