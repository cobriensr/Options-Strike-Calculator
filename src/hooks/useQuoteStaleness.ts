/**
 * useQuoteStaleness — how old the last successful /api/quotes fetch is,
 * re-checked on a 5 s wall-clock tick while the session is open.
 * FE-STATE-001.
 *
 * Split out of `useMarketData` (F1, review-remediation-2026-10-26). The
 * tick used to live there, so every 5 s it gave that hook's memoised
 * return a new identity and re-rendered the whole panel tree, about 12
 * times a minute for the owner. Only the header's quote badge reads these
 * values, so the clock now lives with the badge and re-renders only it.
 *
 * The tick is `useWallClockFreshness` (on `usePolling`), gated on the
 * session being open and a quotes fetch existing. Two timing notes:
 *
 *   - There is no "clock not set yet" render: the helper seeds its clock
 *     with `Date.now()` on mount, so the first render already has an age.
 *   - While the gate is closed the helper's clock is paused, not cleared.
 *     When the gate reopens (closed → pre-market at 04:00 ET, or the first
 *     quotes fetch landing) the age is read against that older clock value
 *     until the first tick, up to 5 s later. The clock is always behind the
 *     real one, so age is only ever under-reported. In practice the
 *     pre-market "Quotes Ns old" tooltip can appear up to 5 s late, under a
 *     label that stays CLOSED. That is within the 5 s lag the tick already
 *     accepts.
 */

import { useWallClockFreshness } from './useWallClockFreshness';
import type { MarketSession } from './useMarketData';

export interface QuoteStaleness {
  /** Quotes are 90 s old or more: one missed poll past the 60 s cadence. */
  isStale: boolean;
  /** Quotes are 180 s old or more: three missed polls. Implies `isStale`. */
  isVeryStale: boolean;
  /**
   * Age of the last quotes fetch in whole seconds, or `null` while the
   * session is closed or before the first fetch lands.
   */
  staleAgeSec: number | null;
}

/**
 * Fixed thresholds, not scaled by polling backoff: a poll that has backed
 * off to 120 s is itself abnormal for the trader and the badge should say so.
 */
const STALE_THRESHOLD_MS = 90_000;
const VERY_STALE_THRESHOLD_MS = 180_000;

/**
 * Re-evaluation cadence. 5 s is imperceptibly late (stale shows at up to
 * 95 s instead of 90 s) and far cheaper than a 1 s tick.
 */
const STALENESS_TICK_MS = 5_000;

const NOT_STALE: QuoteStaleness = {
  isStale: false,
  isVeryStale: false,
  staleAgeSec: null,
};

/**
 * @param quotesFetchedAt Epoch ms of the last successful quotes fetch
 *   (`useMarketData().quotesFetchedAt`), or `null` if none yet.
 * @param session Current market session. Staleness only applies while it
 *   is not `'closed'`: pre-market, regular and after-hours, matching the
 *   quotes polling gate. Overnight, polling has stopped on purpose and a
 *   stale badge would be noise.
 */
export function useQuoteStaleness(
  quotesFetchedAt: number | null,
  session: MarketSession,
): QuoteStaleness {
  const ticking = session !== 'closed' && quotesFetchedAt != null;
  const { ageMs } = useWallClockFreshness(quotesFetchedAt, STALE_THRESHOLD_MS, {
    gates: [ticking],
    tickMs: STALENESS_TICK_MS,
  });

  // `ageMs` is null only when `quotesFetchedAt` is, which `!ticking`
  // already covers; the second check just narrows the type.
  if (!ticking || ageMs == null) return NOT_STALE;

  return {
    isStale: ageMs >= STALE_THRESHOLD_MS,
    isVeryStale: ageMs >= VERY_STALE_THRESHOLD_MS,
    staleAgeSec: Math.max(0, Math.round(ageMs / 1000)),
  };
}
