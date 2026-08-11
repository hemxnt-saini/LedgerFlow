const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Cents in, dollars out. Money is integer cents everywhere except the screen. */
export const fmt = (cents: number | undefined | null): string =>
  formatter.format((Number(cents) || 0) / 100);

/** Dollars are a display unit; everything past the form boundary is cents. */
export const toCents = (dollars: number): number => Math.round(dollars * 100);

export const initials = (name: string | undefined): string =>
  (name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();

export const ms = (value: number): string => `${Math.round(value)}ms`;

export function median(values: number[]): number | null {
  return percentile(values, 50);
}

/**
 * Nearest-rank percentile.
 *
 * A median alone hides the tail, and the tail is what a latency promise is
 * actually written against - p95 is the number that decides whether a system
 * feels fast, not p50.
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (p >= 100) return sorted[sorted.length - 1];
  // Averaging the two middle samples keeps the median exact on even counts,
  // which is what the stage figures showed before percentiles existed.
  if (p === 50 && sorted.length % 2 === 0) {
    const mid = sorted.length / 2;
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1) - 1, sorted.length - 1)];
}
