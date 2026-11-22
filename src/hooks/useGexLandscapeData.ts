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
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getAccessMode } from '../utils/auth';
import { getErrorMessage } from '../utils/error';
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
  asOf: string;
  data: { strikes: GexLandscapeStrikeRow[]; spot: number } | null;
  reason?: 'no_slot' | 'no_spot';
  ageSec?: number;
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
   * (Date.parse(asOf) − Date.parse(last availableMinutes entry) + the
   * response's `Age` header) × 1000. On `no_slot`, `asOf` is the server's own
   * `new Date()`, so no client clock is involved. The minute stamp is
   * truncated to the minute, so this overstates the real capture age by up
   * to 60 s; the panel allows for that. Null on any other response, or when
   * the day has no capture or either timestamp does not parse.
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
 * the server's clock. Null for any other response, or when a timestamp does
 * not parse. Never negative.
 */
function lastCaptureAgeMs(
  fetched: FetchedLandscape,
): GexLandscapeFreshness['lastCaptureAgeMsAtReceipt'] {
  const { body, edgeAgeSec } = fetched;
  if (body.data != null || body.reason !== 'no_slot') return null;
  // The body is an unchecked cast, so a malformed reply can lack the list:
  // treat that as no capture minute, never as a throw.
  const last = (body.availableMinutes ?? []).at(-1);
  if (last == null) return null;
  const sinceStampMs = Date.parse(body.asOf) - Date.parse(last);
  if (!Number.isFinite(sinceStampMs)) return null;
  return Math.max(0, sinceStampMs) + edgeAgeSec * 1000;
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
    throw new Error(`gex-landscape: HTTP ${res.status}`);
  }
  return {
    body: (await res.json()) as GexLandscapeResponse,
    edgeAgeSec: parseAgeHeader(res.headers.get('Age')),
  };
}

export function useGexLandscapeData(
  marketOpen: boolean,
  // `_expiry` kept on the signature for component-call-site compat
  // (Phase 4 drops it). /api/gex-landscape resolves the expiry
  // server-side from `getETDateStr(new Date())` since 0DTE-only.
  _expiry: string,
  at: string | null = null,
): UseGexLandscapeDataReturn {
  const accessMode = getAccessMode();
  const [stored, setStored] = useState<StoredLandscape | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const next = await fetchGexLandscape(at, ctrl.signal);
      if (!mountedRef.current || ctrl.signal.aborted) return;
      setStored(
        next == null
          ? null
          : {
              body: next.body,
              requestedAt: at,
              freshness: buildFreshness(next, Date.now()),
            },
      );
      setError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (ctrl.signal.aborted) return;
      if (mountedRef.current) setError(getErrorMessage(err));
    } finally {
      if (mountedRef.current && abortRef.current === ctrl) setLoading(false);
    }
  }, [at]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Fetches at mount, and again whenever `at` changes (via `fetchOnce`) or
  // `marketOpen` flips: each session edge refetches. `usePolling` never
  // fetches when its gates flip, so without this dep a panel left open across
  // the open would hold the previous session's response for up to
  // POLL_INTERVALS.PERISCOPE after the open. The effect doesn't read
  // `marketOpen`; it is a trigger, not an input.
  useEffect(() => {
    if (accessMode === 'public') {
      setLoading(false);
      return;
    }
    void fetchOnce();
  }, [accessMode, fetchOnce, marketOpen]);

  // Snapshot mode (`at` set) is static — no polling. Public access stays idle.
  usePolling(() => void fetchOnce(), POLL_INTERVALS.PERISCOPE, [
    accessMode !== 'public',
    marketOpen,
    !at,
  ]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const refresh = useCallback(() => {
    setLoading(true);
    void fetchOnce();
  }, [fetchOnce]);

  // Derived state, built once per stored response. It must be memoized, for
  // identity and not for cost (the work is O(N strikes), N≈40): the panel's
  // effects depend on these references. `timestamps` is mirrored into state
  // by an effect, and `strikes` feeds the Top 5 tracker's effect through
  // `topFive`. Rebuilt on every render, a fresh `[]` / array per render
  // re-fires those effects, each sets state, and the panel re-renders in a
  // loop (hundreds to thousands of commits a second). Keyed on the response
  // object, every render between responses returns the same arrays and Maps.
  const resp = stored?.body ?? null;
  const { strikes, timestamps, gexDelta5mMap, gexDelta15mMap, gexDelta30mMap } =
    useMemo(() => deriveLandscape(resp), [resp]);
  // Freshness describes the live feed, so a response fetched with `at` has
  // none. Keyed on the `at` the response was fetched with, not the current
  // one: after a scrub ends, the old scrubbed response stays stored until
  // the live one lands, and its age must not read as live.
  const freshness =
    stored != null && stored.requestedAt == null ? stored.freshness : null;

  return {
    freshness,
    strikes,
    timestamps,
    gexDelta5mMap,
    gexDelta15mMap,
    gexDelta30mMap,
    loading,
    error,
    refresh,
  };
}
