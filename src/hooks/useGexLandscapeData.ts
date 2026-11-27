/**
 * useGexLandscapeData — fetches the per-strike GEX landscape from the
 * 1-min GexBot-fed `/api/gex-landscape` endpoint and projects each row
 * into the `GexStrikeLevel` shape the GexLandscape renderer consumes.
 *
 * Phase 4 of the GEX Landscape 1-min GexBot rebuild
 * (docs/superpowers/specs/gex-landscape-1min-gexbot-rebuild-2026-05-26.md).
 *
 * The hook owns three responsibilities:
 *   1. Single-source fetch against `/api/gex-landscape` (no WS, no MM
 *      periscope fallback).
 *   2. Build the 5m / 15m / 30m Δ% maps from each row's `prevNm` fields,
 *      once per response in `deriveLandscape` (a `useMemo` on the stored
 *      response, so renders between responses return the same references)
 *      — gated by `DELTA_NOISE_FLOOR` so near-zero priors don't poison the
 *      table or the BiasPanel mean.
 *   3. Compute the per-strike vol-reinforcement classification during
 *      the same map-build pass — never recompute deltas downstream.
 *      See `computeVolReinforcement` for the agreement rule (Locked
 *      Decision #1 of the spec).
 *
 * Polling: live mode polls every POLL_INTERVALS.PERISCOPE (60s) while
 * `marketOpen` is true and we're not pinned to a scrubbed `at`.
 * Snapshot mode (`at` set) is one-shot. A session edge (`marketOpen`
 * flipping, open or close) refetches at once, so the panel never waits a
 * full poll interval holding the previous session's response.
 *
 * After the close the endpoint answers with the last session's panels and
 * their capture time, `asOf` (spec: gexbot-after-close-design). On the live
 * route only (`at` null) the hook:
 *  - exposes `asOf`;
 *  - drops a response whose newest capture (its `asOf`, else its last listed
 *    minute) is before today's open once the market is open: a tab carried
 *    over from the closed view, an edge-cached closed reply, a client clock
 *    ahead of the server's. The drop is made at render, so a response held
 *    across the 09:30 ET flip is gone on the flip's own render, before the
 *    refetch the flip starts has landed;
 *  - keeps one final fetch armed for close + 3 min, re-armed daily
 *    (`useFinalFetch`), because polling is off after the close;
 *  - keeps held strikes, with no error, when a fetch fails while the market is
 *    closed (the panel renders an error in place of the rows), and retries a
 *    transient failure 5 times, 30 s apart. With nothing held the error shows
 *    while the retries run;
 *  - refetches once when the ET date the panel follows rolls.
 * A closed reply's `ageSec` is hours (server now minus the capture), not a
 * stall: the panel applies the age rules only to a market-open reply.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getAccessMode } from '../utils/auth';
import { isCarriedOver, isTransientStatus } from '../utils/closed-session';
import { getErrorMessage } from '../utils/error';
import { useFinalFetch, type FinalFetchOutcome } from './useFinalFetch';
import { usePolling } from './usePolling';
import { computeVolReinforcement } from '../components/GexLandscape/classify';
import type { GexStrikeLevel } from '../components/GexLandscape/types';

/** Shape of a single strike row returned by /api/gex-landscape. */
export interface GexLandscapeStrikeRow {
  strike: number;
  gamma: number;
  charm: number;
  vanna: number;
  gammaPrev5m: number | null;
  gammaPrev15m: number | null;
  gammaPrev30m: number | null;
  charmPrev5m: number | null;
  charmPrev15m: number | null;
  charmPrev30m: number | null;
  vannaPrev5m: number | null;
  vannaPrev15m: number | null;
  vannaPrev30m: number | null;
}

