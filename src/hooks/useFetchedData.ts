/**
 * useFetchedData — generic data-fetching primitive for the ~20 hooks
 * that duplicate the same
 * `abortRef`+`URLSearchParams`+`setLoading/setError/setData`+
 * `usePolling` ceremony.
 *
 * Surface:
 *
 *   useFetchedData<T>({
 *     url,              // string | null  — null = disabled
 *     marketOpen,
 *     pollIntervalMs?,  // omit = single fetch (no polling)
 *     historical?,      // true = single fetch even when pollIntervalMs set
 *     parse?,           // (raw: unknown) => T  — default: identity cast
 *   }) → { data, loading, error, refresh, fetchedAt }
 *
 * Built on top of `usePolling` so the gate / cadence semantics match
 * every hook already migrated in Phase 2K. Eager mount-fetch lives in
 * a sibling effect; the unmount-cancel AbortController is owned here
 * so consumers don't have to repeat the pattern.
 *
 * Spec: docs/superpowers/specs/frontend-cleanup-tiers-1-2-3-2026-05-18.md (Phase 2L)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getErrorMessage } from '../utils/error.js';
import { usePolling } from './usePolling.js';

export interface UseFetchedDataOptions<T> {
  /** URL to fetch. `null` means "disabled" — no fetch, no poll. */
  url: string | null;
  /** Market-hours gate. Recurring tick only fires while truthy. */
  marketOpen: boolean;
  /**
   * Recurring poll cadence in ms. Omit (or pass `undefined`) to do a
   * single fetch on mount / url-change and never poll.
   */
  pollIntervalMs?: number;
  /**
   * When `true`, the hook does ONE fetch on url-change and never polls
   * regardless of `pollIntervalMs`. Used by consumers that browse a
   * historical date — the snapshot is static, polling would just burn
   * network on identical responses.
   */
  historical?: boolean;
  /**
   * Convert the raw JSON response into `T`. Stashed in a ref so callers
   * can pass inline closures without retriggering the fetch effect.
   * Default: identity cast (`raw as T`).
   */
  parse?: (raw: unknown) => T;
}

export interface UseFetchedDataResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Cancel any in-flight request and fire a fresh fetch. */
  refresh: () => void;
  /**
   * Epoch-ms timestamp of the last successful fetch, or `null`.
   *
   * **Convention:** this primitive uses `Date.now()` (client wall-clock
   * at fetch-success). Hooks fetching cron-prepared data (`useFuturesData`,
   * `useDarkPoolLevels`) intentionally diverge — they parse the server's
   * ISO timestamp so consumers see "data age from when the server
   * prepared it" rather than "from when this client polled." Both
   * patterns produce `number | null` epoch ms; the per-hook doc comment
   * states which semantic applies.
   */
  fetchedAt: number | null;
}

interface State<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
}

const INITIAL: State<unknown> = {
  data: null,
  loading: false,
  error: null,
  fetchedAt: null,
};

function defaultParse<T>(raw: unknown): T {
  return raw as T;
}

export function useFetchedData<T>({
  url,
  marketOpen,
  pollIntervalMs,
  historical = false,
  parse = defaultParse,
}: UseFetchedDataOptions<T>): UseFetchedDataResult<T> {
  const [state, setState] = useState<State<T>>(INITIAL as State<T>);
  const abortRef = useRef<AbortController | null>(null);

  // Stash parse in a ref so callers can pass inline closures without
  // retriggering the eager-fetch effect. The fetch callback reads the
  // latest parser via ref.
  const parseRef = useRef(parse);
  parseRef.current = parse;

  const fetchOnce = useCallback(async () => {
    if (url == null) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const res = await fetch(url, {
        credentials: 'include',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw: unknown = await res.json();
      if (ctrl.signal.aborted) return;
      const parsed = parseRef.current(raw);
      setState({
        data: parsed,
        loading: false,
        error: null,
        fetchedAt: Date.now(),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (ctrl.signal.aborted) return;
      setState((prev) => ({
        ...prev,
        loading: false,
        error: getErrorMessage(err),
      }));
    }
  }, [url]);

  // Eager fetch on mount / url change. usePolling only schedules the
  // recurring tick.
  useEffect(() => {
    if (url == null) return;
    void fetchOnce();
  }, [fetchOnce, url]);

  // Recurring poll. Only ticks when every gate is truthy:
  //   - pollIntervalMs is set (consumer wants polling)
  //   - not historical (browsing a static past snapshot)
  //   - url != null (hook isn't disabled)
  //   - marketOpen (we're in the polling window)
  // When `pollIntervalMs` is undefined, the cadence value passed is
  // arbitrary (60_000 — just so we satisfy the number type); the
  // `shouldPoll` gate keeps the interval from ever firing.
  const shouldPoll = pollIntervalMs != null && !historical && url != null;
  usePolling(() => void fetchOnce(), pollIntervalMs ?? 60_000, [
    shouldPoll,
    marketOpen,
  ]);

  // Unmount cancel.
  useEffect(() => () => abortRef.current?.abort(), []);

  return useMemo(
    () => ({
      data: state.data,
      loading: state.loading,
      error: state.error,
      refresh: fetchOnce,
      fetchedAt: state.fetchedAt,
    }),
    [state, fetchOnce],
  );
}

/**
 * Drop a stale cross-day response. `useFetchedData` is stale-while-
 * revalidate: when the requested `date` changes (e.g. the Central-midnight
 * auto-roll, or a manual date pick) it retains the PRIOR day's response
 * until the new fetch resolves. Every feed/ticker-count response echoes the
 * requested day in `data.date`; this nulls `data` when that echo doesn't
 * match `requestedDate`, so the brief window surfaces as "not yet loaded"
 * (spinner/empty) instead of yesterday's rows/counts/totals under today's
 * date. Resolving it here — once, at the data layer — keeps every derived
 * value (rows, total, hasMore, offset, ticker counts) coherent and prevents
 * a never-vanish union from ingesting cross-day rows.
 */
export function gateResponseToDate<T extends { date: string }>(
  result: UseFetchedDataResult<T>,
  requestedDate: string,
): UseFetchedDataResult<T> {
  if (result.data != null && result.data.date !== requestedDate) {
    return { ...result, data: null };
  }
  return result;
}
