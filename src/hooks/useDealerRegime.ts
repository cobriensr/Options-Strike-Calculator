/**
 * useDealerRegime — fetches /api/dealer-regime once on mount, then polls
 * every POLL_INTERVALS.DEALER_REGIME during market hours.
 *
 * Live mode (no `date` / no `at`): polls during market hours, picks up
 * fresh rows as the compute-zero-gamma cron writes them.
 *
 * Snapshot mode (`date` and/or `at`): one-shot fetch, no polling — the
 * past doesn't change. Used by the historical scrubber.
 *
 * Public visitors (no owner cookie + no guest token) hit a 401 from the
 * endpoint; the hook treats that as non-fatal — `data === null` and
 * `error === null` so the tile renders an inert placeholder instead of
 * surfacing an authentication error to anonymous viewers.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { getAccessMode } from '../utils/auth';
import { usePolling } from './usePolling';

export interface DealerRegimeRow {
  ticker: 'SPX' | 'SPY' | 'QQQ';
  ts: string;
  spot: number;
  zeroGamma: number | null;
  confidence: number | null;
  netGammaAtSpot: number | null;
}

export interface DealerRegimeResponse {
  date: string | null;
  at: string | null;
  rows: DealerRegimeRow[];
  asOf: string;
}

export interface UseDealerRegimeReturn {
  data: DealerRegimeResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// ── Validation ─────────────────────────────────────────────
//
// Row-level validation at the parse (client-shape-hardening-2026-08-20,
// follow-up sweep). The previous `(await res.json()) as
// DealerRegimeResponse` identity cast let a malformed envelope reach the
// tile's classification loop, which died two ways:
//   - `rows` a non-array object → "object is not iterable" at
//     DealerRegimeTile/index.tsx `for (const r of data.rows)`
//   - a null/garbage element   → "Cannot read properties of null
//     (reading 'ticker')" one line later
// Invalid rows are now dropped; an invalid envelope throws into the
// hook's existing catch, which sets `error` and keeps the last-known-good
// `data` — the same behaviour as a non-2xx response.
//
// Field policy, checked against api/_lib/db-dealer-regime.ts `mapRow`
// and the `zero_gamma_levels` DDL (migration 82):
//   REQUIRED  ticker (TEXT NOT NULL, and the endpoint's WHERE clause
//             restricts it to ZERO_GAMMA_TICKERS = the union below),
//             ts (TIMESTAMPTZ NOT NULL → `toIso` always yields a string),
//             spot (NUMERIC NOT NULL → `Number(...)` always finite)
//   DEGRADED  zeroGamma / confidence / netGammaAtSpot — all nullable
//             columns run through `parseNumOrNull`, so anything that
//             isn't a finite number is normalized to null (the shape
//             `classify` and `Cell` already render as "—" / uncertain)
//   COERCED   date / at — echo the query params and are absent entirely
//             when unset; asOf is informational and unread by the tile

const DEALER_REGIME_TICKERS: readonly DealerRegimeRow['ticker'][] = [
  'SPX',
  'SPY',
  'QQQ',
];

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Nullable numeric column: finite number passes through, else null. */
function toNullableNumber(v: unknown): number | null {
  return isFiniteNumber(v) ? v : null;
}

function isDealerRegimeTicker(v: unknown): v is DealerRegimeRow['ticker'] {
  return (DEALER_REGIME_TICKERS as readonly unknown[]).includes(v);
}

function validateRow(raw: unknown): DealerRegimeRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    !isDealerRegimeTicker(r.ticker) ||
    typeof r.ts !== 'string' ||
    !isFiniteNumber(r.spot)
  ) {
    return null;
  }
  return {
    ticker: r.ticker,
    ts: r.ts,
    spot: r.spot,
    zeroGamma: toNullableNumber(r.zeroGamma),
    confidence: toNullableNumber(r.confidence),
    netGammaAtSpot: toNullableNumber(r.netGammaAtSpot),
  };
}

/**
 * Validate the full envelope. Returns the typed response on success, or
 * `null` when the body is not an object or `rows` is not an array — the
 * caller turns that into the hook's error path. Invalid rows are
 * dropped, never fatal.
 */
function validateDealerRegimeResponse(
  raw: unknown,
): DealerRegimeResponse | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.rows)) return null;

  const rows: DealerRegimeRow[] = [];
  for (const candidate of r.rows) {
    const row = validateRow(candidate);
    if (row) rows.push(row);
  }
  return {
    date: typeof r.date === 'string' ? r.date : null,
    at: typeof r.at === 'string' ? r.at : null,
    rows,
    asOf: typeof r.asOf === 'string' ? r.asOf : '',
  };
}

async function fetchDealerRegime(
  date: string | null,
  at: string | null,
  signal: AbortSignal,
): Promise<DealerRegimeResponse | null> {
  const qs = new URLSearchParams();
  if (date) qs.set('date', date);
  if (at) qs.set('at', at);
  const url = qs.toString()
    ? `/api/dealer-regime?${qs.toString()}`
    : '/api/dealer-regime';
  const res = await fetch(url, {
    credentials: 'same-origin',
    signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
  });
  if (!res.ok) {
    if (res.status === 401) return null;
    throw new Error(`dealer-regime: HTTP ${res.status}`);
  }
  const parsed = validateDealerRegimeResponse(await res.json());
  if (parsed == null) {
    // Shapeless body ({} / loosely-parsed HTML / 5xx JSON blob). Throwing
    // routes it through the same catch a non-2xx uses, so the tile keeps
    // whatever it last rendered and surfaces the error instead of
    // crashing into the section ErrorBoundary.
    throw new Error('dealer-regime: unexpected response shape');
  }
  return parsed;
}

export function useDealerRegime(
  marketOpen: boolean,
  date: string | null = null,
  at: string | null = null,
): UseDealerRegimeReturn {
  const accessMode = getAccessMode();
  const [data, setData] = useState<DealerRegimeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // Cancels any in-flight request on rerun / unmount so a stale response
  // can't clobber a newer fetch's state and the browser stops the
  // bandwidth burn on rapid date/at changes.
  const abortRef = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const next = await fetchDealerRegime(date, at, ctrl.signal);
      if (!mountedRef.current) return;
      // Superseded by a newer fetch between resolve and parse — bail.
      if (ctrl.signal.aborted) return;
      setData(next);
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
  }, [date, at]);

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

    void fetchOnce();
  }, [accessMode, fetchOnce]);

  // Snapshot mode (date or at set) is static — no polling.
  usePolling(() => void fetchOnce(), POLL_INTERVALS.DEALER_REGIME, [
    accessMode !== 'public',
    marketOpen,
    !date,
    !at,
  ]);

  const refresh = useCallback(() => {
    setLoading(true);
    void fetchOnce();
  }, [fetchOnce]);

  // Cancel any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  return { data, loading, error, refresh };
}
