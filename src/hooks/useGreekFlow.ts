/**
 * useGreekFlow — fetches the SPY+QQQ Greek flow session from
 * /api/greek-flow with optional date scrubbing.
 *
 * Live mode (no date arg): polls /api/greek-flow every
 * POLL_INTERVALS.GREEK_FLOW during market hours.
 *
 * Date mode (date='YYYY-MM-DD'): one-shot fetch of that calendar day's
 * session (the past doesn't change — no polling).
 *
 * Owner-or-guest: matches the API endpoint's auth tier. Public visitors
 * get 401 and the hook stays idle without surfacing a user-visible error.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { getAccessMode } from '../utils/auth';
import { usePolling } from './usePolling';

// ── Types mirror the server response in api/greek-flow.ts ───────────

export type GreekFlowTicker = 'SPY' | 'QQQ';

export type GreekFlowField =
  | 'dir_vega_flow'
  | 'total_vega_flow'
  | 'otm_dir_vega_flow'
  | 'otm_total_vega_flow'
  | 'dir_delta_flow'
  | 'total_delta_flow'
  | 'otm_dir_delta_flow'
  | 'otm_total_delta_flow';

export interface GreekFlowRow {
  ticker: GreekFlowTicker;
  timestamp: string;
  transactions: number;
  volume: number;
  dir_vega_flow: number;
  total_vega_flow: number;
  otm_dir_vega_flow: number;
  otm_total_vega_flow: number;
  dir_delta_flow: number;
  total_delta_flow: number;
  otm_dir_delta_flow: number;
  otm_total_delta_flow: number;
  cum_dir_vega_flow: number;
  cum_total_vega_flow: number;
  cum_otm_dir_vega_flow: number;
  cum_otm_total_vega_flow: number;
  cum_dir_delta_flow: number;
  cum_total_delta_flow: number;
  cum_otm_dir_delta_flow: number;
  cum_otm_total_delta_flow: number;
  price: number | null;
}

export type Sign = 1 | -1 | 0;

export interface SlopeResult {
  slope: number | null;
  points: number;
}

export interface FlipResult {
  occurred: boolean;
  atTimestamp: string | null;
  magnitude: number;
  currentSign: Sign;
}

export interface CliffResult {
  magnitude: number;
  atTimestamp: string | null;
}

export interface DivergenceResult {
  spySign: Sign;
  qqqSign: Sign;
  diverging: boolean;
}

export type GreekFlowMetrics = Record<
  GreekFlowField,
  { slope: SlopeResult; flip: FlipResult; cliff: CliffResult }
>;

/**
 * Which expiry slice to read:
 *   - `'0dte'` — only today's expiry. Verdict-eligible.
 *   - `'all'`  — all-expiries aggregate. Context-only (no verdict).
 *
 * Server validates this enum and defaults to `'0dte'` when omitted.
 */
export type GreekFlowScope = '0dte' | 'all';

export interface GreekFlowResponse {
  date: string | null;
  scope: GreekFlowScope;
  tickers: Record<
    GreekFlowTicker,
    { rows: GreekFlowRow[]; metrics: GreekFlowMetrics }
  >;
  divergence: Record<GreekFlowField, DivergenceResult>;
  asOf: string;
}

