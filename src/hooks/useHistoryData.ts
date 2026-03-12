/**
 * useHistoryData — React hook for historical SPX backtesting.
 *
 * When a past date is selected, fetches all 5-min candles for that day
 * from /api/history. All time navigation is then client-side — changing
 * the time slider finds the nearest candle and computes:
 *   - SPX spot price (candle close at that time)
 *   - Running OHLC (open-to-now)
 *   - Opening range (first 30 minutes)
 *   - Yesterday's OHLC (for clustering)
 *   - Overnight gap (today's open vs yesterday's close)
 *
 * For today's date or when no date is selected, returns null — the app
 * uses live Schwab data instead.
 */

import { useState, useEffect, useCallback } from 'react';
import type { HistoryResponse, HistoryCandle } from '../types/api';

// ============================================================
// TYPES
// ============================================================

export interface HistorySnapshot {
  /** SPX price at the selected time */
  spot: number;
  /** SPY-equivalent price (spot / 10) */
  spy: number;
  /** Running OHLC from market open to the selected time */
  runningOHLC: {
    open: number;
    high: number;
    low: number;
    last: number;
  };
  /** First 30 minutes of trading (first 6 candles) */
  openingRange: {
    high: number;
    low: number;
    rangePts: number;
    complete: boolean;
  } | null;
  /** Previous trading day's OHLC for clustering */
  yesterday: {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    rangePct: number;
    rangePts: number;
  } | null;
  /** Gap between today's open and yesterday's close */
  overnightGap: {
    gapPts: number;
    gapPct: number;
  } | null;
  /** Previous day's closing price */
  previousClose: number;
  /** The candle matching the selected time */
  candle: HistoryCandle;
  /** Index of the candle in the full day */
  candleIndex: number;
  /** Total candles for the day */
  totalCandles: number;
}

export interface UseHistoryDataReturn {
  /** Full day's candle data (null if not loaded or today) */
  history: HistoryResponse | null;
  /** Whether history is currently being fetched */
  loading: boolean;
  /** Error message if fetch failed */
  error: string | null;
  /** Get the market state at a specific time. Returns null if no data. */
  getStateAtTime: (hourET: number, minuteET: number) => HistorySnapshot | null;
  /** Whether we have historical data for the current date */
  hasHistory: boolean;
}

// ============================================================
// FETCH HELPER
// ============================================================

async function fetchHistory(
  date: string,
): Promise<{ data: HistoryResponse } | { error: string }> {
  try {
    const res = await fetch(`/api/history?date=${date}`, {
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const body = await res
        .json()
        .catch(() => ({ error: `HTTP ${res.status}` }));
      return { error: body.error || `HTTP ${res.status}` };
    }
    const data: HistoryResponse = await res.json();
    return { data };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Network error' };
  }
}

// ============================================================
// CANDLE LOOKUP
// ============================================================

/**
 * Find the candle at or just before the given ET time.
 * Candle times are in 5-min increments: 9:30, 9:35, 9:40, ...
 * If the exact time isn't a candle boundary, we use the previous candle.
 */
function findCandleAtTime(
  candles: readonly HistoryCandle[],
  hourET: number,
  minuteET: number,
): { candle: HistoryCandle; index: number } | null {
  if (candles.length === 0) return null;

  const targetMin = hourET * 60 + minuteET;

  // Walk backwards to find the last candle at or before our target time
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i]!;
    const d = new Date(c.datetime);
    const etStr = d.toLocaleString('en-US', { timeZone: 'America/New_York' });
    const etDate = new Date(etStr);
    const candleMin = etDate.getHours() * 60 + etDate.getMinutes();

    if (candleMin <= targetMin) {
      return { candle: c, index: i };
    }
  }

  // Target time is before market open — return first candle
  return { candle: candles[0]!, index: 0 };
}

/**
 * Compute running OHLC from candles[0] through candles[endIdx].
 */
function computeRunningOHLC(
  candles: readonly HistoryCandle[],
  endIdx: number,
): { open: number; high: number; low: number; last: number } {
  const open = candles[0]!.open;
  const last = candles[endIdx]!.close;
  let high = -Infinity;
  let low = Infinity;

  for (let i = 0; i <= endIdx; i++) {
    const c = candles[i]!;
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }

  return { open, high, low, last };
}

/**
 * Compute opening range from the first 6 candles (30 minutes).
 */
function computeOpeningRange(
  candles: readonly HistoryCandle[],
): { high: number; low: number; rangePts: number; complete: boolean } | null {
  if (candles.length === 0) return null;

  const count = Math.min(candles.length, 6);
  let high = -Infinity;
  let low = Infinity;

  for (let i = 0; i < count; i++) {
    const c = candles[i]!;
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }

  return {
    high,
    low,
    rangePts: Math.round((high - low) * 100) / 100,
    complete: count >= 6,
  };
}

// ============================================================
// HOOK
// ============================================================

export function useHistoryData(selectedDate: string): UseHistoryDataReturn {
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch history when date changes
  useEffect(() => {
    if (!selectedDate) {
      setHistory(null);
      setError(null);
      return;
    }

    // Don't fetch for today — live data handles that
    const now = new Date();
    const todayET = now.toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });
    if (selectedDate === todayET) {
      setHistory(null);
      setError(null);
      return;
    }

    // Don't fetch for future dates
    if (selectedDate > todayET) {
      setHistory(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchHistory(selectedDate).then((result) => {
      if (cancelled) return;
      if ('error' in result) {
        setError(result.error);
        setHistory(null);
      } else {
        setHistory(result.data);
        setError(null);
      }
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [selectedDate]);

  const getStateAtTime = useCallback(
    (hourET: number, minuteET: number): HistorySnapshot | null => {
      if (!history || history.candles.length === 0) return null;

      const match = findCandleAtTime(history.candles, hourET, minuteET);
      if (!match) return null;

      const { candle, index } = match;
      const runningOHLC = computeRunningOHLC(history.candles, index);
      const openingRange = computeOpeningRange(history.candles);

      const spot = candle.close;
      const spy = Math.round((spot / 10) * 100) / 100;

      // Overnight gap
      const todayOpen = history.candles[0]!.open;
      const overnightGap =
        history.previousClose > 0
          ? {
              gapPts:
                Math.round((todayOpen - history.previousClose) * 100) / 100,
              gapPct:
                Math.round(
                  ((todayOpen - history.previousClose) /
                    history.previousClose) *
                    10000,
                ) / 100,
            }
          : null;

      return {
        spot,
        spy,
        runningOHLC,
        openingRange,
        yesterday: history.previousDay,
        overnightGap,
        previousClose: history.previousClose,
        candle,
        candleIndex: index,
        totalCandles: history.candles.length,
      };
    },
    [history],
  );

  return {
    history,
    loading,
    error,
    getStateAtTime,
    hasHistory: history != null && history.candles.length > 0,
  };
}
