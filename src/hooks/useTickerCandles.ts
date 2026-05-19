/**
 * useTickerCandles — fetches /api/ticker-candles for an underlying
 * on a date. Lazy: callers pass `enabled=false` while a row is
 * collapsed so we don't burn network on rows the user hasn't
 * looked at.
 *
 * Polls during market hours when the date is today AND the row is
 * expanded. Historical days don't poll because the data is stable.
 *
 * Phase 2M migration: the hook is now a thin wrapper around
 * `useFetchedData<TickerCandlesResponse>` that returns the canonical
 * `{ data, loading, error, refresh, fetchedAt }` shape. Callers
 * destructure `candles` / `previousClose` from `data` at the call
 * site (see LotteryRow / SilentBoomRow / IntervalBARow).
 */

import { POLL_INTERVALS } from '../constants/index.js';
import type { TickerCandlesResponse } from '../components/LotteryFinder/types.js';
import { useFetchedData, type UseFetchedDataResult } from './useFetchedData.js';

interface UseTickerCandlesArgs {
  /** Ticker — required when enabled. */
  ticker: string;
  /** YYYY-MM-DD trading day. */
  date: string;
  /** When false, the hook does NOT fetch. */
  enabled: boolean;
  /** Whether to poll while live (today + market hours). */
  marketOpen: boolean;
}

const todayCt = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

export function useTickerCandles({
  ticker,
  date,
  enabled,
  marketOpen,
}: UseTickerCandlesArgs): UseFetchedDataResult<TickerCandlesResponse> {
  const url = enabled
    ? `/api/ticker-candles?ticker=${encodeURIComponent(ticker)}&date=${encodeURIComponent(date)}`
    : null;

  return useFetchedData<TickerCandlesResponse>({
    url,
    marketOpen,
    pollIntervalMs: POLL_INTERVALS.OTM_FLOW,
    historical: date !== todayCt(),
  });
}
