/**
 * useTickerNetFlowBatch — polls /api/ticker-net-flow-current to keep a
 * live `Map<ticker, { cumNcp, cumNpp, asOfTs }>` for every visible
 * ticker in the Lottery or SilentBoom panel. Backs the Flow Match /
 * Flow Mismatch / Flow Inverted badges so a single panel-level poll
 * replaces what would otherwise be N per-row chart fetches.
 *
 * Polls at TICKER_NET_FLOW (60s) while `marketOpen` is true AND there
 * is at least one ticker to query. Empty ticker list or closed market
 * means no fetch is scheduled (saves both bandwidth and stale-data
 * confusion overnight).
 *
 * The hook deduplicates + uppercases tickers and stably sorts them
 * before serializing into the URL, so a re-render whose `tickers` array
 * is referentially-new but value-equivalent does NOT trigger an extra
 * fetch.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants/index.js';
import { getErrorMessage } from '../utils/error.js';

export interface TickerNetFlowSnapshot {
  cumNcp: number;
  cumNpp: number;
  /** UTC ISO of the latest WS/REST row that contributed to this row. */
  asOfTs: string;
}

interface TickerNetFlowCurrentResponse {
  date: string;
  requestedTickers: string[];
  count: number;
  snapshots: Array<{
    ticker: string;
    asOfTs: string;
    cumNcp: number;
    cumNpp: number;
  }>;
}

interface UseTickerNetFlowBatchArgs {
  /**
   * Visible tickers to query. Order doesn't matter — the hook dedupes,
   * uppercases, and stably sorts before building the URL. Passing a
   * fresh array with the same set per render is fine.
   */
  tickers: readonly string[];
  /** YYYY-MM-DD trading day the section is showing. */
  date: string;
  /** Gate polling — closed market means no fetch. */
  marketOpen: boolean;
}

export interface UseTickerNetFlowBatchResult {
  /** Map keyed by uppercase ticker. Empty until first fetch resolves. */
  data: Map<string, TickerNetFlowSnapshot>;
  loading: boolean;
  error: string | null;
  /** UTC ms of the last successful fetch. Null before first response. */
  fetchedAt: number | null;
}

/**
 * Canonicalize the ticker list so two referentially-different arrays
 * with the same content produce the same URL. Uppercased + deduped +
 * stably sorted.
 */
function canonicalizeTickers(input: readonly string[]): string[] {
  const set = new Set<string>();
  for (const t of input) {
    const trimmed = t.trim().toUpperCase();
    if (trimmed.length > 0) set.add(trimmed);
  }
  return [...set].sort();
}

export function useTickerNetFlowBatch({
  tickers,
  date,
  marketOpen,
}: UseTickerNetFlowBatchArgs): UseTickerNetFlowBatchResult {
  const [data, setData] = useState<Map<string, TickerNetFlowSnapshot>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  // Cancels any in-flight request on rerun / unmount so a stale response
  // can't clobber a newer fetch's state and the browser stops the
  // bandwidth burn on rapid ticker-set changes.
  const abortRef = useRef<AbortController | null>(null);

  const canonical = useMemo(() => canonicalizeTickers(tickers), [tickers]);
  // Join into a primitive so it's a stable dep — a new array with the
  // same contents would otherwise churn the effect every render.
  const tickersKey = canonical.join(',');

  const doFetch = useCallback(async () => {
    if (tickersKey.length === 0) return;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setLoading(true);
    setError(null);
    try {
      const url = `/api/ticker-net-flow-current?tickers=${encodeURIComponent(tickersKey)}&date=${encodeURIComponent(date)}`;
      const res = await fetch(url, {
        credentials: 'same-origin',
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as TickerNetFlowCurrentResponse;
      // Superseded by a newer fetch between resolve and parse — bail
      // before clobbering newer state.
      if (ctrl.signal.aborted) return;

      const next = new Map<string, TickerNetFlowSnapshot>();
      for (const s of json.snapshots) {
        next.set(s.ticker, {
          cumNcp: s.cumNcp,
          cumNpp: s.cumNpp,
          asOfTs: s.asOfTs,
        });
      }
      setData(next);
      setFetchedAt(Date.now());
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (ctrl.signal.aborted) return;
      setError(getErrorMessage(err));
    } finally {
      // Only clear loading if this fetch wasn't superseded — a newer
      // fetch owns loading=true until it itself resolves.
      if (abortRef.current === ctrl) setLoading(false);
    }
  }, [tickersKey, date]);

  // Eager fetch on mount + whenever the ticker set or date changes.
  useEffect(() => {
    if (!marketOpen) return;
    if (tickersKey.length === 0) return;
    void doFetch();
  }, [doFetch, marketOpen, tickersKey]);

  // Recurring poll while market is open and we have a non-empty set.
  useEffect(() => {
    if (!marketOpen) return;
    if (tickersKey.length === 0) return;
    const id = setInterval(() => {
      void doFetch();
    }, POLL_INTERVALS.TICKER_NET_FLOW);
    return () => clearInterval(id);
  }, [doFetch, marketOpen, tickersKey]);

  // Cancel any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  return { data, loading, error, fetchedAt };
}
