/**
 * useGexbotData — single polled hook serving all 8 GEXBot components.
 *
 * Polls `/api/gexbot?view=...` every 30s during market hours. The hook
 * is parameterized by `view` so callers only pay for the data they
 * need; components share the same hook signature so a future move to
 * shared cache (SWR / TanStack Query) is one diff away.
 *
 * Spec: docs/superpowers/specs/gexbot-frontend-2026-05-16.md
 *
 * Polling gate: `marketOpen` (passed in) — 30s tick happens only
 * during regular hours. Out-of-hours, returns the last-known data
 * indefinitely (no automatic stale-clearing).
 */

import { useCallback, useEffect, useState } from 'react';

import { POLL_INTERVALS } from '../constants';
import { fetchJson } from './useMarketData.fetchers';
import { usePolling } from './usePolling';

// ────────────────────────────────────────────────────────────
// View payload shapes (mirror api/_lib/gexbot-queries.ts)
// ────────────────────────────────────────────────────────────

export interface SnapshotsLatestRow {
  ticker: string;
  capturedAt: string;
  spot: number | null;
  zeroGamma: number | null;
  zMlgamma: number | null;
  zMsgamma: number | null;
  zcvr: number | null;
  zgr: number | null;
  zvanna: number | null;
  zcharm: number | null;
  oMlgamma: number | null;
  oMsgamma: number | null;
  ocvr: number | null;
  ogr: number | null;
  ovanna: number | null;
  ocharm: number | null;
  dexoflow: number | null;
  gexoflow: number | null;
  cvroflow: number | null;
  oneDexoflow: number | null;
  oneGexoflow: number | null;
  oneCvroflow: number | null;
  deltaRiskReversal: number | null;
}

export interface ConvexityTrendRow {
  ticker: string;
  series: Array<[string, number]>;
}

export interface MaxchangeWinnerRow {
  ticker: string;
  endpoint: string;
  category: string;
  capturedAt: string;
  windows: {
    current: [number, number] | null;
    one: [number, number] | null;
    five: [number, number] | null;
    ten: [number, number] | null;
    fifteen: [number, number] | null;
    thirty: [number, number] | null;
  };
}

export interface SiblingConfirmRow {
  ticker: string;
  zcvr: number | null;
  deltaRiskReversal: number | null;
  verdict: 'confirm' | 'contradict' | 'neutral';
}

// ────────────────────────────────────────────────────────────
// Discriminated view union + per-view return type
// ────────────────────────────────────────────────────────────

export type GexbotView =
  | { view: 'snapshots-latest' }
  | { view: 'convexity-trend' }
  | { view: 'maxchange-winners' }
  | { view: 'sibling-confirm'; ticker: string; side: 'call' | 'put' };

interface ViewPayload {
  'snapshots-latest': SnapshotsLatestRow[];
  'convexity-trend': ConvexityTrendRow[];
  'maxchange-winners': MaxchangeWinnerRow[];
  'sibling-confirm': SiblingConfirmRow[];
}

export interface UseGexbotDataResult<V extends GexbotView['view']> {
  rows: ViewPayload[V];
  loading: boolean;
  error: string | null;
  /** ISO timestamp of the freshest captured_at in `rows`, or null. */
  freshestAt: string | null;
}

// ────────────────────────────────────────────────────────────
// URL builder
// ────────────────────────────────────────────────────────────

function buildUrl(spec: GexbotView): string {
  const qs = new URLSearchParams({ view: spec.view });
  if (spec.view === 'sibling-confirm') {
    qs.set('ticker', spec.ticker);
    qs.set('side', spec.side);
  }
  return `/api/gexbot?${qs.toString()}`;
}

function freshestFrom(rows: unknown[]): string | null {
  let best: string | null = null;
  for (const r of rows as Array<{ capturedAt?: string }>) {
    if (r.capturedAt && (best === null || r.capturedAt > best)) {
      best = r.capturedAt;
    }
  }
  return best;
}

// ────────────────────────────────────────────────────────────
// Hook
// ────────────────────────────────────────────────────────────

export function useGexbotData<V extends GexbotView['view']>(
  spec: GexbotView & { view: V },
  marketOpen: boolean,
): UseGexbotDataResult<V> {
  const [rows, setRows] = useState<ViewPayload[V]>([] as ViewPayload[V]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [freshestAt, setFreshestAt] = useState<string | null>(null);

  // Depend on primitives — callers may pass a fresh `spec` object each
  // render. Pulling primitives out keeps the fetcher reference stable
  // and avoids re-firing the mount-fetch effect every render.
  // `'in'` checks let TS narrow the discriminated union without the
  // intersection-with-V interfering with view-string narrowing.
  const view = spec.view;
  const ticker = 'ticker' in spec ? spec.ticker : undefined;
  const side = 'side' in spec ? spec.side : undefined;

  const fetchNow = useCallback(async () => {
    const url =
      view === 'sibling-confirm'
        ? buildUrl({ view, ticker: ticker!, side: side! })
        : buildUrl({ view } as GexbotView);
    const result = await fetchJson<{ rows: ViewPayload[V] }>(url);
    if ('error' in result) {
      setError(`${result.error} (HTTP ${result.status})`);
      setLoading(false);
      return;
    }
    const list = result.data.rows ?? ([] as ViewPayload[V]);
    setRows(list);
    setFreshestAt(freshestFrom(list as unknown[]));
    setError(null);
    setLoading(false);
  }, [view, ticker, side]);

  // Eager mount fetch — usePolling only schedules the recurring tick.
  useEffect(() => {
    void fetchNow();
  }, [fetchNow]);

  usePolling(
    () => {
      void fetchNow();
    },
    POLL_INTERVALS.OTM_FLOW, // 30_000 — matches the spec's requested cadence
    [marketOpen],
  );

  return { rows, loading, error, freshestAt };
}
