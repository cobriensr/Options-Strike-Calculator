/**
 * useGexbotData — single hook serving the GEXBot components.
 *
 * Polls `/api/gexbot?view=...` every 30s during market hours, except
 * `sibling-confirm`: that read answers for a past fire time, so it is
 * fetched once per URL and retried only after a transient failure (see
 * `SIBLING_MAX_RETRIES`). The hook is parameterized by `view` so callers only
 * pay for the data they need; components share the same hook signature so a
 * future move to shared cache (SWR / TanStack Query) is one diff away.
 *
 * Spec: docs/superpowers/specs/gexbot-frontend-2026-05-16.md
 *
 * Polling gate: `marketOpen` (passed in) — 30s tick happens only
 * during regular hours. Out-of-hours, returns the last-known data
 * indefinitely (no automatic stale-clearing). `sibling-confirm` ignores
 * `marketOpen`: its error retry runs at any hour.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

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
  oneDexoflow: number | null;
  oneGexoflow: number | null;
  oneCvroflow: number | null;
  /** Nearest listed expiry in days (0 = same-day). Differs per ticker. */
  minDte: number | null;
}

/** Minute-over-minute change per ticker; null = unavailable (see server). */
export interface VelocityRow {
  ticker: string;
  capturedAt: string;
  minDte: number | null;
  /** Δ agg_dex: taker delta flow over the last minute. */
  dAggDex: number | null;
  /** Δ zgr: change in call − put GEX imbalance. */
  dZgr: number | null;
  /** Δ zcvr: change in net convexity. */
  dZcvr: number | null;
  /** Median |Δ agg_dex| over this ticker's session minutes. */
  typicalAbsDAggDex: number | null;
}

export interface ConvexityTrendRow {
  ticker: string;
  /** Latest nearest-expiry DTE for the ticker, or null if unreported. */
  minDte: number | null;
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
  /**
   * Net taker delta across the nearest-expiry chain (`min_dte`; not always
   * 0DTE) at the alert's fire time. + = net long.
   */
  netDex: number | null;
  /** Call minus put GEX imbalance. Context only; not in the verdict. */
  zgr: number | null;
  capturedAt: string | null;
  verdict: 'agree' | 'disagree' | 'none';
}

// ────────────────────────────────────────────────────────────
// Discriminated view union + per-view return type
// ────────────────────────────────────────────────────────────

export type GexbotView =
  | { view: 'snapshots-latest' }
  | { view: 'velocity' }
  | { view: 'convexity-trend' }
  | { view: 'maxchange-winners' }
  | {
      view: 'sibling-confirm';
      ticker: string;
      side: 'call' | 'put';
      /** The alert's fire time, ISO 8601. */
      at: string;
    };

interface ViewPayload {
  'snapshots-latest': SnapshotsLatestRow[];
  velocity: VelocityRow[];
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
    qs.set('at', spec.at);
  }
  return `/api/gexbot?${qs.toString()}`;
}

function freshestFrom(rows: unknown[]): string | null {
  let best: string | null = null;
  for (const r of rows) {
    // Defensive: rows may transit through unknown[] casts at the call
    // site; guard against null entries and non-object shapes so a
    // malformed API response can't throw inside the timestamp scan.
    if (typeof r !== 'object' || r === null) continue;
    const ts = (r as { capturedAt?: unknown }).capturedAt;
    if (typeof ts === 'string' && (best === null || ts > best)) {
      best = ts;
    }
  }
  return best;
}

// ────────────────────────────────────────────────────────────
// In-flight request dedupe
// ────────────────────────────────────────────────────────────
//
// Three Gexbot components (CharmClock, DealerStateSummaryStrip,
// GammaCompass) subscribe to `view=snapshots-latest` and mount
// simultaneously on pageload. Without dedupe each issues its own
// fetch → 3× identical hits + Sentry's N+1 detector firing on every
// session (SENTRY-EMERALD-DESERT-8J). Dedupe collapses concurrent
// hits for the same URL into a single in-flight promise; per-component
// state (rows/loading/error) stays independent, only the network call
// is shared. The slot is released on settle so the next poll tick
// starts a fresh request rather than reusing a stale one.

type GexbotFetchResult = Awaited<
  ReturnType<typeof fetchJson<{ rows: unknown }>>
>;
const inflight = new Map<string, Promise<GexbotFetchResult>>();

function fetchDeduped(url: string): Promise<GexbotFetchResult> {
  const existing = inflight.get(url);
  if (existing) return existing;
  const p = fetchJson<{ rows: unknown }>(url).finally(() => {
    // Race-safe cleanup: only clear the slot if WE are still the
    // tracked promise. A late re-entry could have replaced us.
    if (inflight.get(url) === p) inflight.delete(url);
  });
  inflight.set(url, p);
  return p;
}

// ────────────────────────────────────────────────────────────
// Sibling-confirm error retry
// ────────────────────────────────────────────────────────────

/**
 * Retries of a failed sibling-confirm read, 30 s apart (about 2.5 minutes):
 * enough to ride out a Neon blip without leaving every mounted alert row
 * querying forever.
 */
