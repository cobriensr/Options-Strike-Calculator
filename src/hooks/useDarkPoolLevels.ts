/**
 * useDarkPoolLevels — polls /api/darkpool-levels every 60 seconds.
 *
 * Returns dark pool strike levels for the DarkPoolLevels widget.
 * Owner-only — skips polling for public visitors.
 *
 * Effect dispatch (in priority order):
 *   1. Not owner          → no fetch.
 *   2. Past date          → one-shot fetch for that date, no polling.
 *   3. Today, market open → fetch + poll every POLL_INTERVALS.DARK_POOL.
 *   4. Today, market closed → one-shot fetch (BACKTEST view of today).
 *
 * IMPORTANT: The `scrubTime` state is the hook's own internal time-scrubber
 * for historical browsing. It is NOT coupled to the app's time picker —
 * doing so caused the "panel appears frozen" bug because polling refetched
 * the same stale snapshot every cycle while the displayed `fetchedAt` never
 * advanced. Only the user's explicit scrubPrev/scrubNext actions set scrubTime.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { checkIsOwner } from '../utils/auth';
import { useTimeGridScrubber } from './useTimeGridScrubber';
import { getETToday } from '../utils/timezone';
import { usePolling } from './usePolling';

/**
 * Number of consecutive poll failures before the error banner surfaces.
 * Same pattern as useGexStrikeExpiry + useGexTarget: a single transient
 * Neon hang shouldn't flash a red banner on every blip.
 */
const FAIL_GRACE_COUNT = 2;

export type DarkPoolSymbol = 'SPX' | 'NDX' | 'SPY' | 'QQQ';

export const DARK_POOL_SYMBOLS: readonly DarkPoolSymbol[] = [
  'SPX',
  'NDX',
  'SPY',
  'QQQ',
];

export interface DarkPoolLevel {
  /** Index-equivalent or native price level depending on selected symbol. */
  level: number;
  totalPremium: number;
  tradeCount: number;
  totalShares: number;
  latestTime: string | null;
  updatedAt: string;
}

export interface UseDarkPoolLevelsReturn {
  levels: DarkPoolLevel[];
  loading: boolean;
  error: string | null;
  /**
   * Epoch milliseconds derived from the server's freshness timestamp.
   * Preference order, matching the legacy `updatedAt` semantics:
   *   1. `data.meta.lastUpdated` (MAX(updated_at) across all rows) — the
   *      cron's actual last successful write, ISO string.
   *   2. `data.levels[0].updatedAt` (top row's row-level timestamp) — only
   *      used when meta is absent; ISO string from a per-row payload field.
   * Both branches parse via Date.parse and coerce non-finite to null.
   */
  fetchedAt: number | null;
  refresh: () => void;
  // Symbol selector
  selectedSymbol: DarkPoolSymbol;
  setSelectedSymbol: (s: DarkPoolSymbol) => void;
  // Date & time scrubbing
  selectedDate: string;
  setSelectedDate: (d: string) => void;
  scrubTime: string | null;
  isLive: boolean;
  isScrubbed: boolean;
  canScrubPrev: boolean;
  canScrubNext: boolean;
  scrubPrev: () => void;
  scrubNext: () => void;
  /** Jump directly to a specific HH:MM time slot. */
  scrubTo: (time: string) => void;
  /** All available HH:MM time slots for the trading session. */
  timeGrid: readonly string[];
  scrubLive: () => void;
}

// ── Hook ────────────────────────────────────────────────────────────

