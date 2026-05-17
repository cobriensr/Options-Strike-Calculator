/**
 * useNowMinute — returns a wall-clock ms value that re-publishes every
 * 60 seconds. Used by per-row consumers that need to recompute
 * elapsed-time-based UI (cohort countdown remaining, EXIT chip
 * derivation) once per minute without writing their own setInterval.
 *
 * Intentionally minimal: no gating, no jitter, no drift correction.
 * For the volume of consumers here (at most 50 visible rows × 2-3
 * derived values), one interval per consumer is well within budget.
 */

import { useEffect, useState } from 'react';

const TICK_MS = 60_000;

export function useNowMinute(): number {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  return nowMs;
}
