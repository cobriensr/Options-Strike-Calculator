/**
 * usePeriscopeLotteryFeed — fetches /api/periscope-lottery-feed and
 * polls every 60s during market hours (matches the Periscope 10-min
 * publish cadence and the detect-cron's 5-min schedule).
 *
 * Mirrors the polling shape of useSilentBoomFeed / useLotteryFinder.
 * Historical dates are static — polling is skipped when `date` is in
 * the past so we don't churn requests for sealed days.
 *
 * Spec: docs/superpowers/specs/periscope-lottery-alerts-2026-05-19.md
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants/index.js';
import type {
  LotteryFireTypeFilter,
  PeriscopeLotteryFire,
} from '../components/PeriscopeLottery/types.js';
import { getErrorMessage } from '../utils/error.js';
import { usePolling } from './usePolling.js';

interface UsePeriscopeLotteryFeedArgs {
  /** YYYY-MM-DD (ET) — `today` in the panel, can also be a historical date. */
  date: string;
  marketOpen: boolean;
  /** When true, date is in the past — skip polling. */
  historical?: boolean;
  /** 'both' (default) returns calls + puts mixed; the panel filters
   *  per-side client-side rather than making two requests. */
  fireType?: LotteryFireTypeFilter;
  /** Server clamps to [1, 500]; UI defaults to 50. */
  limit?: number;
}

interface State {
  fires: PeriscopeLotteryFire[];
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
}

const INITIAL_STATE: State = {
  fires: [],
  loading: true,
  error: null,
  fetchedAt: null,
};

// ── Validation ─────────────────────────────────────────────
// Mirrors the `validateSpike` pattern in useVegaSpikes: each fire row is
// validated individually (a malformed row is dropped, never fatal), while a
// payload whose envelope doesn't match — `{}`, an HTML error body parsed
// loosely, a 5xx JSON blob — throws into the existing catch and surfaces as
// a stable error state. Without this the hook stored `undefined` as `fires`
// and the panel's `fires.filter(...)` crashed into its ErrorBoundary.

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * `null` and `undefined` coalesce per the optional-props policy (both mean
 * "no value"); anything else must be a finite number.
 */
function isNullishOrFiniteNumber(v: unknown): v is number | null | undefined {
  return v == null || isFiniteNumber(v);
}

function isNullishOrString(v: unknown): v is string | null | undefined {
  return v == null || typeof v === 'string';
}

/**
 * Validate one fire row from `fires`. Returns the typed fire on success
 * (nullish nullable fields normalized to `null`) or `null` on any
 * field-shape mismatch — the caller drops it so one bad row can't poison
 * the whole feed.
 */
function validateLotteryFire(raw: unknown): PeriscopeLotteryFire | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    !isFiniteNumber(r.id) ||
    (r.fireType !== 'call_lottery' && r.fireType !== 'put_lottery') ||
    typeof r.fireTime !== 'string' ||
    typeof r.expiry !== 'string' ||
    !isFiniteNumber(r.eventStrike) ||
    !isFiniteNumber(r.tradeStrike) ||
    !isFiniteNumber(r.spotAtEvent) ||
    !isFiniteNumber(r.strikeDist) ||
    !isFiniteNumber(r.greekPost) ||
    !isFiniteNumber(r.greekDelta) ||
    !isNullishOrFiniteNumber(r.greekLvlRank) ||
    !isNullishOrFiniteNumber(r.greekChgRank) ||
    !isNullishOrFiniteNumber(r.gexDollars) ||
    !isNullishOrFiniteNumber(r.callRatio) ||
    !isNullishOrFiniteNumber(r.qqqNetPremBalance30m) ||
    !isNullishOrFiniteNumber(r.entryPx) ||
    !isNullishOrFiniteNumber(r.vix) ||
    typeof r.v3StrictPass !== 'boolean' ||
    typeof r.v4Badge !== 'boolean' ||
    !isNullishOrFiniteNumber(r.peakPx) ||
    !isNullishOrFiniteNumber(r.peakPct) ||
    !isNullishOrString(r.peakTime) ||
    !isNullishOrFiniteNumber(r.eodClosePx) ||
    !isNullishOrFiniteNumber(r.realizedRPeak) ||
    !isNullishOrFiniteNumber(r.realizedREod) ||
    typeof r.outcomeLocked !== 'boolean' ||
    typeof r.createdAt !== 'string'
  ) {
    return null;
  }
  return {
    id: r.id,
    fireType: r.fireType,
    fireTime: r.fireTime,
    expiry: r.expiry,
    eventStrike: r.eventStrike,
    tradeStrike: r.tradeStrike,
    spotAtEvent: r.spotAtEvent,
    strikeDist: r.strikeDist,
    greekPost: r.greekPost,
    greekDelta: r.greekDelta,
    greekLvlRank: r.greekLvlRank ?? null,
    greekChgRank: r.greekChgRank ?? null,
    gexDollars: r.gexDollars ?? null,
    callRatio: r.callRatio ?? null,
    qqqNetPremBalance30m: r.qqqNetPremBalance30m ?? null,
    entryPx: r.entryPx ?? null,
    vix: r.vix ?? null,
    v3StrictPass: r.v3StrictPass,
    v4Badge: r.v4Badge,
    peakPx: r.peakPx ?? null,
    peakPct: r.peakPct ?? null,
    peakTime: r.peakTime ?? null,
    eodClosePx: r.eodClosePx ?? null,
    realizedRPeak: r.realizedRPeak ?? null,
    realizedREod: r.realizedREod ?? null,
    outcomeLocked: r.outcomeLocked,
    createdAt: r.createdAt,
  };
}

/**
 * Validate the feed envelope and return the validated fires (malformed
 * rows dropped). Throws on a shapeless envelope so the caller's existing
 * catch turns it into the normal error state.
 */
function parseFeedFires(raw: unknown): PeriscopeLotteryFire[] {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !Array.isArray((raw as Record<string, unknown>).fires)
  ) {
    throw new Error('unexpected response shape');
  }
  const rawFires = (raw as Record<string, unknown>).fires as unknown[];
  const fires: PeriscopeLotteryFire[] = [];
  for (const rawFire of rawFires) {
    const fire = validateLotteryFire(rawFire);
    if (fire) fires.push(fire);
  }
  return fires;
}

export function usePeriscopeLotteryFeed({
  date,
  marketOpen,
  historical = false,
  fireType = 'both',
  limit = 50,
}: UsePeriscopeLotteryFeedArgs): State & { refresh: () => void } {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const params = new URLSearchParams({
        date,
        fire_type: fireType,
        limit: String(limit),
      });
      const res = await fetch(
        `/api/periscope-lottery-feed?${params.toString()}`,
        {
          credentials: 'include',
          signal: ctrl.signal,
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw: unknown = await res.json();
      if (ctrl.signal.aborted) return;
      const fires = parseFeedFires(raw);
      setState({
        fires,
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
  }, [date, fireType, limit]);

  // Eager fetch on mount / arg change. usePolling only schedules the
  // recurring tick.
  useEffect(() => {
    fetchOnce();
  }, [fetchOnce]);

  usePolling(fetchOnce, POLL_INTERVALS.PERISCOPE, [marketOpen, !historical]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return useMemo(() => ({ ...state, refresh: fetchOnce }), [state, fetchOnce]);
}
