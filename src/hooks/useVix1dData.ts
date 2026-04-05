/**
 * useVix1dData — Lazy-loads the static VIX1D daily OHLC JSON (from CBOE).
 *
 * The 64 KB JSON is only fetched when `getVix1d` or `getOHLC` is first called,
 * which happens when viewing a historical date without Schwab VIX1D data.
 * Live-mode users never trigger the fetch.
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
  /** Get VIX1D value for a date at a given ET hour. Uses smart OHLC (open < noon, close >= noon). Triggers lazy load on first call. */
  getVix1d: (date: string, hourET: number) => number | null;
  /** Get full OHLC for a date. Triggers lazy load on first call. */
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

    fetch('/vix1d-daily.json')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: Vix1dDataMap) => {
        setData(json);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        console.warn('Failed to load VIX1D daily data:', getErrorMessage(err));
        fetchStarted.current = false; // allow retry on failure
      });
  }, []);

  const getVix1d = useCallback(
    (date: string, hourET: number): number | null => {
      ensureLoaded();
      const entry = data[date];
      if (!entry) return null;
      // Smart OHLC: open before noon, close after
      return hourET < 12 ? entry.o : entry.c;
    },
    [data, ensureLoaded],
  );

  const getOHLC = useCallback(
    (date: string): Vix1dEntry | null => {
      ensureLoaded();
      return data[date] ?? null;
    },
    [data, ensureLoaded],
  );

  return {
    loaded,
    getVix1d,
    getOHLC,
    dayCount: Object.keys(data).length,
  };
}