export function useDarkPoolLevels(
  marketOpen: boolean,
): UseDarkPoolLevelsReturn {
  const isOwner = checkIsOwner();
  const [levels, setLevels] = useState<DarkPoolLevel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const mountedRef = useRef(true);

  // Own date state — decoupled from the app's vix.selectedDate so that
  // browsing dark pool history doesn't re-anchor the Black-Scholes math.
  const [selectedDate, setSelectedDate] = useState(getETToday);

  // Symbol selector — defaults to SPX for backward compat with the
  // pre-multi-symbol UX. NDX/SPY/QQQ require the daemon to be writing
  // dark_pool_prints; until then those views show empty (no fallback).
  const [selectedSymbol, setSelectedSymbol] = useState<DarkPoolSymbol>('SPX');

  // Time scrubber: null = live (no ?time= param), HH:MM = scrubbed.
  // The shared `useTimeGridScrubber` owns navigation; per-feature `isLive`
  // policy stays here because it depends on `isToday`.
  const {
    scrubTime,
    isScrubbed,
    scrubLive,
    canScrubPrev,
    canScrubNext,
    scrubPrev,
    scrubNext,
    scrubTo,
    timeGrid,
  } = useTimeGridScrubber();

  // Recompute each render so the today-vs-past branch flips at midnight ET.
  const isToday = selectedDate === getETToday();

  const isLive = isToday && scrubTime === null;

  // Consecutive failure counter. Single transient Neon hang shouldn't
  // flash "signal timed out" on the dark pool panel. Same pattern as
  // useGexStrikeExpiry + useGexTarget.
  const failCountRef = useRef(0);
  // Cancels any in-flight request on rerun / unmount so a stale response
  // can't clobber a newer fetch's state and the browser stops the
  // bandwidth burn on rapid date/symbol/scrub changes.
  const abortRef = useRef<AbortController | null>(null);

  const fetchLevels = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const qs = new URLSearchParams();
      qs.set('date', selectedDate);
      qs.set('symbol', selectedSymbol);
      if (scrubTime) qs.set('time', scrubTime);
      const res = await fetch(`/api/darkpool-levels?${qs}`, {
        credentials: 'same-origin',
        // 30s covers ~p95 of API latency. 5s was too tight against
        // Neon's intermittent serverless HTTP cold-connection hangs.
        signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(30_000)]),
      });

      if (!mountedRef.current) return;
      // Superseded by a newer fetch between resolve and parse — bail
      // before clobbering newer state or touching the fail counter.
      if (ctrl.signal.aborted) return;

      if (!res.ok) {
        // 401 is the owner check — silently swallow.
        if (res.status === 401) {
          failCountRef.current = 0;
          return;
        }
        failCountRef.current += 1;
        if (failCountRef.current >= FAIL_GRACE_COUNT) {
          setError('Failed to load dark pool data');
        }
        return;
      }

      const data = (await res.json()) as {
        levels: DarkPoolLevel[];
        date: string;
        meta?: { lastUpdated: string | null };
      };

      if (!mountedRef.current) return;
      if (ctrl.signal.aborted) return;

      setLevels(data.levels);
      failCountRef.current = 0;
      setError(null);

      // Convert the chosen ISO timestamp into canonical epoch ms.
      // Preference: meta.lastUpdated (cron's MAX(updated_at) — never stale
      // when any row was written) > levels[0].updatedAt (legacy fallback
      // when the server omits meta). Date.parse yields NaN on bad input;
      // coerce via Number.isFinite so consumers can show a clean empty
      // state instead of a NaN-flavored timestamp.
      const sourceIso = data.meta?.lastUpdated ?? data.levels[0]?.updatedAt;
      if (sourceIso != null) {
        const parsed = Date.parse(sourceIso);
        setFetchedAt(Number.isFinite(parsed) ? parsed : null);
      }
    } catch (err) {
      // Aborts are intentional cancellations — don't count toward the
      // FAIL_GRACE_COUNT or flip the error banner.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (ctrl.signal.aborted) return;
      if (!mountedRef.current) return;
      failCountRef.current += 1;
      if (failCountRef.current >= FAIL_GRACE_COUNT) {
        setError(getErrorMessage(err));
      }
    } finally {
      // Only clear loading if this fetch wasn't superseded — a newer
      // fetch owns loading=true until it itself resolves.
      if (mountedRef.current && abortRef.current === ctrl) setLoading(false);
    }
  }, [selectedDate, selectedSymbol, scrubTime]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset scrub time when the date OR symbol changes so the view always
  // starts live for the newly selected combination.
  useEffect(() => {
    scrubLive();
  }, [selectedDate, selectedSymbol, scrubLive]);

  // Branched eager-fetch effect: chooses between no-fetch / one-shot /
  // initial-fetch-then-poll based on owner + date + scrub + market-open.
  // The recurring poll is handled by `usePolling` below; this effect
  // covers everything else (loading-state side-effects and the eager
  // first fetch for branches 2-4).
  useEffect(() => {
    if (!isOwner) {
      setLoading(false);
      return;
    }
    if (!isToday || isScrubbed) {
      // Past date or scrubbed: fetch once — the snapshot is static.
      setLoading(true);
      void fetchLevels();
      return;
    }
    if (!marketOpen) {
      // Today, market closed: one-shot fetch — no fresh data being produced.
      setLoading(true);
      void fetchLevels();
      return;
    }
    // Today, live, market open → eager fetch; recurring poll handled below.
    void fetchLevels();
  }, [isOwner, marketOpen, isToday, isScrubbed, fetchLevels]);

  // Recurring poll only fires in branch 4 (today, live, market open).
  // Every other branch keeps its return-early-after-fetch behavior via
  // the effect above.
  usePolling(() => void fetchLevels(), POLL_INTERVALS.DARK_POOL, [
    isOwner,
    isToday,
    !isScrubbed,
    marketOpen,
  ]);

  // ── Explicit refresh ─────────────────────────────────────────────

  const refresh = useCallback(() => {
    setLoading(true);
    void fetchLevels();
  }, [fetchLevels]);

  // Cancel any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Stabilize the returned object's identity so a parent `useMemo` keyed on
  // this hook's return value holds across polls when no field changed. Every
  // field below is either a primitive, a stable useState value/setter, or a
  // stable useCallback (refresh + all scrubber fns), and `timeGrid` is the
  // module-level `TIME_GRID` constant — so this memo only recomputes when a
  // value genuinely changes, not on every render.
  return useMemo(
    () => ({
      levels,
      loading,
      error,
      fetchedAt,
      refresh,
      selectedSymbol,
      setSelectedSymbol,
      selectedDate,
      setSelectedDate,
      scrubTime,
      isLive,
      isScrubbed,
      canScrubPrev,
      canScrubNext,
      scrubPrev,
      scrubNext,
      scrubTo,
      timeGrid,
      scrubLive,
    }),
    [
      levels,
      loading,
      error,
      fetchedAt,
      refresh,
      selectedSymbol,
      setSelectedSymbol,
      selectedDate,
      setSelectedDate,
      scrubTime,
      isLive,
      isScrubbed,
      canScrubPrev,
      canScrubNext,
      scrubPrev,
      scrubNext,
      scrubTo,
      timeGrid,
      scrubLive,
    ],
  );
}
