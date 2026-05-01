/**
 * useWallClockFreshness — wall-clock-based "is this timestamp recent" check.
 *
 * Many panels need a defense-in-depth signal: even if polling is firing, the
 * displayed snapshot might be stale (silent network errors, backgrounded tabs,
 * server-side hiccups). Comparing the displayed snapshot timestamp against a
 * regularly-ticked wall-clock value flips a "live" badge to "stale" without
 * touching the polling machinery.
 *
 * Extracted from the verbatim duplication that previously lived in
 * `useGexPerStrike` and `useGexTarget`. The hook owns:
 *   - The `nowMs` re-render ticker (gated by `gates`).
 *   - The `isFresh` derivation against `thresholdMs`.
 *
 * `gates` is an array of booleans; the ticker only runs when ALL gates are
 * truthy. This mirrors the original `if (!isToday || !marketOpen || isScrubbed) return;`
 * guard pattern: pass `[isToday, marketOpen, !isScrubbed]` to reproduce it.
 *
 * Timing caveat (carried over from the originals): between mount and the
 * first tick, `nowMs` is whatever `Date.now()` returned at mount, so a
 * snapshot exactly at the boundary can briefly read fresh until the next
 * tick. The worst-case "fresh badge on stale data" is `thresholdMs + tickMs`.
 */

import { useState, useEffect } from 'react';

/**
 * Default cadence for the wall-clock re-render ticker. Per the original
 * extraction plan: 1s. Consumers reproducing legacy 30s tick behavior pass
 * `tickMs: 30 * 1000` explicitly.
 */
export const FRESHNESS_TICK_MS = 1000;

/**
 * Default freshness threshold. A snapshot is considered "fresh" only when
 * its timestamp is within this many milliseconds of the current wall-clock.
 */
export const DEFAULT_FRESHNESS_THRESHOLD_MS = 60_000;

export interface WallClockFreshness {
  /** Latest wall-clock value snapped by the ticker (ms since epoch). */
  nowMs: number;
  /** Difference between `nowMs` and `timestamp`. `null` when timestamp null. */
  ageMs: number | null;
  /**
   * True when `timestamp` is within `thresholdMs` of `nowMs`. False when the
   * timestamp is null or stale.
   */
  isFresh: boolean;
}

/**
 * Optional knobs. Kept as an options bag so consumers can pass `tickMs`
 * without juggling positional args.
 */
export interface UseWallClockFreshnessOptions {
  /**
   * Boolean gates — ticker only runs when ALL are truthy. Useful for
   * pausing the wall-clock when off-screen, pre-market, scrubbed, etc.
   * Defaults to `[]` (always on).
   */
  gates?: boolean[];
  /** Tick cadence in ms. Defaults to `FRESHNESS_TICK_MS` (1s). */
  tickMs?: number;
}

/**
 * Returns `{ nowMs, ageMs, isFresh }` for a given timestamp. The ticker
 * re-renders the component every `tickMs` while every gate is truthy; when
 * any gate flips false the ticker pauses (no re-renders, but `nowMs` stays
 * at its last value, which is correct because freshness has no meaning while
 * gated off — consumers gate the badge entirely on those same conditions).
 */
export function useWallClockFreshness(
  timestamp: number | null,
  thresholdMs: number = DEFAULT_FRESHNESS_THRESHOLD_MS,
  options: UseWallClockFreshnessOptions = {},
): WallClockFreshness {
  const { gates = [], tickMs = FRESHNESS_TICK_MS } = options;
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Ticker runs only when every gate is truthy. The dep array intentionally
  // serializes `gates` via spread so a referentially-new array with the same
  // contents doesn't churn the effect — React diff is structural per index.
  const allGatesOpen = gates.every(Boolean);
  useEffect(() => {
    if (!allGatesOpen) return;
    const id = setInterval(() => setNowMs(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [allGatesOpen, tickMs]);

  const ageMs = timestamp == null ? null : nowMs - timestamp;
  const isFresh = ageMs != null && ageMs < thresholdMs;

  return { nowMs, ageMs, isFresh };
}
