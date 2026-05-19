/**
 * useTickerCandles — fetches /api/ticker-candles for an underlying
 * on a date. Lazy: callers pass `enabled=false` while a row is
 * collapsed so we don't burn network on rows the user hasn't
 * looked at.
 *
 * Polls during market hours when the date is today AND the row is
 * expanded. Historical days don't poll because the data is stable.
 *
 * Phase 2L migration: the hook is now a thin wrapper around the
 * `useFetchedData<T>` primitive. The PUBLIC return shape is preserved
 * (callers see `candles`, `previousClose`, `loading`, `error`,
 * `fetchedAt`, `refetch`) — the canonical `{ data, ... }` shape
 * migration is queued for Phase 2M.
 */

import { useMemo } from 'react';

import { POLL_INTERVALS } from '../constants/index.js';
import type {
  TickerCandle,
  TickerCandlesResponse,
} from '../components/LotteryFinder/types.js';
import { useFetchedData } from './useFetchedData.js';

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

interface UseTickerCandlesReturn {
  candles: TickerCandle[];
  previousClose: number | null;
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
  refetch: () => void;
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
}: UseTickerCandlesArgs): UseTickerCandlesReturn {
  const url = enabled
    ? `/api/ticker-candles?ticker=${encodeURIComponent(ticker)}&date=${encodeURIComponent(date)}`
    : null;

  const { data, loading, error, refresh, fetchedAt } =
    useFetchedData<TickerCandlesResponse>({
      url,
      marketOpen,
      pollIntervalMs: POLL_INTERVALS.OTM_FLOW,
      historical: date !== todayCt(),
    });

  return useMemo(
    () => ({
      candles: data?.candles ?? [],
      previousClose: data?.previousClose ?? null,
      loading,
      error,
      fetchedAt,
      refetch: refresh,
    }),
    [data, loading, error, fetchedAt, refresh],
  );
}
