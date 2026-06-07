/**
 * useRegime0dte — polls /api/regime-0dte during the 08:30–15:00 CT regular
 * session so the "0DTE Gamma Regime" panel updates as the gamma gate sets,
 * the IV surface breaks, and the down-only triggers latch through the day.
 *
 * Outside the session window the hook does not fetch — it returns the last
 * known state (from localStorage, if any) and reports `isWindowOpen=false`
 * so the panel can show a "waiting for open" placeholder.
 *
 * Persistence: after every successful fetch we mirror the payload into a
 * single last-good localStorage slot (`regime0dte:lastgood`). The cache
 * survives transient Neon blips (the fetch errors, but `displayData` falls
 * back to the cached payload) and CT-date rollovers (only a fresh successful
 * fetch overwrites it).
 *
 * `displayData` is what the UI should render. It prefers the fresh fetch
 * result (`data`) and falls back to the last-good cache.
 *
 * Mirrors `src/hooks/useOpeningFlowSignal.ts` (live-only — no historical
 * date mode; the panel is intraday-only for v1).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants/index.js';
import { getCTTime } from '../utils/timezone.js';
import { getErrorMessage } from '../utils/error.js';
import { usePolling } from './usePolling.js';

export type Gate = 'calm' | 'big_move' | 'lean_down' | 'unknown';

export interface TriggerState {
  fired: boolean;
  atCtMin: number | null;
}

export interface Regime0dteTriggers {
  mostlyRed: TriggerState & { green: number; red: number };
  ivBreak: TriggerState & { magPct: number | null; refHi: number | null };
  middayDeepNeg: TriggerState & { gexMid: number | null };
}

/**
 * The GET /api/regime-0dte response shape. Mirrors `Regime0dteState` from
 * `api/_lib/regime-0dte.ts` (the endpoint spreads `{ date, ...state }`).
 * Defined locally — `src/` does not import api types directly, matching the
 * repo's frontend/backend boundary convention.
 */
export interface Regime0dteResponse {
  date: string;
  asOfCtMin: number;
  gate: Gate;
  gexNearSpot: number | null;
  gexAtOpen: number | null;
  flipStrike: number | null;
  flipMinusOpenPct: number | null;
  triggers: Regime0dteTriggers;
  note: string;
  /**
   * Raw series for the rich panel visuals. Optional so a stale last-good
   * cache written before Phase 3B (graded scalars only) still type-checks.
   */
  gexStrikes?: { strike: number; netGex: number }[];
  spot?: number | null;
  putIv?: { ctMin: number; iv: number }[];
  candles30?: { ctMin: number; open: number; close: number }[];
  bandPct?: number;
  persistEndCtMin?: number;
}

interface State {
  data: Regime0dteResponse | null;
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
}

const INITIAL_STATE: State = {
  data: null,
  loading: false,
  error: null,
  fetchedAt: null,
};

const STORAGE_KEY = 'regime0dte:lastgood';

interface CachedEntry {
  data: Regime0dteResponse;
  savedAt: string;
  date: string;
}

function safeReadCache(): CachedEntry | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as Partial<CachedEntry>;
    if (
      parsed == null ||
      typeof parsed.date !== 'string' ||
      typeof parsed.savedAt !== 'string' ||
      parsed.data == null
    ) {
      return null;
    }
    return parsed as CachedEntry;
  } catch {
    return null;
  }
}

function safeWriteCache(entry: CachedEntry): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // swallow: storage quota / private-mode / disabled
  }
}

function loadCache(): Regime0dteResponse | null {
  return safeReadCache()?.data ?? null;
}

/**
 * Polling-window predicate. True during the 08:30–15:00 CT regular session
 * (the window over which the gamma gate, IV-break, and candle triggers are
 * meaningful). Outside this window the hook stops fetching.
 */
function inPollingWindow(now: Date): boolean {
  const { hour, minute } = getCTTime(now);
  const totalMinutes = hour * 60 + minute;
  const windowOpen = 8 * 60 + 30; // 08:30 CT
  const windowClose = 15 * 60; // 15:00 CT
  return totalMinutes >= windowOpen && totalMinutes < windowClose;
}

export function useRegime0dte(): State & {
  refresh: () => void;
  isWindowOpen: boolean;
  displayData: Regime0dteResponse | null;
} {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const [cachedData, setCachedData] = useState<Regime0dteResponse | null>(() =>
    loadCache(),
  );
  const [isWindowOpen, setIsWindowOpen] = useState<boolean>(() =>
    inPollingWindow(new Date()),
  );
  const abortRef = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const res = await fetch('/api/regime-0dte', {
        credentials: 'include',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as Regime0dteResponse;

      if (ctrl.signal.aborted) return;
      setState({
        data: json,
        loading: false,
        error: null,
        fetchedAt: Date.now(),
      });
      safeWriteCache({
        data: json,
        savedAt: new Date().toISOString(),
        date: json.date,
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
  }, []);

  // Eager fetch on mount — but only when the session window is open. Outside
  // the window we leave the panel on its last-good cache (or empty) and never
  // hit the origin. This differs from useOpeningFlowSignal, whose 25-min
  // window justifies an always-on mount fetch; the 6.5-hour session here does
  // not, and the spec wants a hard "waiting for open" gate outside RTH.
  useEffect(() => {
    const open = inPollingWindow(new Date());
    setIsWindowOpen(open);
    if (open) void fetchOnce();
  }, [fetchOnce]);

  // Polling. Tick every 45s to (a) re-check the window predicate and (b)
  // refetch when inside the window. We keep ticking outside the window to
  // notice when it opens, but skip the recurring fetch.
  const tick = useCallback(() => {
    const open = inPollingWindow(new Date());
    setIsWindowOpen(open);
    if (open) void fetchOnce();
  }, [fetchOnce]);
  usePolling(tick, POLL_INTERVALS.REGIME_0DTE, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const displayData = state.data ?? cachedData;

  return useMemo(
    () => ({
      ...state,
      refresh: fetchOnce,
      isWindowOpen,
      displayData,
    }),
    [state, fetchOnce, isWindowOpen, displayData],
  );
}
