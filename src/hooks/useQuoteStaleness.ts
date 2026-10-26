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
 */

import { useEffect, useState } from 'react';
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
  // Wall-clock snapshot, set only from the effect so render stays pure
  // (no `Date.now()` during render).
  const [now, setNow] = useState<number | null>(null);
  const ticking = session !== 'closed' && quotesFetchedAt != null;

  useEffect(() => {
    if (!ticking) return;
    // Fire once immediately so the first render after the gate opens has a
    // current clock, then every STALENESS_TICK_MS.
    setNow(Date.now());
    const id = setInterval(() => {
      setNow(Date.now());
    }, STALENESS_TICK_MS);
    return () => clearInterval(id);
  }, [ticking]);

  if (!ticking || now == null) return NOT_STALE;

  const ageMs = now - quotesFetchedAt;
  return {
    isStale: ageMs >= STALE_THRESHOLD_MS,
    isVeryStale: ageMs >= VERY_STALE_THRESHOLD_MS,
    staleAgeSec: Math.max(0, Math.round(ageMs / 1000)),
  };
}
