/**
 * useVix1dData — Lazy-loads the static VIX1D daily OHLC JSON (from CBOE).
 *
 * The 64 KB JSON is only fetched when `ensureLoaded` is first called. The
 * caller does that from an effect (useAutoFill, when a historical date has no
 * Schwab VIX1D data), so live-mode users never trigger the fetch. The getters
 * are pure lookups: they do no I/O, so they're safe to call during render,
 * and return null until the data arrives.
 *
 * Provides a lookup function that returns the VIX1D value for a given
 * date and time, using the same "smart" logic as VIX:
 *   - Before noon ET → use open
 *   - After noon ET → use close
 *
 * Data covers May 2022 – present (960+ days).
 * Real OHLC starts April 2023; earlier dates are close-only backtested.
 */

import { useState, useCallback, useRef } from 'react';
import { captureUnlessAuth } from '../lib/sentry-helpers';
import { getErrorMessage } from '../utils/error';

interface Vix1dEntry {
  o: number;
  h: number;
  l: number;
  c: number;
}

type Vix1dDataMap = Record<string, Vix1dEntry>;

export interface UseVix1dDataReturn {
  loaded: boolean;
  /**
   * Start the one-time load. Idempotent while a load is in flight or done;
   * a failed load can be retried by calling it again. Call from an effect,
   * never during render.
   */
  ensureLoaded: () => void;
  /** Get VIX1D value for a date at a given ET hour. Uses smart OHLC (open < noon, close >= noon). Null until loaded. */
  getVix1d: (date: string, hourET: number) => number | null;
  /** Get full OHLC for a date. Null until loaded. */
  getOHLC: (date: string) => Vix1dEntry | null;
  /** Number of days loaded */
  dayCount: number;
}

export function useVix1dData(): UseVix1dDataReturn {
  const [data, setData] = useState<Vix1dDataMap>({});
  const [loaded, setLoaded] = useState(false);
  const fetchStarted = useRef(false);

  const ensureLoaded = useCallback(() => {
    if (fetchStarted.current) return;
    fetchStarted.current = true;

    // Try the live endpoint (fed by the refresh-vix1d cron, always up-to-date).
    // Fall back to the static JSON baseline if the cron has not run yet (404)
    // or if Redis is unavailable.
    fetch('/api/vix1d-daily')
      .then((res) => {
        if (res.ok) return res.json() as Promise<Vix1dDataMap>;
        // 404 = cron not yet run; fall back to static baseline
        return fetch('/vix1d-daily.json').then((fallback) => {
          if (!fallback.ok) throw new Error(`HTTP ${fallback.status}`);
          return fallback.json() as Promise<Vix1dDataMap>;
        });
      })
      .then((json: Vix1dDataMap) => {
        setData(json);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        captureUnlessAuth(err, {
          tags: { context: 'vix1d_load' },
        });
        console.warn('Failed to load VIX1D daily data:', getErrorMessage(err));
        fetchStarted.current = false; // allow retry on failure
      });
  }, []);

  const getVix1d = useCallback(
    (date: string, hourET: number): number | null => {
      const entry = data[date];
      if (!entry) return null;
      // Smart OHLC: open before noon, close after
      return hourET < 12 ? entry.o : entry.c;
    },
    [data],
  );

  const getOHLC = useCallback(
    (date: string): Vix1dEntry | null => data[date] ?? null,
    [data],
  );

  return {
    loaded,
    ensureLoaded,
    getVix1d,
    getOHLC,
    dayCount: Object.keys(data).length,
  };
}
