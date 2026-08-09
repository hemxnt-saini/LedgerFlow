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
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
