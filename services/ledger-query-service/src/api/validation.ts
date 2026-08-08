/**
 * Clamped both ways: a negative limit would become a negative range index,
 * which Redis reads as "from the end" and quietly returns the wrong slice.
 */
export const clampLimit = (raw: unknown, fallback: number, max: number): number =>
  Math.min(Math.max(Number(raw ?? fallback) || fallback, 1), max);