const SIBLING_MAX_RETRIES = 5;

/**
 * A failure that another try can clear: network, timeout or abort (status 0),
 * 408, 429 and 5xx. Any other 4xx is the request itself being refused.
 */
function isTransientStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

// ────────────────────────────────────────────────────────────
// Hook
// ────────────────────────────────────────────────────────────

/** The latest read of a URL failed. A good read replaces it with null. */
interface FetchFailure {
  /** Text shown to the caller. */
  message: string;
  /** HTTP status of the failed read; 0 = no response. */
  status: number;
  /**
   * Retries already made after the first failed read of this URL: 0 for that
   * first failure, one more for each failed retry. Dev StrictMode runs the
   * mount effect twice; both calls share one deduped request, so its first
   * failure is counted twice and a dev row gets one retry fewer.
   */
  retries: number;
}

interface FetchState<V extends GexbotView['view']> {
  /** The request URL this state answers; stale once the spec changes. */
  url: string;
  rows: ViewPayload[V];
  error: FetchFailure | null;
  freshestAt: string | null;
}

export function useGexbotData<V extends GexbotView['view']>(
  spec: GexbotView & { view: V },
  marketOpen: boolean,
): UseGexbotDataResult<V> {
  const [state, setState] = useState<FetchState<V> | null>(null);
  // The newest URL this hook asked for. A response for any other URL is
  // from a superseded request (a Lottery re-fire changes `at`) and must not
  // overwrite the newer one.
  const latestUrl = useRef<string | null>(null);

  // Depend on primitives — callers may pass a fresh `spec` object each
  // render. Pulling primitives out keeps the fetcher reference stable
  // and avoids re-firing the mount-fetch effect every render.
  // `'in'` checks let TS narrow the discriminated union without the
  // intersection-with-V interfering with view-string narrowing.
  const view = spec.view;
  const ticker = 'ticker' in spec ? spec.ticker : undefined;
  const side = 'side' in spec ? spec.side : undefined;
  const at = 'at' in spec ? spec.at : undefined;

  const url =
    view === 'sibling-confirm'
      ? buildUrl({ view, ticker: ticker!, side: side!, at: at! })
      : buildUrl({ view } as GexbotView);

  const fetchNow = useCallback(async () => {
    latestUrl.current = url;
    const result = (await fetchDeduped(url)) as
      | { data: { rows?: ViewPayload[V] } }
      | { error: string; status: number };
    if (latestUrl.current !== url) return;
    if ('error' in result) {
      const message = `${result.error} (HTTP ${result.status})`;
      // Keep the last good rows for this URL; a different URL has none.
      setState((prev) => {
        const same = prev?.url === url ? prev : null;
        return {
          url,
          rows: same?.rows ?? ([] as ViewPayload[V]),
          freshestAt: same?.freshestAt ?? null,
          error: {
            message,
            status: result.status,
            retries: same?.error ? same.error.retries + 1 : 0,
          },
        };
      });
      return;
    }
    const list = result.data.rows ?? ([] as ViewPayload[V]);
    setState({
      url,
      rows: list,
      freshestAt: freshestFrom(list as unknown[]),
      error: null,
    });
  }, [url]);

  // Eager mount fetch — usePolling only schedules the recurring tick.
  useEffect(() => {
    // Leaving a URL drops its state, so coming back to it (even before the
    // other URL has answered) starts with no rows and a fresh retry count.
    setState((prev) => (prev?.url === url ? prev : null));
    void fetchNow();
  }, [fetchNow, url]);

  // State from a previous URL answers a different question (another fire
  // time): show it as not loaded yet, not as this URL's rows.
  const current = state?.url === url ? state : null;

  // A sibling-confirm read is final once its fire time has passed: the
  // snapshot it uses is already in the table, and every alert row has its
  // own URL, so a 30 s tick would be one uncached Neon query per mounted
  // row per tick for an answer that cannot change. Fetch it once, and tick
  // only to retry a transient failure (a Neon blip at mount would otherwise
  // leave the row without pills until it remounts). That is a bounded error
  // retry, not polling, so it ignores `marketOpen`: a row reviewed after the
  // close still recovers. The gate closes on the first good read, on a
  // permanent failure, and after SIBLING_MAX_RETRIES failed retries (a URL
  // change starts the count over, see the mount effect). Every other view
  // polls only while the market is open.
  const siblingRetryDue =
    current?.error != null &&
    isTransientStatus(current.error.status) &&
    current.error.retries < SIBLING_MAX_RETRIES;
  usePolling(
    () => {
      void fetchNow();
    },
    POLL_INTERVALS.OTM_FLOW, // 30_000 — matches the spec's requested cadence
    [view === 'sibling-confirm' ? siblingRetryDue : marketOpen],
  );

  return {
    rows: current?.rows ?? ([] as ViewPayload[V]),
    loading: current === null,
    error: current?.error?.message ?? null,
    freshestAt: current?.freshestAt ?? null,
  };
}