/** Top-level /api/gex-landscape response. `data: null` when stale/missing. */
export interface GexLandscapeResponse {
  marketOpen: boolean;
  /**
   * The capture time of the data (`data`, or `no_spot`'s freshest panel); null
   * on `no_slot`, which no capture backs. After the close it is the last
   * session's.
   */
  asOf: string | null;
  data: { strikes: GexLandscapeStrikeRow[]; spot: number } | null;
  reason?: 'no_slot' | 'no_spot';
  /** Server now minus the capture. Hours on a closed reply: not a stall. */
  ageSec?: number;
  /**
   * `no_slot` only: how old the last `availableMinutes` entry is on the
   * server's clock, in whole seconds. Absent when the list is empty.
   */
  lastMinuteAgeSec?: number;
  availableMinutes: string[];
}

/**
 * How fresh the last live response was when it arrived. The panel adds the
 * time since `receivedAt` to `dataAgeMsAtReceipt` to show a measured age,
 * never the client clock against `asOf`.
 */
export interface GexLandscapeFreshness {
  /** Server's market-open flag for this response. */
  serverMarketOpen: boolean;
  reason: 'no_slot' | 'no_spot' | null;
  /**
   * Age of the capture when the response arrived:
   * (ageSec + the response's `Age` header) × 1000. Null when the response
   * carried no data, or a data response with no usable `ageSec`.
   */
  dataAgeMsAtReceipt: number | null;
  /**
   * `no_slot` responses only: how long ago the day's last capture minute
   * was when the response arrived, on the server's clock:
   * (the body's `lastMinuteAgeSec` + the response's `Age` header) × 1000.
   * The server measured the first term against its own `new Date()`, so no
   * client clock is involved. The minute stamp is truncated to the minute, so
   * this overstates the real capture age by up to 60 s; the panel allows for
   * that. Null on any other response, or when the body carries no usable
   * `lastMinuteAgeSec` (no capture today, an older server).
   */
  lastCaptureAgeMsAtReceipt: number | null;
  /** Date.now() when the response arrived. Used only as a delta. */
  receivedAt: number;
}

