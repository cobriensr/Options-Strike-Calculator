/**
 * useFlowRegime — fetches the Flow Regime Recognition snapshot from
 * `GET /api/flow-regime` and exposes the latest 30-min slot plus today's
 * full slot series for the badge.
 *
 * Phase 3 of docs/superpowers/specs/flow-regime-badge-2026-06-06.md.
 *
 * RECOGNITION ONLY — the snapshots score the CURRENT intraday options
 * flow against the SAME time-of-day bucket historically. They surface
 * "today's flow is abnormal for this time of day, as it forms" for
 * sizing / not-fighting-the-tape. They do NOT forecast direction (the
 * 106-day point-in-time backtest found options flow has no forward edge).
 *
 * Built on `useFetchedData`: single eager fetch on mount, then polls
 * `POLL_INTERVALS.FLOW_REGIME` (60s) only while `marketOpen` is true —
 * the cron refines the in-progress slot every 5 min during RTH and the
 * endpoint adds a 15s edge cache, so 60s keeps the badge within ~1 min
 * of fresh without hammering the origin.
 *
 * This is a pure frontend module (never imported by api/), so relative
 * imports do NOT need explicit `.js` extensions.
 */

import { POLL_INTERVALS } from '../constants';
import { useFetchedData } from './useFetchedData';
import type { FlowRegime, FlowRegimeColor } from '../types/flow-regime';

// Re-export the shared union types so existing importers (the badge component,
// its classifier, tests) keep importing them from this hook unchanged. The
// single source of truth is src/types/flow-regime.ts.
export type { FlowRegime, FlowRegimeColor };

/**
 * One captured 30-min slot snapshot, matching the fully-coerced shape the
 * endpoint serves (api/_lib/flow-regime-store.ts `FlowRegimeSnapshot`).
 * Percentiles are null when the slot lacks sufficient baseline depth.
 */
export interface FlowRegimeSnapshot {
  date: string;
  slot: number;
  computedAt: string;
  /** net_delta_tilt (−1..+1) for the bucket, or null. */
  ndTilt: number | null;
  /** idx0dte_put_share (0..1) for the bucket, or null. */
  idx0dtePutShare: number | null;
  /** Percentile (0..100) of ndTilt vs this slot historically, or null. */
  ndPercentile: number | null;
  /** Percentile (0..100) of put-share vs this slot historically, or null. */
  idxputPercentile: number | null;
  regime: FlowRegime;
  color: FlowRegimeColor;
  nTrades: number;
  /** Baseline artifact schema_version this snapshot was scored against. */
  baselineVersion: number | null;
}

/** Top-level GET /api/flow-regime response envelope. */
export interface FlowRegimeResponse {
  date: string;
  latest: FlowRegimeSnapshot | null;
}

export interface UseFlowRegimeReturn {
  /** The latest (highest) captured slot today, or null pre-open / no data. */
  latest: FlowRegimeSnapshot | null;
  /** The ET trade date the snapshot describes, or null before first fetch. */
  date: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

interface Options {
  /** Whether the cash session is open — controls live polling. */
  marketOpen: boolean;
}

const REGIMES: ReadonlySet<string> = new Set([
  'normal',
  'caution',
  'bearish',
  'bullish',
]);
const COLORS: ReadonlySet<string> = new Set(['green', 'amber', 'red', 'gray']);

function numOrNull(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

/** Coerce one raw snapshot object into a typed FlowRegimeSnapshot. */
function parseSnapshot(raw: unknown): FlowRegimeSnapshot {
  const o = (raw ?? {}) as Record<string, unknown>;
  const regime = REGIMES.has(o.regime as string)
    ? (o.regime as FlowRegime)
    : 'normal';
  const color = COLORS.has(o.color as string)
    ? (o.color as FlowRegimeColor)
    : 'gray';
  return {
    date: typeof o.date === 'string' ? o.date : '',
    slot: typeof o.slot === 'number' ? o.slot : 0,
    computedAt: typeof o.computedAt === 'string' ? o.computedAt : '',
    ndTilt: numOrNull(o.ndTilt),
    idx0dtePutShare: numOrNull(o.idx0dtePutShare),
    ndPercentile: numOrNull(o.ndPercentile),
    idxputPercentile: numOrNull(o.idxputPercentile),
    regime,
    color,
    nTrades: typeof o.nTrades === 'number' ? o.nTrades : 0,
    baselineVersion: numOrNull(o.baselineVersion),
  };
}

/** Parse the raw endpoint envelope into a typed FlowRegimeResponse. */
export function parseFlowRegime(raw: unknown): FlowRegimeResponse {
  const o = (raw ?? {}) as Record<string, unknown>;
  const latest = o.latest != null ? parseSnapshot(o.latest) : null;
  return {
    date: typeof o.date === 'string' ? o.date : '',
    latest,
  };
}

export function useFlowRegime({ marketOpen }: Options): UseFlowRegimeReturn {
  const { data, loading, error, refresh } = useFetchedData<FlowRegimeResponse>({
    url: '/api/flow-regime',
    marketOpen,
    pollIntervalMs: POLL_INTERVALS.FLOW_REGIME,
    parse: parseFlowRegime,
  });

  return {
    latest: data?.latest ?? null,
    date: data?.date ?? null,
    loading,
    error,
    refresh,
  };
}
