/**
 * useContractTape — fetches /api/lottery-contract-tape for an OCC
 * chain on a date. Lazy: callers pass `enabled=false` while a row is
 * collapsed so we don't burn network on rows the user hasn't expanded.
 *
 * Polls during market hours when the date is today AND the row is
 * expanded. Historical days don't poll because the data is stable.
 *
 * Phase 2M-6: thin wrapper over `useFetchedData` exposing the canonical
 * `{ data, loading, error, refresh, fetchedAt }` shape. Callers
 * destructure `series` from `data?.series ?? []`.
 */

import { POLL_INTERVALS } from '../constants/index.js';
import { useETToday } from './useETToday.js';
import { useFetchedData, type UseFetchedDataResult } from './useFetchedData.js';
import type { ContractTapeResponse } from '../components/LotteryFinder/types.js';

interface UseContractTapeArgs {
  /** OCC OSI symbol — required when enabled. */
  chain: string;
  /** YYYY-MM-DD trading day. */
  date: string;
  /** Optional HH:MM CT lower bound. */
  from?: string;
  /** Optional HH:MM CT upper bound. */
  to?: string;
  /** When false, the hook does NOT fetch. */
  enabled: boolean;
  /** Whether to poll while live (today + market hours). */
  marketOpen: boolean;
}

export function useContractTape({
  chain,
  date,
  from,
  to,
  enabled,
  marketOpen,
}: UseContractTapeArgs): UseFetchedDataResult<ContractTapeResponse> {
  let url: string | null = null;
  if (enabled) {
    const params = new URLSearchParams({ chain, date });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    url = `/api/lottery-contract-tape?${params.toString()}`;
  }
  // Historical = not today → single fetch, no polling. Today is the shared
  // ET clock (`useETToday`): the rows are fed ET-stamped fire dates, so a CT
  // comparison would call the new day historical from 23:00 to 24:00 CT, and
  // a wall-clock read on each render would not move at midnight unless
  // something re-rendered the row.
  const today = useETToday();
  const historical = date !== today;
  return useFetchedData<ContractTapeResponse>({
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