export interface UseGreekFlowReturn {
  data: GreekFlowResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// ── Validation ──────────────────────────────────────────────────────
// Mirrors `validateSpike` (useVegaSpikes) and `parseDarkPoolResponse`
// (useDarkPoolLevels). The panel dereferences the payload structurally —
// `data.tickers.SPY.rows`, `data.tickers[t].metrics[field].slope`,
// `computeVerdict(data.divergence[field], …)` — so a shapeless body ({},
// a loosely-parsed HTML error page, a 5xx JSON blob) used to reach the
// render pass and throw. Everything is checked at the parse instead.
//
// REQUIRED (missing/wrong type ⇒ whole envelope rejected ⇒ the hook's
// existing error path, last-known-good `data` untouched):
//   `date` (string | null) and `tickers` (object). Both are present on
//   every 200 from api/greek-flow.ts, including its `emptyResponse()`.
//
// DEGRADED (invalid ⇒ safe default, envelope survives):
//   `scope` → the scope this hook asked for; `asOf` → ''; a malformed
//   per-ticker bucket → empty rows + empty metrics; a malformed metric
//   or divergence entry → the same neutral value the server sends for an
//   empty session; malformed rows are dropped individually.
//
// Numerics are checked for type/finiteness only — 0 is a legitimate
// greek-flow value (a flat minute bar), never a sentinel.

const GREEK_FLOW_FIELDS = [
  'dir_vega_flow',
  'total_vega_flow',
  'otm_dir_vega_flow',
  'otm_total_vega_flow',
  'dir_delta_flow',
  'total_delta_flow',
  'otm_dir_delta_flow',
  'otm_total_delta_flow',
] as const satisfies readonly GreekFlowField[];

/** The 18 numeric columns every row carries (server coerces each via
 *  `parsedOrFallback`, so they are always finite numbers in practice). */
const NUMERIC_ROW_FIELDS = [
  'transactions',
  'volume',
  'dir_vega_flow',
  'total_vega_flow',
  'otm_dir_vega_flow',
  'otm_total_vega_flow',
  'dir_delta_flow',
  'total_delta_flow',
  'otm_dir_delta_flow',
  'otm_total_delta_flow',
  'cum_dir_vega_flow',
  'cum_total_vega_flow',
  'cum_otm_dir_vega_flow',
  'cum_otm_total_vega_flow',
  'cum_dir_delta_flow',
  'cum_total_delta_flow',
  'cum_otm_dir_delta_flow',
  'cum_otm_total_delta_flow',
] as const satisfies readonly (keyof GreekFlowRow)[];

type NumericRowField = (typeof NUMERIC_ROW_FIELDS)[number];

/** Same neutral divergence the server sends for an empty session — a
 *  "no confluence / stand down" verdict rather than a fabricated one. */
const NEUTRAL_DIVERGENCE: DivergenceResult = {
  spySign: 0,
  qqqSign: 0,
  diverging: false,
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNullableFiniteNumber(v: unknown): v is number | null {
  return v === null || isFiniteNumber(v);
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

function isSign(v: unknown): v is Sign {
  return v === 0 || v === 1 || v === -1;
}

/** Narrow an unknown to a plain record, or `{}` so callers can read
 *  fields off it and fall back field-by-field. */
function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null
    ? (raw as Record<string, unknown>)
    : {};
}

function validateRow(raw: unknown): GreekFlowRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.ticker !== 'SPY' && r.ticker !== 'QQQ') return null;
  if (typeof r.timestamp !== 'string') return null;
  const price = r.price === undefined ? null : r.price;
  if (!isNullableFiniteNumber(price)) return null;

  const numerics = {} as Record<NumericRowField, number>;
  for (const key of NUMERIC_ROW_FIELDS) {
    const value = r[key];
    if (!isFiniteNumber(value)) return null;
    numerics[key] = value;
  }

  return {
    ...numerics,
    ticker: r.ticker,
    timestamp: r.timestamp,
    price,
  };
}

function validateSlope(raw: unknown): SlopeResult {
  const r = asRecord(raw);
  return {
    slope: isNullableFiniteNumber(r.slope) ? r.slope : null,
    points: isFiniteNumber(r.points) ? r.points : 0,
  };
}

function validateFlip(raw: unknown): FlipResult {
  const r = asRecord(raw);
  return {
    occurred: r.occurred === true,
    atTimestamp: isNullableString(r.atTimestamp) ? r.atTimestamp : null,
    magnitude: isFiniteNumber(r.magnitude) ? r.magnitude : 0,
    currentSign: isSign(r.currentSign) ? r.currentSign : 0,
  };
}

function validateCliff(raw: unknown): CliffResult {
  const r = asRecord(raw);
  return {
    magnitude: isFiniteNumber(r.magnitude) ? r.magnitude : 0,
    atTimestamp: isNullableString(r.atTimestamp) ? r.atTimestamp : null,
  };
}

