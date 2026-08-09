import { useState } from 'react';
import { useInterval } from './useInterval';

/**
 * Relative timestamps ("3m ago") go stale on a page nobody touches, and
 * nothing re-renders on its own to fix them. This forces a repaint on a slow
 * cadence purely so the clock keeps up.
 */
export function useRelativeTimeTick(everyMs = 30_000): void {
  const [, setTick] = useState(0);
  useInterval(() => setTick((value) => value + 1), everyMs);
}
