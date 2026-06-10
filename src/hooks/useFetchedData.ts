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
  /**
   * Cross-request staleness gate (generic; the primitive stays date-agnostic).
   * When BOTH are provided, the returned `data` is nulled while the currently
   * held response's key does not match the in-flight request key. This drops a
   * stale-while-revalidate response retained from a PRIOR request key (e.g. a
   * prior trading day) so consumers never see yesterday's data under today's
   * key — and a never-vanish union never ingests cross-day rows.
   *
   * Passthrough-safe: if `responseKey(data)` returns null/undefined (e.g. the
   * server dropped the field) the data is NOT nulled — it degrades to the
   * pre-gate behavior rather than permanently blanking. Dated feeds pass
   * `requestKey: date` and `responseKey: (d) => d.date?.slice(0, 10)`, so an
   * ISO-formatted echo (YYYY-MM-DDT..) still matches the YYYY-MM-DD request.
   *
   * NOTE: a separate localStorage last-good cross-day guard exists in
   * usePolledWindowSignal (different storage semantics); the two are
   * intentionally distinct.
   */
  requestKey?: string;
  responseKey?: (data: T) => string | null | undefined;
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
  requestKey,
  responseKey,
}: UseFetchedDataOptions<T>): UseFetchedDataResult<T> {
  const [state, setState] = useState<State<T>>(INITIAL as State<T>);
  const abortRef = useRef<AbortController | null>(null);

  // Stash parse in a ref so callers can pass inline closures without
  // retriggering the eager-fetch effect. The fetch callback reads the
  // latest parser via ref.
  const parseRef = useRef(parse);
  parseRef.current = parse;

  // Stash the staleness-key extractor in a ref so an inline closure
  // doesn't churn the gated-data memo deps (mirror of `parseRef`).
  const responseKeyRef = useRef(responseKey);
  responseKeyRef.current = responseKey;

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

  // Cross-request staleness gate. When `requestKey`/`responseKey` are both
  // provided, null the held data while its key doesn't match the in-flight
  // request key (stale-while-revalidate window after a key flip). When the
  // response key is null/undefined (server dropped the field) we pass the
  // data through — degrade, never permanently blank. On the match / no-gate
  // path `gatedData === state.data`, so referential stability is preserved
  // for the common case.
  const gatedData = useMemo(() => {
    const d = state.data;
    if (d == null) return null;
    const rk = responseKeyRef.current;
    if (requestKey == null || rk == null) return d;
    const k = rk(d);
    return k != null && k !== requestKey ? null : d;
  }, [state.data, requestKey]);

  return useMemo(
    () => ({
      data: gatedData,
      loading: state.loading,
      error: state.error,
      refresh: fetchOnce,
      fetchedAt: state.fetchedAt,
    }),
    [gatedData, state.loading, state.error, state.fetchedAt, fetchOnce],
  );
}
