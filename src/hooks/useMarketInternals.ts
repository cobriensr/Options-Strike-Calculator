/**
 * useMarketInternals — React hook for live NYSE market internals.
 *
 * Polls `GET /api/market-internals/history` and exposes today's 1-minute
 * OHLC bars for $TICK, $ADD, $VOLD, and $TRIN plus a latest-per-symbol
 * lookup table for the compact badge UI.
 *
 * Polling semantics (mirrors useWhalePositioning):
 *   - `marketOpen === true` — fetch on mount + poll every
 *     `POLL_INTERVALS.MARKET_INTERNALS` (60s, matches the 1-min cron).
 *   - `marketOpen === false` — fetch once on mount so the post-session
 *     badge still shows last-known closes; then stop polling.
 *
 * Task 3 deliberately refetches today's full bar set on each poll rather
 * than using the endpoint's `?since=` incremental mode. At ~4 bars/min ×
 * 4 symbols × 6.5h ≈ 6.2k rows/day worst case the payload is trivial and
 * the simpler contract is easier to reason about. Phase 2 can optimize.
 *
 * AbortError from unmount / supersession is swallowed. Errors do not clear
 * `bars` — stale internals are strictly more useful than an empty panel.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants';
import { INTERNAL_SYMBOLS } from '../constants/market-internals';
import type { InternalBar, InternalSymbol } from '../types/market-internals';

// ============================================================
// PUBLIC TYPES
// ============================================================

export interface UseMarketInternalsParams {
  marketOpen: boolean;
}

export interface UseMarketInternalsResult {
  bars: InternalBar[];
  latestBySymbol: Record<InternalSymbol, InternalBar | null>;
  loading: boolean;
  error: string | null;
  asOf: string | null;
}

// ============================================================
// API RESPONSE SHAPE
// ============================================================

interface MarketInternalsApiResponse {
  bars: InternalBar[];
  asOf: string;
  marketOpen: boolean;
}

// ============================================================
// HELPERS
// ============================================================

function emptyLatest(): Record<InternalSymbol, InternalBar | null> {
  const out = {} as Record<InternalSymbol, InternalBar | null>;
  for (const sym of INTERNAL_SYMBOLS) {
    out[sym] = null;
  }
  return out;
}

function computeLatestBySymbol(
  bars: InternalBar[],
): Record<InternalSymbol, InternalBar | null> {
  const out = emptyLatest();
  // Bars are sorted ts ASC by the server; walk once and overwrite so the
  // final write per symbol is the newest bar.
  for (const bar of bars) {
    out[bar.symbol] = bar;
  }
  return out;
}

// ============================================================
// HOOK
// ============================================================

export function useMarketInternals(
  params: UseMarketInternalsParams,
): UseMarketInternalsResult {
  const { marketOpen } = params;

  const [bars, setBars] = useState<InternalBar[]>([]);
  // `loading` is true on initial load only — subsequent polls refresh data
  // silently so the badge doesn't flicker every 60s.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);

  const isMountedRef = useRef(true);
  const hasLoadedRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    isMountedRef.current = true;

    const fetchNow = async (): Promise<void> => {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        const res = await fetch('/api/market-internals/history', {
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`market-internals HTTP ${res.status}`);
        }
        const data = (await res.json()) as MarketInternalsApiResponse;

        if (!isMountedRef.current || controller.signal.aborted) return;

        setBars(data.bars);
        setAsOf(data.asOf);
        setError(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!isMountedRef.current) return;
        setError(
          err instanceof Error ? err.message : 'market-internals fetch failed',
        );
        // Preserve prior bars — stale internals beat empty ones.
      } finally {
        if (isMountedRef.current && !hasLoadedRef.current) {
          hasLoadedRef.current = true;
          setLoading(false);
        }
      }
    };

    void fetchNow();

    if (!marketOpen) {
      return () => {
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
      };
    }

    const intervalId = setInterval(() => {
      void fetchNow();
    }, POLL_INTERVALS.MARKET_INTERNALS);

    return () => {
      clearInterval(intervalId);
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, [marketOpen]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const latestBySymbol = useMemo(() => computeLatestBySymbol(bars), [bars]);

  return { bars, latestBySymbol, loading, error, asOf };
}
