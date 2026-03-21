/**
 * useHistoryData — React hook for historical backtesting.
 *
 * Fetches 5-min candles for SPX, VIX, VIX1D, VIX9D, and VVIX for the
 * selected date. All time navigation is client-side after the initial fetch.
 *
 * For today's date, returns null — live Schwab data is used instead.
 */

import { useState, useEffect, useCallback } from 'react';
import type {
  HistoryResponse,
  HistoryCandle,
  SymbolDayData,
} from '../types/api';
import { getETTotalMinutes } from '../utils/timezone';
import { getMarketCloseHourET } from '../data/eventCalendar';

// ============================================================
// TYPES
// ============================================================

export interface HistorySnapshot {
  /** SPX price at the selected time */
  spot: number;
  /** SPY-equivalent price (spot / 10) */
  spy: number;
  /** Running SPX OHLC from market open to the selected time */
  runningOHLC: {
    open: number;
    high: number;
    low: number;
    last: number;
  };
  /** First 30 minutes of SPX trading (first 6 candles) */
  openingRange: {
    high: number;
    low: number;
    rangePts: number;
    complete: boolean;
  } | null;
  /** Previous trading day's SPX OHLC for clustering */
  yesterday: {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    rangePct: number;
    rangePts: number;
  } | null;
  /** VIX value at the selected time */
  vix: number | null;
  /** VIX previous close (for RV/IV calculation) */
  vixPrevClose: number | null;
  /** VIX1D value at the selected time */
  vix1d: number | null;
  /** VIX9D value at the selected time */
  vix9d: number | null;
  /** VVIX value at the selected time */
  vvix: number | null;
  /** SPX previous close */
  previousClose: number;
  /** The SPX candle matching the selected time */
  candle: HistoryCandle;
  /** Index of the candle in the full day */
  candleIndex: number;
  /** Total candles for the day */
  totalCandles: number;
}

export interface UseHistoryDataReturn {
  history: HistoryResponse | null;
  loading: boolean;
  error: string | null;
  getStateAtTime: (hourET: number, minuteET: number) => HistorySnapshot | null;
  hasHistory: boolean;
}

// ============================================================
// FETCH
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
    return { data: await res.json() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Network error' };
  }
}

// ============================================================
// CANDLE LOOKUP
// ============================================================

/**
 * Find the candle at or just before the given ET time.
 */
function findCandleAtTime(
  candles: readonly HistoryCandle[],
  hourET: number,
  minuteET: number,
): { candle: HistoryCandle; index: number } | null {
  if (candles.length === 0) return null;

  const targetMin = hourET * 60 + minuteET;

  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i]!;
    const d = new Date(c.datetime);
    const candleMin = getETTotalMinutes(d);

    if (candleMin <= targetMin) {
      return { candle: c, index: i };
    }
  }

  return { candle: candles[0]!, index: 0 };
}

/**
 * Get the close price of a symbol's candle at the given ET time.
 */
function getSymbolPriceAtTime(
  data: SymbolDayData,
  hourET: number,
  minuteET: number,
): number | null {
  const match = findCandleAtTime(data.candles, hourET, minuteET);
  return match ? match.candle.close : null;
}

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

function computeOpeningRange(
  candles: readonly HistoryCandle[],
): { high: number; low: number; rangePts: number; complete: boolean } | null {
  if (candles.length === 0) return null;

  const count = Math.min(candles.length, 6); // 6 candles × 5 min = 30 min
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

  useEffect(() => {
    if (!selectedDate) {
      setHistory(null);
      setError(null);
      return;
    }

    const now = new Date();
    const todayET = now.toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });
    if (selectedDate >= todayET) {
      setHistory(null);
      setError(null);
      return;
    }

    // Skip weekends and market holidays — no trading data exists
    const dow = new Date(selectedDate + 'T12:00:00Z').getDay();
    const isWeekend = dow === 0 || dow === 6;
    if (isWeekend || getMarketCloseHourET(selectedDate) === null) {
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
      } else if (result.data.candleCount === 0) {
        setError(
          `No intraday data available for ${selectedDate}. Schwab keeps ~60 days of 5-min candles. Older dates can use daily OHLC from the VIX/SPX CSV data.`,
        );
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
      if (!history || history.spx.candles.length === 0) return null;

      const spxCandles = history.spx.candles;
      const match = findCandleAtTime(spxCandles, hourET, minuteET);
      if (!match) return null;

      const { candle, index } = match;
      const runningOHLC = computeRunningOHLC(spxCandles, index);
      const openingRange = computeOpeningRange(spxCandles);

      const spot = candle.close;
      const spy = Math.round((spot / 10) * 100) / 100;

      // VIX values at the same time
      const vix = getSymbolPriceAtTime(history.vix, hourET, minuteET);
      const vix1d = getSymbolPriceAtTime(history.vix1d, hourET, minuteET);
      const vix9d = getSymbolPriceAtTime(history.vix9d, hourET, minuteET);
      const vvix = getSymbolPriceAtTime(history.vvix, hourET, minuteET);

      return {
        spot,
        spy,
        runningOHLC,
        openingRange,
        yesterday: history.spx.previousDay,
        vix,
        vixPrevClose: history.vix.previousClose || null,
        vix1d,
        vix9d,
        vvix,
        previousClose: history.spx.previousClose,
        candle,
        candleIndex: index,
        totalCandles: spxCandles.length,
      };
    },
    [history],
  );

  return {
    history,
    loading,
    error,
    getStateAtTime,
    hasHistory: history != null && history.spx.candles.length > 0,
  };
}
