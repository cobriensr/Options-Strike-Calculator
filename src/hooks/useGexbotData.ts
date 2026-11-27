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
 * indefinitely. The one clearing is the market's open edge (`marketOpen`
 * false to true): the held rows are then the last session's, so the hook stops
 * returning them on the render of the flip itself (tiles read loading) and
 * reads at once rather than at the first tick. `sibling-confirm` ignores
 * `marketOpen`: its error retry runs at any hour, and it has no open edge.
 *
 * After the close the server answers `snapshots-latest`, `velocity`,
 * `convexity-trend` and `maxchange-winners` with the last session's rows and
 * their capture time, `asOf` (spec:
 * docs/superpowers/specs/2026-11-20-gexbot-after-close-design.md). For those
 * four views (`CLOSED_SESSION_VIEWS`) the hook:
 *  - exposes `asOf`;
 *  - drops a body whose `asOf` is before today's open once the market is open
 *    (a tab carried over from the closed view, an edge-cached closed response,
 *    a client clock ahead of the server's), so the tiles read "awaiting first
 *    GEXBot tick" rather than showing it as live;
 *  - keeps one final fetch armed for close + 3 min, re-armed daily
 *    (`useFinalFetch`), because polling is off after the close;
 *  - keeps held rows, with no error, when a read fails while the market is
 *    closed, and retries a transient failure 5 times, 30 s apart. With nothing
 *    held the error shows while the retries run.
 * `expected-move` and `sibling-confirm` answer for something other than the
 * session's last minute and are unchanged.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { POLL_INTERVALS } from '../constants';
import {
  asOfFrom,
  isCarriedOver,
  isTransientStatus,
} from '../utils/closed-session';
import { getETDateStr } from '../utils/timezone';
import { fetchJson } from './useMarketData.fetchers';
import { useFinalFetch, type FinalFetchOutcome } from './useFinalFetch';
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
  /** The vendor's level prices (see the server's `SnapshotsLatestRow`). */
  zeroMcall: number | null;
  zeroMput: number | null;
  majorPosVol: number | null;
  majorPosOi: number | null;
  majorNegVol: number | null;
  majorNegOi: number | null;
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

/**
 * One strike's call and put IV from the expected-move capture. IVs are
 * fractions (0.11 = 11%); null where GEXBot sent no quote on that side.
 */
export interface ExpectedMoveStrikeIv {
  strike: number;
  callIv: number | null;
  putIv: number | null;
}

/**
 * GEXBot's ±1σ expected move for one ticker, as of the vendor snapshot.
 * `unavailable` is null exactly when `expectedMove` is a number; otherwise
 * it names why the latest capture could not produce one.
 */
export interface ExpectedMoveRow {
  ticker: string;
  capturedAt: string;
  /** The vendor snapshot time the move is computed for, ISO 8601. */
  asOf: string;
  spot: number | null;
  /** Calendar days to the expiry the IVs belong to (0 = same-day). */
  minDte: number | null;
  atmStrike: number | null;
  /** Smoothed ATM IV as a fraction (0.11 = 11%). */
  atmIv: number | null;
  /** Days to expiry, including the part of today that is left. */
  dteFraction: number | null;
  /** One standard deviation, in index points. */
  expectedMove: number | null;
  lower: number | null;
  upper: number | null;
  unavailable: 'no_spot' | 'no_dte' | 'expired' | 'no_atm_iv' | null;
  /**
   * Every strike in the capture the move is computed from, with its call and
   * put IV; `[]` when the capture has no usable strike rows. Carried even
   * when the move itself is `unavailable`.
   */
  strikeIvs: ExpectedMoveStrikeIv[];
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
  | { view: 'expected-move' }
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
  'expected-move': ExpectedMoveRow[];
  'sibling-confirm': SiblingConfirmRow[];
}

export interface UseGexbotDataResult<V extends GexbotView['view']> {
  rows: ViewPayload[V];
  loading: boolean;
  error: string | null;
  /** ISO timestamp of the freshest captured_at in `rows`, or null. */
  freshestAt: string | null;
  /**
   * The capture time of the data, from the body's `asOf`: the latest capture
   * among its rows, which after the close is the last session's. Null for a
   * body with no `asOf` (a view that sends none included), a body dropped as
   * carried over from a closed session, or an `asOf` that is not an ISO
   * timestamp.
   */
  asOf: string | null;
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

/**
 * The open session an answer that lands now belongs to: today's ET date while
 * the market is open, null while it is closed.
 */
function openSessionNow(marketOpen: boolean): string | null {
  return marketOpen ? getETDateStr(new Date()) : null;
}

/**
 * True when the market is open and `session` (`FetchState.session`) is not
 * today's open session: the answer landed in a closed hour or in an earlier
 * session, so it is not live.
 */
function isBeforeOpenSession(
  session: string | null,
  marketOpen: boolean,
): boolean {
  return marketOpen && session !== openSessionNow(true);
}

/**
 * The views that keep the last session's rows after the close (see the file
 * header). The others answer for something else and keep their old rules.
 */
const CLOSED_SESSION_VIEWS: ReadonlySet<GexbotView['view']> = new Set([
  'snapshots-latest',
  'velocity',
  'convexity-trend',
  'maxchange-winners',
]);

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
   * first failure, one more for each failed retry. Calls that share one
   * deduped request (dev StrictMode runs the mount effect twice) count its
   * failure once: only the newest call applies the answer.
   */
  retries: number;
}

interface FetchState<V extends GexbotView['view']> {
  /** The request URL this state answers; stale once the spec changes. */
  url: string;
  rows: ViewPayload[V];
  error: FetchFailure | null;
  freshestAt: string | null;
  asOf: string | null;
  /**
   * The open session this answer landed in (`openSessionNow`): null when it
   * landed while the market was closed. With the market open, an answer from
   * any session but today's is not shown (`isBeforeOpenSession`).
   */
  session: string | null;
}

export function useGexbotData<V extends GexbotView['view']>(
  spec: GexbotView & { view: V },
  marketOpen: boolean,
): UseGexbotDataResult<V> {
  const [state, setState] = useState<FetchState<V> | null>(null);
  // Number of the newest read this hook asked for. A result for an older one
  // is superseded and must not overwrite the newer: another URL (a Lottery
  // re-fire changes `at`), or an earlier call for this URL that shares its
  // request with the newer call (`fetchDeduped`) and would apply the same
  // answer twice.
  const latestRead = useRef(0);
  // marketOpen as of the last effect run, to catch the false to true edge.
  const wasMarketOpen = useRef(marketOpen);

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

  // Whether this view keeps the last session after the close (file header).
  const keepsLastSession = CLOSED_SESSION_VIEWS.has(view);
  // Whether an answer is for the session: every view but `sibling-confirm`,
  // which answers for a past fire time and has no open edge.
  const followsSession = view !== 'sibling-confirm';
  // marketOpen as of the latest render, for an answer that lands after the
  // market flipped (usePolling's latest-value pattern).
  const marketOpenNow = useRef(marketOpen);
  marketOpenNow.current = marketOpen;

  /**
   * One read of the view. Resolves to what the request itself came to, whether
   * or not a newer read has since taken over the state, and never rejects:
   * `fetchJson` answers a failure as a value.
   */
  const fetchNow = useCallback(async (): Promise<FinalFetchOutcome> => {
    latestRead.current += 1;
    const thisRead = latestRead.current;
    // `data` is null for a 2xx whose JSON is `null`: the body is cast, not parsed.
    const result = (await fetchDeduped(url)) as
      | { data: { rows?: ViewPayload[V]; asOf?: unknown } | null }
      | { error: string; status: number };
    const superseded = latestRead.current !== thisRead;
    if ('error' in result) {
      const outcome = isTransientStatus(result.status) ? 'transient' : 'failed';
      if (superseded) return outcome;
      const message = `${result.error} (HTTP ${result.status})`;
      // After the close polling is off, so an error would stay up all evening
      // over rows that are still the session's last: hold them and say nothing.
      const open = marketOpenNow.current;
      const holdRows = keepsLastSession && !open;
      const session = openSessionNow(open);
      // Keep the last good rows for this URL; a different URL has none, and an
      // earlier session's rows (held while closed, hidden at the open) are not
      // good rows for a market that is open.
      setState((prev) => {
        const same =
          prev?.url === url &&
          !(followsSession && isBeforeOpenSession(prev.session, open))
            ? prev
            : null;
        if (holdRows && same != null && (same.rows as unknown[]).length > 0) {
          return { ...same, error: null };
        }
        return {
          url,
          rows: same?.rows ?? ([] as ViewPayload[V]),
          freshestAt: same?.freshestAt ?? null,
          asOf: same?.asOf ?? null,
          session,
          error: {
            message,
            status: result.status,
            retries: same?.error ? same.error.retries + 1 : 0,
          },
        };
      });
      return outcome;
    }
    if (superseded) return 'ok';
    const asOf = asOfFrom(result.data?.asOf);
    const open = marketOpenNow.current;
    const session = openSessionNow(open);
    // An answer from before today's open, with the market open, is the last
    // session's: a closed response cached at the edge, or a client clock ahead
    // of the server's. It is no live row, and no error either.
    if (keepsLastSession && isCarriedOver(asOf, open, new Date())) {
      setState({
        url,
        rows: [] as ViewPayload[V],
        freshestAt: null,
        asOf: null,
        session,
        error: null,
      });
      return 'ok';
    }
    const list = result.data?.rows ?? ([] as ViewPayload[V]);
    setState({
      url,
      rows: list,
      freshestAt: freshestFrom(list as unknown[]),
      asOf,
      session,
      error: null,
    });
    return 'ok';
  }, [url, keepsLastSession, followsSession]);

  // The one final read after the close, and the retries of a transient failure
  // while closed (5 x 30 s); armed for as long as the view keeps the session.
  // It runs `fetchNow`, and reports that read's outcome itself, so only the
  // hook's own reads below go through `retryAfterFailure`.
  const retryAfterFailure = useFinalFetch(fetchNow, keepsLastSession);

  // The hook's own reads (mount, the open edge, a poll tick): a failure that
  // lands while the market is closed starts the retries, since no tick follows.
  // While open the 30 s poll is the retry. A read that comes back after the
  // flip to closed counts as closed. For a view that does not keep the session
  // `retryAfterFailure` does nothing.
  const readNow = useCallback(async () => {
    const outcome = await fetchNow();
    if (outcome !== 'ok' && !marketOpenNow.current) retryAfterFailure(outcome);
  }, [fetchNow, retryAfterFailure]);

  // Eager mount fetch — usePolling only schedules the recurring tick.
  useEffect(() => {
    // Leaving a URL drops its state, so coming back to it (even before the
    // other URL has answered) starts with no rows and a fresh retry count.
    setState((prev) => (prev?.url === url ? prev : null));
    void readNow();
  }, [readNow, url]);

  // The market opens (false to true): usePolling does not call fn on a gate
  // flip, so the first tick would be 30 s away. Read now. What the hook holds
  // at that moment is not shown while the read is out: `current` below drops it
  // on the flip's own render, so this effect only reads.
  // Mounting open is no edge: the mount effect already read. A flip that lands
  // while an earlier read of the same URL is still out (a tab loaded seconds
  // before 09:30) joins that request through `fetchDeduped`, so no second one
  // goes out.
  // `sibling-confirm` answers for a past fire time, not for the session, and
  // keeps its own retry gate.
  useEffect(() => {
    const opened = marketOpen && !wasMarketOpen.current;
    wasMarketOpen.current = marketOpen;
    if (!opened || !followsSession) return;
    void readNow();
  }, [marketOpen, followsSession, readNow]);

  // What the caller sees. State from a previous URL answers a different
  // question (another fire time): it reads as not loaded yet, not as this URL's
  // rows.
  //
  // With the market open, an answer that did not land in today's open session
  // is the last session's rows, or a failure from a closed hour, and reads as
  // not loaded yet as well. That check runs here, at render, with `marketOpen`
  // in the deps, so the render of the 09:30 ET flip already drops it. Clearing
  // the state in an effect after that render would paint it for a frame, with
  // no CLOSED label to say what it is. `useGexLandscapeData` and
  // `usePeriscopeExposure` make the same cut at render, by capture time against
  // today's open: this hook has no capture time on an error, nor on a view
  // without `asOf`, so it goes by the session the answer landed in.
  const current = useMemo(
    () =>
      state?.url === url &&
      !(followsSession && isBeforeOpenSession(state.session, marketOpen))
        ? state
        : null,
    [state, url, followsSession, marketOpen],
  );

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
      void readNow();
    },
    POLL_INTERVALS.OTM_FLOW, // 30_000 — matches the spec's requested cadence
    [view === 'sibling-confirm' ? siblingRetryDue : marketOpen],
  );

  return {
    rows: current?.rows ?? ([] as ViewPayload[V]),
    loading: current === null,
    error: current?.error?.message ?? null,
    freshestAt: current?.freshestAt ?? null,
    asOf: current?.asOf ?? null,
  };
}
