/**
 * useZeroGamma — fetches zero-gamma data for one ticker, optionally
 * scoped to a specific calendar date for historical scrubbing.
 *
 * Live mode (no date arg): polls /api/zero-gamma?ticker=X every
 * POLL_INTERVALS.ZERO_GAMMA during market hours. Returns the latest
 * snapshot plus the most recent 100 rows.
 *
 * Date mode (date='YYYY-MM-DD'): one-shot fetch of all snapshots for
 * that calendar day (no polling — the past doesn't change). `latest`
 * is the last snapshot of the day.
 *
 * Owner-or-guest: matches the API endpoint's auth tier
 * (guardOwnerOrGuestEndpoint). Public visitors get 401 and the hook
 * stays idle.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { getAccessMode } from '../utils/auth';
import { usePolling } from './usePolling';

export interface ZeroGammaRow {
  ticker: string;
  spot: number;
  zeroGamma: number | null;
  confidence: number | null;
  netGammaAtSpot: number | null;
  gammaCurve: unknown;
  ts: string;
}

export interface UseZeroGammaReturn {
  latest: ZeroGammaRow | null;
  history: ZeroGammaRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

interface ApiResponse {
  latest: ZeroGammaRow | null;
  history: ZeroGammaRow[];
}

// ── Validation ─────────────────────────────────────────────
//
// Row-level validation at the parse (client-shape-hardening-2026-08-20,
// follow-up sweep). The previous `(await res.json()) as ApiResponse`
// identity cast handed `latest` / `history` straight to TickerCard,
// which died two ways:
//   - `latest` a shapeless object → "Cannot read properties of undefined
//     (reading 'toLocaleString')" in TickerCard's `fmtNumber(spot)`
//   - a null/garbage history element → "Cannot read properties of null
//     (reading 'ts')" in the sparkline's `.sort()` comparator
// Invalid history rows are now dropped and an invalid `latest` degrades
// to null (the "No data yet" state the card already renders). An invalid
// envelope takes the hook's existing non-2xx path: set `error`, keep the
// last-known-good rows.
//
// Field policy, checked against api/zero-gamma.ts `mapRow` and the
// `zero_gamma_levels` DDL (migration 82):
//   REQUIRED  ticker (TEXT NOT NULL), ts (TIMESTAMPTZ NOT NULL → `toIso`
//             always yields a string, and the sparkline sorts on it),
//             spot (NUMERIC NOT NULL → `Number(...)` always finite, and
//             it is both plotted and formatted unguarded)
//   DEGRADED  zeroGamma / confidence / netGammaAtSpot — nullable columns
//             run through `parseNumOrNull`, so non-finite → null
//   PASSTHRU  gammaCurve — a JSONB column typed `unknown` here; it is
//             deliberately NOT shape-checked, since any JSON value
//             (including null) is legitimate

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Nullable numeric column: finite number passes through, else null. */
function toNullableNumber(v: unknown): number | null {
  return isFiniteNumber(v) ? v : null;
}

function validateRow(raw: unknown): ZeroGammaRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.ticker !== 'string' ||
    typeof r.ts !== 'string' ||
    !isFiniteNumber(r.spot)
  ) {
    return null;
  }
  return {
    ticker: r.ticker,
    spot: r.spot,
    zeroGamma: toNullableNumber(r.zeroGamma),
    confidence: toNullableNumber(r.confidence),
    netGammaAtSpot: toNullableNumber(r.netGammaAtSpot),
    gammaCurve: r.gammaCurve,
    ts: r.ts,
  };
}

/**
 * Validate the full envelope. Returns the typed response on success, or
 * `null` when the body is not an object or `history` is not an array —
 * the caller turns that into the hook's error path. A malformed `latest`
 * degrades to null rather than failing the envelope, because `latest:
 * null` is a legitimate server state (no rows for the ticker yet).
 */
function validateZeroGammaResponse(raw: unknown): ApiResponse | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.history)) return null;

  const history: ZeroGammaRow[] = [];
  for (const candidate of r.history) {
    const row = validateRow(candidate);
    if (row) history.push(row);
  }
  return { latest: validateRow(r.latest), history };
}

export function useZeroGamma(
  ticker: string,
  marketOpen: boolean,
  date: string | null = null,
): UseZeroGammaReturn {
  const accessMode = getAccessMode();
  const [latest, setLatest] = useState<ZeroGammaRow | null>(null);
  const [history, setHistory] = useState<ZeroGammaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // Cancels any in-flight request on rerun / unmount so a stale response
  // can't clobber a newer fetch's state and the browser stops the
  // bandwidth burn on rapid ticker/date changes.
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const qs = new URLSearchParams({ ticker });
      if (date) qs.set('date', date);
      const res = await fetch(`/api/zero-gamma?${qs}`, {
        credentials: 'same-origin',
        signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(5_000)]),
      });

      if (!mountedRef.current) return;
      // Superseded by a newer fetch between resolve and parse — bail.
      if (ctrl.signal.aborted) return;

      if (!res.ok) {
        // 401 for anon visitors is expected and not a user-visible error.
        if (res.status !== 401) setError('Failed to load zero-gamma data');
        return;
      }

      const data = validateZeroGammaResponse(await res.json());
      if (!mountedRef.current) return;
      if (ctrl.signal.aborted) return;

      if (data == null) {
        // Shapeless body ({} / loosely-parsed HTML / 5xx JSON blob) —
        // same treatment as a non-2xx: surface the error, keep whatever
        // rows the cards are already showing.
        setError('Failed to load zero-gamma data');
        return;
      }

      setLatest(data.latest);
      setHistory(data.history);
      setError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (ctrl.signal.aborted) return;
      if (mountedRef.current) setError(getErrorMessage(err));
    } finally {
      // Only clear loading if this fetch wasn't superseded — a newer
      // fetch owns loading=true until it itself resolves.
      if (mountedRef.current && abortRef.current === ctrl) setLoading(false);
    }
  }, [ticker, date]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Eager mount fetch — usePolling only schedules the recurring tick.
  useEffect(() => {
    if (accessMode === 'public') {
      setLoading(false);
      return;
    }

    void fetchData();
  }, [accessMode, fetchData]);

  // Date-scrubbed view is static (the past doesn't change) — no polling.
  usePolling(() => void fetchData(), POLL_INTERVALS.ZERO_GAMMA, [
    accessMode !== 'public',
    marketOpen,
    !date,
  ]);

  const refresh = useCallback(() => {
    setLoading(true);
    void fetchData();
  }, [fetchData]);

  // Cancel any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  return { latest, history, loading, error, refresh };
}
