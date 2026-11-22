/**
 * usePolledWindowSignal — the shared polling-window signal primitive.
 *
 * A panel-signal hook that polls a single endpoint at `pollMs` cadence *only*
 * while a caller-supplied time window is open (e.g. 08:30–15:00 CT), mirrors
 * the last successful payload into a single localStorage "last-good" slot, and
 * exposes a `displayData` that the UI renders.
 *
 * This collapses the previously-forked machinery shared by `useRegime0dte`
 * and (formerly) `useOpeningFlowSignal` into one correct implementation:
 *
 *   - **Staleness guard.** `displayData` is a payload ONLY when its
 *     `date === todayStr()`, whether it came from a fetch or from the cache.
 *     A cache written on a prior session day is ignored for display (and
 *     cleared from storage on read), and a fetched payload from a prior day,
 *     which a tab left open across a weekend still holds in state, is held
 *     but not shown, so a new-session-day pre-first-fetch render, a failed
 *     first fetch, or a Neon blip on a fresh day can't paint yesterday's
 *     payload as live. The check runs each render, so a `todayStr` that
 *     turns (the caller re-renders at its midnight) drops the payload. A 2xx
 *     whose payload is not dated today is reported as an `error` (it names
 *     both dates) rather than hidden in silence, and clears on the first poll
 *     where they agree.
 *
 *   - **Window-gated polling.** The recurring fetch interval is gated on the
 *     window predicate itself (`usePolling(..., [isWindowOpen])`) — it does
 *     NOT tick outside the window. A separate, lightweight once-a-minute
 *     watcher recomputes `isWindowOpen`, and only writes state when the flag
 *     actually flips, so outside the window there is no fetch and no per-tick
 *     setState churn.
 *
 *   - **Fetch when the window opens.** An effect keyed on `isWindowOpen`
 *     fetches whenever the flag is true: once at mount if the window is
 *     already open, and at once when the watcher sees it open (within a
 *     minute of the open), not a poll interval later.
 *
 *   - **Single source of truth for `isWindowOpen`.** The flag is derived from
 *     one watcher; the fetch-on-open effect and the recurring fetch both read
 *     it rather than recomputing the predicate in two places.
 *
 * Persistence semantics: after every successful fetch the payload is mirrored
 * to `storageKey`. On mount the cache is read once; if its `date` matches
 * today it seeds `displayData`, otherwise it is dropped.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getErrorMessage } from '../utils/error.js';
import { usePolling } from './usePolling.js';

/** Any payload carrying an optional `date` (YYYY-MM-DD) for the staleness guard. */
export interface DatedPayload {
  date?: string;
}

export interface PolledWindowSignalState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
}

export interface PolledWindowSignalResult<
  T,
> extends PolledWindowSignalState<T> {
  /**
   * The payload to render: dated today, fetched or cached, else null. `data`
   * and `fetchedAt` are the raw last fetch, not date-checked; only
   * `displayData` is.
   */
  displayData: T | null;
  isWindowOpen: boolean;
  refresh: () => void;
}

export interface PolledWindowSignalOptions {
  /** Endpoint to GET. Sent with `credentials: 'include'`. */
  url: string;
  /** localStorage slot for the single last-good payload. */
  storageKey: string;
  /** Recurring fetch cadence (ms) while the window is open. */
  pollMs: number;
  /** Window predicate — true while the hook should be live-fetching. */
  inWindow: (now: Date) => boolean;
  /**
   * Today's date string (YYYY-MM-DD) — the staleness key. Read in render, so
   * a caller that wants the payload to turn over at midnight must re-render
   * then (read the shared clock, `useETToday`, and return its value).
   */
  todayStr: () => string;
}

/** How often the lightweight window watcher re-checks the predicate. */
const WINDOW_WATCH_MS = 60_000;

interface CachedEntry<T> {
  data: T;
  savedAt: string;
  date: string;
}

function readCache<T extends DatedPayload>(
  storageKey: string,
): CachedEntry<T> | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as Partial<CachedEntry<T>>;
    if (
      parsed == null ||
      typeof parsed.date !== 'string' ||
      typeof parsed.savedAt !== 'string' ||
      parsed.data == null
    ) {
      return null;
    }
    return parsed as CachedEntry<T>;
  } catch {
    return null;
  }
}

function writeCache<T>(storageKey: string, entry: CachedEntry<T>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(storageKey, JSON.stringify(entry));
  } catch {
    // swallow: storage quota / private-mode / disabled
  }
}

function clearCache(storageKey: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // swallow
  }
}

/**
 * Load the cached payload only if it belongs to today. A prior-day cache is
 * dropped (and evicted from storage) so it can never render as live data.
 *
 * See also: network feeds built on `useFetchedData` use the
 * `requestKey`/`responseKey` cross-day gate instead. The two mechanisms are
 * intentionally distinct — this one guards a localStorage last-good cache by
 * comparing against today's date; the feed gate nulls a held network response
 * whose echoed date doesn't match the requested date.
 */