export interface UseGexLandscapeDataReturn {
  /**
   * Freshness of the stored response. Null before the first response, and
   * whenever that response was fetched with `at` (a scrub): a past minute's
   * age says nothing about the feed.
   */
  freshness: GexLandscapeFreshness | null;
  /**
   * The capture time of the live response, from its `asOf`: after the close,
   * the last session's. Null with `at` set (a scrub), for a response fetched
   * with `at`, for one dropped as carried over from a closed session, for a
   * `no_slot` (no capture backs it) and for an `asOf` that is not a timestamp.
   */
  asOf: string | null;
  strikes: GexStrikeLevel[];
  timestamps: string[];
  /** Δ% maps populated from the per-row `prevNm` fields. */
  gexDelta5mMap: Map<number, number | null>;
  gexDelta15mMap: Map<number, number | null>;
  gexDelta30mMap: Map<number, number | null>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Magnitude floor for the Δ% denominator. Strikes whose prior gamma
 * magnitude is below this floor produce huge meaningless percentages
 * (a +5 strike against a 0.1 prior reads 5,000% Δ); the floor maps
 * those to `null` so the BiasPanel mean and the StrikeTable cells
 * don't get poisoned.
 *
 * Calibrated 2026-05-26 against 24h of `gexbot_api_capture` SPX data:
 *   - p10 within ±50pt display window: 21.5
 *   - p25 within ±50pt display window: 66.9
 *   - p50 within ±50pt display window: 250.3
 * Setting the floor at 50 mutes the bottom ~20% of in-window strikes
 * (the noise source) while passing the median and above unscathed.
 * Half the legacy MM-scale floor of 100, matching the magnitude drop
 * from the legacy MM-attributed dealer math to GexBot's per-strike
 * values. Magnitude-only, so it does not depend on the sign convention.
 */
const DELTA_NOISE_FLOOR = 50;

/** Pure: compute one strike's Δ% against its own prev value. */
function computeDelta(current: number, prev: number | null): number | null {
  if (prev == null || Math.abs(prev) < DELTA_NOISE_FLOOR) return null;
  return ((current - prev) / Math.abs(prev)) * 100;
}

/**
 * Project an endpoint strike row into the `GexStrikeLevel` shape the
 * GexLandscape renderer consumes.
 *
 * - Endpoint `gamma` → `netGamma`, `charm` → `netCharm`, `vanna` → `netVanna`.
 *   The endpoint serves all three in GEXBot's taker-side sign
 *   (positive = traders net long that Greek), never negated.
 * - `price` ← top-level `spot` from the endpoint payload.
 * - All call/put split fields stay zero — WS side channel is gone and
 *   GexBot's state rows carry no call/put Greek split.
 * - `volReinforcement` is computed from the row's three pre-computed
 *   deltas via `computeVolReinforcement` (delta-trend agreement per
 *   Locked Decision #1). Caller supplies the three Δ% values so the
 *   hook doesn't have to recompute them.
 */
export function projectStrike(
  row: GexLandscapeStrikeRow,
  spot: number,
  delta5m: number | null,
  delta15m: number | null,
  delta30m: number | null,
): GexStrikeLevel {
  const volReinforcement = computeVolReinforcement({
    netGamma: row.gamma,
    delta5m,
    delta15m,
    delta30m,
  });
  return {
    strike: row.strike,
    price: spot,
    callGammaOi: 0,
    putGammaOi: 0,
    netGamma: row.gamma,
    callGammaVol: 0,
    putGammaVol: 0,
    netGammaVol: 0,
    volReinforcement,
    callGammaAsk: 0,
    callGammaBid: 0,
    putGammaAsk: 0,
    putGammaBid: 0,
    callCharmOi: 0,
    putCharmOi: 0,
    netCharm: row.charm,
    callCharmVol: 0,
    putCharmVol: 0,
    netCharmVol: 0,
    callDeltaOi: 0,
    putDeltaOi: 0,
    netDelta: 0,
    callVannaOi: 0,
    putVannaOi: 0,
    netVanna: row.vanna,
    callVannaVol: 0,
    putVannaVol: 0,
    netVannaVol: 0,
  };
}

/** A parsed response plus the seconds it already sat at the edge cache. */
interface FetchedLandscape {
  body: GexLandscapeResponse;
  /** The response's `Age` header in seconds; 0 when absent or unusable. */
  edgeAgeSec: number;
}

/** A stored response, keyed on the `at` it was fetched with (R6). */
interface StoredLandscape {
  body: GexLandscapeResponse;
  /** The `at` this response was fetched with; null = a live fetch. */
  requestedAt: string | null;
  freshness: GexLandscapeFreshness;
}

/** Parse an `Age` header (whole seconds). Absent or unusable counts as 0. */
function parseAgeHeader(raw: string | null): number {
  if (raw == null) return 0;
  const sec = Number.parseInt(raw, 10);
  return Number.isFinite(sec) && sec > 0 ? sec : 0;
}

/**
 * Pure: how old the day's last capture minute is on a `no_slot` response, on
 * the server's clock: the body's `lastMinuteAgeSec` plus the edge age. Null for
 * any other response, or when the body carries no usable age. Never negative.
 * (`asOf` is null on `no_slot`, so it cannot be the clock reading.)
 */
function lastCaptureAgeMs(
  fetched: FetchedLandscape,
): GexLandscapeFreshness['lastCaptureAgeMsAtReceipt'] {
  const { body, edgeAgeSec } = fetched;
  if (body.data != null || body.reason !== 'no_slot') return null;
  if (body.lastMinuteAgeSec == null) return null;
  return (Math.max(0, body.lastMinuteAgeSec) + edgeAgeSec) * 1000;
}

/** Pure: measure a response's freshness at the moment it arrived. */
function buildFreshness(
  fetched: FetchedLandscape,
  receivedAt: number,
): GexLandscapeFreshness {
  const { body, edgeAgeSec } = fetched;
  // Only a response that carries data has a capture age.
  const ageSec = body.data != null ? body.ageSec : undefined;
  return {
    serverMarketOpen: body.marketOpen,
    reason: body.reason ?? null,
    dataAgeMsAtReceipt:
      ageSec != null && Number.isFinite(ageSec)
        ? (ageSec + edgeAgeSec) * 1000
        : null,
    lastCaptureAgeMsAtReceipt: lastCaptureAgeMs(fetched),
    receivedAt,
  };
}

/** What the panel reads from one response, built once per response. */
interface DerivedLandscape {
  strikes: GexStrikeLevel[];
  timestamps: string[];
  gexDelta5mMap: Map<number, number | null>;
  gexDelta15mMap: Map<number, number | null>;
  gexDelta30mMap: Map<number, number | null>;
}

/**
 * Pure: project a response into the strikes, capture minutes and Δ% maps.
 * The deltas are computed once per row and threaded into `projectStrike` so
 * vol-reinforcement uses the SAME values that populate the maps, never
 * recomputed downstream.
 */
function deriveLandscape(resp: GexLandscapeResponse | null): DerivedLandscape {
  const sourceRows = resp?.data?.strikes ?? [];
  const spot = resp?.data?.spot ?? 0;
  const gexDelta5mMap = new Map<number, number | null>();
  const gexDelta15mMap = new Map<number, number | null>();
  const gexDelta30mMap = new Map<number, number | null>();
  const strikes: GexStrikeLevel[] = [];
  for (const row of sourceRows) {
    const d5 = computeDelta(row.gamma, row.gammaPrev5m);
    const d15 = computeDelta(row.gamma, row.gammaPrev15m);
    const d30 = computeDelta(row.gamma, row.gammaPrev30m);
    gexDelta5mMap.set(row.strike, d5);
    gexDelta15mMap.set(row.strike, d15);
    gexDelta30mMap.set(row.strike, d30);
    strikes.push(projectStrike(row, spot, d5, d15, d30));
  }
  return {
    strikes,
    timestamps: resp?.availableMinutes ?? [],
    gexDelta5mMap,
    gexDelta15mMap,
    gexDelta30mMap,
  };
}

/**
 * A non-2xx answer. It carries the status so the failure handler can tell a
 * retryable failure (5xx, 408, 429) from a refused request, instead of
 * matching the message.
 */
class GexLandscapeHttpError extends Error {
  constructor(public status: number) {
    super(`gex-landscape: HTTP ${status}`);
    this.name = 'GexLandscapeHttpError';
  }
}

/** `raw` when it is a timestamp, else null. */
function asOfFrom(raw: unknown): string | null {
  return typeof raw === 'string' && Number.isFinite(Date.parse(raw))
    ? raw
    : null;
}

/**
 * The parsed body with the fields the hook reads checked. The body is an
 * unchecked cast, so a wrong type would otherwise reach the carried-over check
 * and the stall age: an `asOf` that is no timestamp reads as none, a missing
 * minute list as an empty one, an age that is no finite number as absent.
 */
function checkBody(raw: GexLandscapeResponse): GexLandscapeResponse {
  const age = raw.lastMinuteAgeSec;
  return {
    ...raw,
    asOf: asOfFrom(raw.asOf),
    lastMinuteAgeSec:
      typeof age === 'number' && Number.isFinite(age) ? age : undefined,
    availableMinutes: Array.isArray(raw.availableMinutes)
      ? raw.availableMinutes
      : [],
  };
}

/**
 * Pure: the newest capture a response carries, for the carried-over check: its
 * `asOf`, else its last listed minute (a `no_slot` has no `asOf`).
 */
function newestCapture(body: GexLandscapeResponse): string | null {
  return body.asOf ?? body.availableMinutes.at(-1) ?? null;
}

async function fetchGexLandscape(
  at: string | null,
  signal: AbortSignal,
): Promise<FetchedLandscape | null> {
  const qs = new URLSearchParams();
  if (at != null) qs.set('at', at);
  const url = qs.toString()
    ? `/api/gex-landscape?${qs.toString()}`
    : '/api/gex-landscape';
  const res = await fetch(url, {
    credentials: 'same-origin',
    signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
  });
  if (!res.ok) {
    if (res.status === 401) return null;
    throw new GexLandscapeHttpError(res.status);
  }
  return {
    body: checkBody((await res.json()) as GexLandscapeResponse),
    edgeAgeSec: parseAgeHeader(res.headers.get('Age')),
  };
}

/**
 * What the hook holds: the stored response and the error of the latest failed
 * fetch. One state, so a failure can look at the response it leaves in place.
 */
interface LandscapeState {
  stored: StoredLandscape | null;
  error: string | null;
}

/** True when the stored response is a live one that carries strikes. */
function holdsLiveStrikes(stored: StoredLandscape | null): boolean {
  return (
    stored != null && stored.requestedAt == null && stored.body.data != null
  );
}

export function useGexLandscapeData(
  marketOpen: boolean,
  // The ET date the panel follows (its `selectedDate`). /api/gex-landscape
  // resolves the session server-side, so the date is never sent; it is a
  // trigger: when it rolls at ET midnight the hook refetches once, so the
  // panel, which clears its mirrored scrub list at the roll, gets a response
  // (and a new `timestamps` array) to refill it from.
  etDate: string,
  at: string | null = null,
): UseGexLandscapeDataReturn {
  const accessMode = getAccessMode();
  const [{ stored, error }, setState] = useState<LandscapeState>({
    stored: null,
    error: null,
  });
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  // marketOpen as of the latest render, for a fetch that fails after the
  // market flipped (usePolling's latest-value pattern).
  const marketOpenNow = useRef(marketOpen);
  marketOpenNow.current = marketOpen;

  /**
   * One read. Resolves to what the request itself came to: 'ok' also for one
   * a newer read superseded (the newer one answers for itself), 'transient'
   * for a failure another try can clear, 'failed' for a refused request
   * (a 401 included). It never rejects.
   */
  const fetchOnce = useCallback(async (): Promise<FinalFetchOutcome> => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const next = await fetchGexLandscape(at, ctrl.signal);
      if (!mountedRef.current || ctrl.signal.aborted) return 'ok';
      setState({
        stored:
          next == null
            ? null
            : {
                body: next.body,
                requestedAt: at,
                freshness: buildFreshness(next, Date.now()),
              },
        error: null,
      });
      return next == null ? 'failed' : 'ok';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'ok';
      if (ctrl.signal.aborted) return 'ok';
      // A thrown HTTP status says whether another try can help; anything else
      // (no response, a timeout, a body that is not JSON) counts as 0, which
      // does.
      const status = err instanceof GexLandscapeHttpError ? err.status : 0;
      if (mountedRef.current) {
        const message = getErrorMessage(err);
        // After the close polling is off, so an error would stay up all
        // evening in place of rows that are still the session's last (the
        // panel renders an error before the strikes): hold them and say
        // nothing. Not for a scrub, and not for a scrubbed response left in
        // place by leaving one: it is no live strikes.
        const closed = at == null && !marketOpenNow.current;
        setState((prev) => ({
          stored: prev.stored,
          error: closed && holdsLiveStrikes(prev.stored) ? null : message,
        }));
      }
      return isTransientStatus(status) ? 'transient' : 'failed';
    } finally {
      if (mountedRef.current && abortRef.current === ctrl) setLoading(false);
    }
  }, [at]);

  // The one final read after the close, and the retries of a transient failure
  // while closed (5 x 30 s). Live route only: a scrub reads a past minute, and
  // a public visitor makes no request. It runs `fetchOnce` and takes that
  // read's own outcome, so only the hook's own reads below go through
  // `retryAfterFailure`.
  const retryAfterFailure = useFinalFetch(
    fetchOnce,
    at == null && accessMode !== 'public',
  );

  // The hook's own reads (mount, a session edge, the date roll, a poll tick,
  // refresh): a failure that lands while the market is closed starts the
  // retries, since no tick follows. While open the 60 s poll is the retry. A
  // read that comes back after the flip to closed counts as closed.
  const readNow = useCallback(async () => {
    const outcome = await fetchOnce();
    if (outcome !== 'ok' && !marketOpenNow.current) retryAfterFailure(outcome);
  }, [fetchOnce, retryAfterFailure]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Fetches at mount, and again whenever `at` changes (via `fetchOnce`),
  // `marketOpen` flips or the ET date rolls: each session edge refetches.
  // `usePolling` never fetches when its gates flip, so without this dep a panel
  // left open across the open would hold the previous session's response for
  // up to POLL_INTERVALS.PERISCOPE after the open. The effect reads neither
  // `marketOpen` nor `etDate`; they are triggers, not inputs.
  useEffect(() => {
    if (accessMode === 'public') {
      setLoading(false);
      return;
    }
    void readNow();
  }, [accessMode, readNow, marketOpen, etDate]);

  // Snapshot mode (`at` set) is static — no polling. Public access stays idle.
  usePolling(() => void readNow(), POLL_INTERVALS.PERISCOPE, [
    accessMode !== 'public',
    marketOpen,
    !at,
  ]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const refresh = useCallback(() => {
    setLoading(true);
    void readNow();
  }, [readNow]);

  // Derived state, built once per stored response and per session edge. It
  // must be memoized, for identity and not for cost (the work is O(N strikes),
  // N≈40): the panel's effects depend on these references. `timestamps` is
  // mirrored into state by an effect, and `strikes` feeds the Top 5 tracker's
  // effect through `topFive`. Rebuilt on every render, a fresh `[]` / array
  // per render re-fires those effects, each sets state, and the panel
  // re-renders in a loop (hundreds to thousands of commits a second). Keyed on
  // the stored response, every render between responses returns the same
  // arrays and Maps.
  //
  // The carried-over check lives here, at render, with `marketOpen` in the
  // deps: a response held across the 09:30 ET flip is dropped on the flip's own
  // render, before the refetch the flip starts has landed, so the panel never
  // shows the last session's strikes as live. It applies to a response fetched
  // without `at` (a scrubbed one is a past minute by design), and the clock it
  // reads only matters at the edge, which re-evaluates it.
  const view = useMemo(() => {
    const body = stored?.body ?? null;
    const isLiveResponse = stored != null && stored.requestedAt == null;
    const carriedOver =
      isLiveResponse &&
      body != null &&
      isCarriedOver(newestCapture(body), marketOpen, new Date());
    return {
      ...deriveLandscape(carriedOver ? null : body),
      asOf: isLiveResponse && !carriedOver ? (body?.asOf ?? null) : null,
      carriedOver,
    };
  }, [stored, marketOpen]);
  // Freshness describes the live feed, so a response fetched with `at` has
  // none. Keyed on the `at` the response was fetched with, not the current
  // one: after a scrub ends, the old scrubbed response stays stored until
  // the live one lands, and its age must not read as live. A response dropped
  // as carried over has none either: its age (hours, from a closed session, or
  // from last evening's in-session reply) must not read as a stall.
  const freshness =
    stored != null && stored.requestedAt == null && !view.carriedOver
      ? stored.freshness
      : null;

  return {
    freshness,
    asOf: at == null ? view.asOf : null,
    strikes: view.strikes,
    timestamps: view.timestamps,
    gexDelta5mMap: view.gexDelta5mMap,
    gexDelta15mMap: view.gexDelta15mMap,
    gexDelta30mMap: view.gexDelta30mMap,
    loading,
    error,
    refresh,
  };
}
