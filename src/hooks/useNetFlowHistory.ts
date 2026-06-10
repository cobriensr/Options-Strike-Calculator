/**
 * useNetFlowHistory — fetches /api/net-flow-history for a ticker on
 * a date. Lazy: callers pass `enabled=false` while a row is collapsed
 * so we don't burn network on rows the user hasn't looked at.
 *
 * Polls during market hours when the date is today AND the row is
 * expanded. Historical days don't poll because the data is stable.
 *
 * Phase 2M-3: thin wrapper over `useFetchedData` exposing the canonical
 * `{ data, loading, error, refresh, fetchedAt }` shape. Callers
 * destructure `series` from `data?.series ?? []`.
 */

import { POLL_INTERVALS } from '../constants/index.js';
import { useFetchedData, type UseFetchedDataResult } from './useFetchedData.js';
import type { NetFlowHistoryResponse } from '../components/LotteryFinder/types.js';

interface UseNetFlowHistoryArgs {
  /** Ticker — required when enabled. */
  ticker: string;
  /** YYYY-MM-DD trading day. */
  date: string;
  /** Optional HH:MM CT lower bound. */
  from?: string;
  /** Optional HH:MM CT upper bound. */
  to?: string;
  /** When false, the hook does NOT fetch (lets callers gate by row expand). */
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

export function useNetFlowHistory({
  ticker,
  date,
  from,
  to,
  enabled,
  marketOpen,
}: UseNetFlowHistoryArgs): UseFetchedDataResult<NetFlowHistoryResponse> {
  let url: string | null = null;
  if (enabled) {
    const params = new URLSearchParams({ ticker, date });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    url = `/api/net-flow-history?${params.toString()}`;
  }
  // Historical = not today → single fetch, no polling. Matches the
  // original `date === todayCt()` gate the bespoke implementation used.
  const historical = date !== todayCt();
  return useFetchedData<NetFlowHistoryResponse>({
    url,
    marketOpen,
    pollIntervalMs: POLL_INTERVALS.OTM_FLOW,
    historical,
    // Cross-day staleness gate — matches the feed hooks: a prior-day
    // response is nulled until its echoed date matches the request.
    requestKey: date,
    responseKey: (d) => d.date?.slice(0, 10),
  });
}