function validateMetrics(raw: unknown): GreekFlowMetrics {
  const r = asRecord(raw);
  const out = {} as GreekFlowMetrics;
  for (const field of GREEK_FLOW_FIELDS) {
    const metric = asRecord(r[field]);
    out[field] = {
      slope: validateSlope(metric.slope),
      flip: validateFlip(metric.flip),
      cliff: validateCliff(metric.cliff),
    };
  }
  return out;
}

function validateDivergence(raw: unknown): DivergenceResult {
  const r = asRecord(raw);
  if (!isSign(r.spySign) || !isSign(r.qqqSign)) return NEUTRAL_DIVERGENCE;
  return {
    spySign: r.spySign,
    qqqSign: r.qqqSign,
    diverging: r.diverging === true,
  };
}

function validateDivergenceMap(
  raw: unknown,
): Record<GreekFlowField, DivergenceResult> {
  const r = asRecord(raw);
  const out = {} as Record<GreekFlowField, DivergenceResult>;
  for (const field of GREEK_FLOW_FIELDS) {
    out[field] = validateDivergence(r[field]);
  }
  return out;
}

function validateTickerBucket(raw: unknown): {
  rows: GreekFlowRow[];
  metrics: GreekFlowMetrics;
} {
  const r = asRecord(raw);
  const rows: GreekFlowRow[] = [];
  if (Array.isArray(r.rows)) {
    for (const candidate of r.rows) {
      const row = validateRow(candidate);
      if (row) rows.push(row);
    }
  }
  return { rows, metrics: validateMetrics(r.metrics) };
}

/**
 * Validate the /api/greek-flow envelope. Returns the typed response on
 * success or `null` when the body isn't shaped like one at all — the
 * caller surfaces that as a normal error state instead of letting it
 * reach the render pass.
 */
function parseGreekFlowResponse(
  raw: unknown,
  fallbackScope: GreekFlowScope,
): GreekFlowResponse | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const date = r.date === undefined ? null : r.date;
  if (!isNullableString(date)) return null;
  if (typeof r.tickers !== 'object' || r.tickers === null) return null;
  const tickers = r.tickers as Record<string, unknown>;

  return {
    date,
    scope: r.scope === '0dte' || r.scope === 'all' ? r.scope : fallbackScope,
    tickers: {
      SPY: validateTickerBucket(tickers.SPY),
      QQQ: validateTickerBucket(tickers.QQQ),
    },
    divergence: validateDivergenceMap(r.divergence),
    asOf: typeof r.asOf === 'string' ? r.asOf : '',
  };
}

export function useGreekFlow(
  marketOpen: boolean,
  date: string | null = null,
  scope: GreekFlowScope = '0dte',
): UseGreekFlowReturn {
  const accessMode = getAccessMode();
  const [data, setData] = useState<GreekFlowResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // Cancels any in-flight request on rerun / unmount so a stale response
  // can't clobber a newer fetch's state and the browser stops the
  // bandwidth burn on rapid date/scope changes.
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const qs = new URLSearchParams();
      if (date) qs.set('date', date);
      qs.set('scope', scope);
      const url = `/api/greek-flow?${qs}`;

      const res = await fetch(url, {
        credentials: 'same-origin',
        signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(8_000)]),
      });

      if (!mountedRef.current) return;
      // Superseded by a newer fetch between resolve and parse — bail.
      if (ctrl.signal.aborted) return;

      if (!res.ok) {
        // 401 for anon visitors is expected and not a user-visible error.
        if (res.status !== 401) setError('Failed to load Greek flow');
        return;
      }

      const raw: unknown = await res.json();
      if (!mountedRef.current) return;
      if (ctrl.signal.aborted) return;

      const body = parseGreekFlowResponse(raw, scope);
      if (body == null) {
        // Shapeless body ({} / loosely-parsed HTML / 5xx JSON blob) —
        // surface as a normal error state and keep the last good data,
        // exactly like a non-2xx response. Never let it reach render.
        setError('Unexpected response shape');
        return;
      }

      setData(body);
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
  }, [date, scope]);

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

  // Date-scrubbed view is static — no polling.
  usePolling(() => void fetchData(), POLL_INTERVALS.GREEK_FLOW, [
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

  return { data, loading, error, refresh };
}