function loadFreshCache<T extends DatedPayload>(
  storageKey: string,
  today: string,
): T | null {
  const cached = readCache<T>(storageKey);
  if (cached == null) return null;
  if (cached.date !== today) {
    clearCache(storageKey);
    return null;
  }
  return cached.data;
}

export function usePolledWindowSignal<T extends DatedPayload>(
  opts: PolledWindowSignalOptions,
): PolledWindowSignalResult<T> {
  // `url` and `storageKey` are read via `optsRef` inside the stable fetch
  // closure; only the render-level config is destructured here.
  const { storageKey, pollMs, inWindow, todayStr } = opts;

  // Keep the latest option callbacks in a ref so the fetch/watch closures stay
  // stable even when the caller passes fresh inline closures each render.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [state, setState] = useState<PolledWindowSignalState<T>>({
    data: null,
    loading: false,
    error: null,
    fetchedAt: null,
  });

  // Cached payload, gated through the staleness guard on first read.
  const [cachedData, setCachedData] = useState<T | null>(() =>
    loadFreshCache<T>(storageKey, todayStr()),
  );

  // Single source of truth for the window-open flag.
  const [isWindowOpen, setIsWindowOpen] = useState<boolean>(() =>
    inWindow(new Date()),
  );

  const abortRef = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async () => {
    const { url: u, storageKey: key } = optsRef.current;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const res = await fetch(u, {
        credentials: 'include',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as T;

      if (ctrl.signal.aborted) return;
      // A 2xx whose payload is not dated today is hidden by the display date
      // check; say so, or the panel would sit on "loading" for as long as the
      // dates disagree (a client clock that lags after sleep, a server on
      // another day). It clears on the first poll where they agree.
      const expected = optsRef.current.todayStr();
      const got = json.date ? `dated ${json.date}` : 'undated';
      setState({
        data: json,
        loading: false,
        error:
          json.date === expected
            ? null
            : `Payload is ${got}, but today is ${expected}`,
        fetchedAt: Date.now(),
      });
      writeCache<T>(key, {
        data: json,
        savedAt: new Date().toISOString(),
        date: json.date ?? '',
      });
      setCachedData(json);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (ctrl.signal.aborted) return;
      setState((prev) => ({
        ...prev,
        loading: false,
        error: getErrorMessage(err),
      }));
    }
    // `url`/`storageKey` are read via optsRef so this stays referentially
    // stable; the effect/poll deps don't churn when callers pass inline opts.
  }, []);

  // Recompute the window flag from the single watcher's predicate and publish
  // it only on a flip.
  const syncWindow = useCallback((): void => {
    const open = optsRef.current.inWindow(new Date());
    setIsWindowOpen((prev) => (prev === open ? prev : open));
  }, []);

  // Fetch whenever the window is open: once at mount if it already is, and at
  // once whenever it opens. Keyed on the flag, not on mount, so the first
  // fetch of a session day is not a poll interval after the open. A mount
  // inside the window is still exactly one fetch. Outside the window we leave
  // the panel on its (today-dated) last-good cache and never hit origin.
  useEffect(() => {
    if (isWindowOpen) void fetchOnce();
  }, [isWindowOpen, fetchOnce]);

  // Lightweight window watcher: re-checks the predicate once a minute and only
  // setStates on a flip. No fetch here — it exists to notice the window
  // opening/closing; the effect above fetches on the open and the gated poll
  // below keeps it fresh.
  usePolling(syncWindow, WINDOW_WATCH_MS, []);

  // Recurring fetch — GATED on the window flag. Outside the window this
  // interval is not scheduled at all (no timers, no fetch, no setState churn).
  usePolling(
    () => {
      void fetchOnce();
    },
    pollMs,
    [isWindowOpen],
  );

  useEffect(() => () => abortRef.current?.abort(), []);

  // Staleness guard for display: a payload is shown only when it is dated
  // today, the fetched one and the cached one alike. A fresh, today-dated fetch
  // wins; otherwise fall back to the cache. A fetched payload from a prior day
  // (a tab left open from Friday's close, a failed first fetch on Monday) is
  // never shown as live: it is held in state, not displayed.
  const today = todayStr();
  const isToday = (d: T | null): d is T => d != null && d.date === today;
  const displayData: T | null = isToday(state.data)
    ? state.data
    : isToday(cachedData)
      ? cachedData
      : null;

  return useMemo(
    () => ({
      ...state,
      displayData,
      isWindowOpen,
      refresh: fetchOnce,
    }),
    [state, displayData, isWindowOpen, fetchOnce],
  );
}
