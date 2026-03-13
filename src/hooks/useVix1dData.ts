/**
 * useVix1dData — Loads the static VIX1D daily OHLC JSON (from CBOE).
 *
 * Provides a lookup function that returns the VIX1D value for a given
 * date and time, using the same "smart" logic as VIX:
 *   - Before noon ET → use open
 *   - After noon ET → use close
 *
 * Data covers May 2022 – present (960+ days).
 * Real OHLC starts April 2023; earlier dates are close-only backtested.
 */

import { useState, useEffect, useCallback } from 'react';

interface Vix1dEntry {
  o: number;
  h: number;
  l: number;
  c: number;
}

type Vix1dDataMap = Record<string, Vix1dEntry>;

export interface UseVix1dDataReturn {
  loaded: boolean;
  /** Get VIX1D value for a date at a given ET hour. Uses smart OHLC (open < noon, close >= noon). */
  getVix1d: (date: string, hourET: number) => number | null;
  /** Get full OHLC for a date */
  getOHLC: (date: string) => Vix1dEntry | null;
  /** Number of days loaded */
  dayCount: number;
}

export function useVix1dData(): UseVix1dDataReturn {
  const [data, setData] = useState<Vix1dDataMap>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch('/vix1d-daily.json')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: Vix1dDataMap) => {
        setData(json);
        setLoaded(true);
      })
      .catch((err) => {
        console.warn('Failed to load VIX1D daily data:', err);
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
    (date: string): Vix1dEntry | null => {
      return data[date] ?? null;
    },
    [data],
  );

  return {
    loaded,
    getVix1d,
    getOHLC,
    dayCount: Object.keys(data).length,
  };
}
