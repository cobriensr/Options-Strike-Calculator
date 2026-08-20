/**
 * useNopeIntraday — fetches /api/nope-intraday for the PriceChart NOPE overlay.
 *
 * Owner-only. Mirrors the live-polling pattern from useGexTarget but with a
 * smaller surface: no scrub, no modes, no historical date browsing — just
 * "give me today's NOPE points and keep them fresh."
 *
 * Polling cadence matches the fetch-nope cron (every minute during market
 * hours). Outside market hours we keep the last-known points but don't poll.
 *
 * Returns `{ points: [] }` shape even on error so the chart can render the
 * candles unchanged when NOPE is unavailable.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { checkIsOwner } from '../utils/auth';
import { usePolling } from './usePolling';

export interface NopePoint {
  /** ISO 8601 UTC timestamp at minute resolution. */
  timestamp: string;
  /** Latest-delta NOPE score. */
  nope: number;
  /** Fill-delta NOPE score (uses delta at transaction time). */
  nope_fill: number;
}

interface NopeIntradayResponse {
  ticker: string;
  date: string | null;
  availableDates: string[];
  points: NopePoint[];
}

export interface UseNopeIntradayReturn {
  points: NopePoint[];
  date: string | null;
  loading: boolean;
  error: string | null;
}

interface UseNopeIntradayOptions {
  /**
   * Whether the cash session is currently open. Polling only runs while
   * true; outside hours we keep the last-known points and stop fetching.
   */
  marketOpen: boolean;
}

const EMPTY_POINTS: NopePoint[] = [];

// ── Response validation ────────────────────────────────────────
//
// The parse used to be an identity cast, so a shapeless body put a
// non-array into `points` and the PriceChart NOPE overlay died at
// `nopePoints.map` (src/components/GexTarget/PriceChart.tsx:369), while a
// missing `points` key crashed the scrubbed branch at
// `nopePoints.filter` (src/components/GexTarget/index.tsx:145). Both are
// render/effect-phase throws, so they take the whole section's
// ErrorBoundary with them. Validation at the parse (the `validateSpike`
// pattern in src/hooks/useVegaSpikes.ts): bad points are dropped, a bad
// envelope is a no-data error.
//
// Field-for-field mirror of `api/nope-intraday.ts`: `points` is built by
// mapping DB rows through `toIso` + `Number()`, so `timestamp` is always a
// string and `nope` / `nope_fill` are always numbers (a NULL column would
// produce NaN, which serializes as JSON null — rejected here because a NaN
// NOPE value has no meaning on the chart). `points` is present on both of
// the handler's return paths, so requiring it cannot reject a legitimate
// payload.

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function validateNopePoint(raw: unknown): NopePoint | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.timestamp !== 'string' ||
    Number.isNaN(new Date(r.timestamp).getTime()) ||
    !isFiniteNumber(r.nope) ||
    !isFiniteNumber(r.nope_fill)
  ) {
    return null;
  }
  return { timestamp: r.timestamp, nope: r.nope, nope_fill: r.nope_fill };
}

/** The two fields this hook actually reads off the response. */
type ValidatedNopeResponse = Pick<NopeIntradayResponse, 'date' | 'points'>;

function validateNopeResponse(raw: unknown): ValidatedNopeResponse | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.points)) return null;
  const points: NopePoint[] = [];
  for (const row of r.points) {
    const point = validateNopePoint(row);
    if (point) points.push(point);
  }
  return {
    date: typeof r.date === 'string' ? r.date : null,
    // Reuse the module-level constant when nothing survived so repeated
    // failing polls keep a stable reference — PriceChart mirrors
    // `nopePoints` into a setData effect, and a fresh [] each poll would
    // re-fire it forever (the GexLandscape render-loop lesson).
    points: points.length > 0 ? points : EMPTY_POINTS,
  };
}

export function useNopeIntraday({
  marketOpen,
}: UseNopeIntradayOptions): UseNopeIntradayReturn {
  const isOwner = checkIsOwner();
  const [points, setPoints] = useState<NopePoint[]>(EMPTY_POINTS);
  const [date, setDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Avoid setting state after unmount.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchPoints = useCallback(async () => {
    if (!isOwner) return;
    setLoading(true);
    try {
      const res = await fetch('/api/nope-intraday', { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = validateNopeResponse(await res.json());
      if (!mountedRef.current) return;
      if (body == null) {
        // Shapeless envelope. Surface the error and write NO state — the
        // same last-known-good behavior as the network-failure catch below,
        // and the reason a non-array can never reach PriceChart's setData
        // effect. `points` stays at whatever last parsed cleanly (or the
        // module-level EMPTY_POINTS before any successful fetch), so the
        // reference is stable across repeated bad polls.
        setError('Unexpected response shape from NOPE data');
        return;
      }
      setPoints(body.points);
      setDate(body.date);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [isOwner]);

  // Initial fetch when ownership resolves.
  useEffect(() => {
    if (!isOwner) return;
    void fetchPoints();
  }, [isOwner, fetchPoints]);

  // Live polling — only while market is open. Outside hours we keep the
  // last-known points and stop firing requests.
  // 60s cadence matches the fetch-nope cron.
  usePolling(
    () => {
      void fetchPoints();
    },
    POLL_INTERVALS.NOPE,
    [isOwner, marketOpen],
  );

  return { points, date, loading, error };
}
