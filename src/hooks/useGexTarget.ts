/**
 * useGexTarget — fetches /api/gex-target-history for the GexTarget widget.
 *
 * Returns the three parallel per-mode `TargetScore` payloads (OI / VOL / DIR),
 * plus the SPX 1-minute candles and scrub controls the panel needs to render
 * its five sub-panels. Owner-only — skips polling for public visitors.
 *
 * **Three-mode contract.** The Phase 5 endpoint computes and returns all
 * three modes for every snapshot. This hook passes them through as three
 * separate fields (`oi`, `vol`, `dir`) rather than picking one based on a
 * "current mode" parameter. The component is responsible for deciding which
 * mode to render. Switching modes is therefore a pure UI toggle with no
 * refetch, which matters both for ML fidelity (we always have all three)
 * and for test reuse (mode toggle is not a hook concern).
 *
 * Effect dispatch:
 *   1. Not owner          → no fetch.
 *   2. Date change        → bulk-load all snapshots (`?all=true`), populate cache.
 *   3. Live polling       → setInterval fires `fetchData` when market is open,
 *                           today, and not scrubbed; updates cache on each poll.
 *   4. Scrub              → instant from cache; fallback single fetch on miss.
 *
 * Like `useGexPerStrike`, this hook owns its own `selectedDate` state —
 * the GexTarget panel is a live/backtest browsing tool, and picking a past
 * date here should NOT re-anchor the calculator's Black-Scholes math. The
 * `initialDate` parameter only seeds the state once at mount; after that,
 * the returned `setSelectedDate` is the only way to change it. Production
 * passes no `initialDate`; tests pass a fixed date for deterministic
 * branch coverage.
 *
 * Live-ness has TWO independent signals:
 *   - The dispatch ladder decides whether the panel is *trying* to be
 *     live (i.e., whether `setInterval` is running).
 *   - A wall-clock freshness check (STALE_THRESHOLD_MS) decides whether
 *     the displayed snapshot is *actually* live. This is defense-in-depth
 *     — it catches the case where polling silently fails (network error,
 *     backgrounded tab throttling) and prevents the badge from lying.
 *
 * The server returns `timestamps[]` (every snapshot for the day, ascending)
 * and `availableDates[]` (every date with rows in `gex_target_features`).
 * Both are cached so the scrubber and the date picker can operate without
 * extra round-trips.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { checkIsOwner } from '../utils/auth';
import { getETToday } from '../utils/timezone';
import { useScrubController } from './useScrubController';
import { useWallClockFreshness } from './useWallClockFreshness';
import { usePolling } from './usePolling';
import type {
  ComponentScores,
  MagnetFeatures,
  StrikeScore,
  TargetScore,
  Tier,
  WallSide,
} from '../utils/gex-target';

/**
 * A snapshot is considered "live" only if its timestamp is within this many
 * milliseconds of the wall clock. Generous enough to absorb a missed poll
 * (POLL_INTERVALS.GEX_TARGET is 60s) without flickering.
 */
const STALE_THRESHOLD_MS = 2 * 60 * 1000;

/**
 * Cadence for the wall-clock re-render ticker. Half the freshness threshold
 * so the badge flips within ~30s of going stale, but light enough that the
 * resulting re-renders are negligible.
 */
const WALL_CLOCK_TICK_MS = 30 * 1000;

/**
 * Number of consecutive poll failures before the error banner surfaces.
 * The GEX Target widget polls once per POLL_INTERVALS.GEX_TARGET (60s);
 * a single transient Neon hang shouldn't flash "signal timed out".
 * Mirrors the same constant on useGexStrikeExpiry.
 */
const FAIL_GRACE_COUNT = 2;

/**
 * SPX 1-minute candle as returned by the /api/gex-target-history endpoint.
 * Mirrors the shape defined server-side in `api/_lib/spx-candles.ts` — kept
 * as a local frontend copy so the hook doesn't cross the `src/` -> `api/`
 * import boundary.
 */
// SPXCandle lifted to src/types/spx-candle.ts (Phase 3C). Re-exported
// here so existing callers (PriceChart, GexTarget/index, candle-momentum
// tests, etc.) keep working.
export type { SPXCandle } from '../types/spx-candle.js';
import type { SPXCandle } from '../types/spx-candle.js';

/**
 * Single snapshot as returned inside the bulk `?all=true` response.
 * Local frontend copy -- mirrors the server-side shape without crossing the
 * `src/` -> `api/` import boundary.
 */
interface BulkSnapshot {
  timestamp: string;
  spot: number | null;
  oi: TargetScore | null;
  vol: TargetScore | null;
  dir: TargetScore | null;
}

/**
 * Response payload shape from `GET /api/gex-target-history?all=true`. Local
 * copy kept in sync with the server-side canonical definition.
 */
interface GexTargetBulkResponse {
  availableDates: string[];
  date: string | null;
  timestamps: string[];
  candles: SPXCandle[];
  previousClose: number | null;
  snapshots: BulkSnapshot[];
}

/**
 * Response payload shape from `GET /api/gex-target-history`. Local copy of
 * the server-side `GexTargetHistoryResponse` interface -- keeping the two in
 * sync is part of Phase 6 maintenance. See `api/gex-target-history.ts` for
 * the canonical definition and per-field semantics.
 */
interface GexTargetHistoryResponse {
  availableDates: string[];
  date: string | null;
  timestamps: string[];
  timestamp: string | null;
  spot: number | null;
  oi: TargetScore | null;
  vol: TargetScore | null;
  dir: TargetScore | null;
  candles: SPXCandle[];
  previousClose: number | null;
}

// ── Response validation ────────────────────────────────────────
//
// Both `/api/gex-target-history` parses used to be identity casts, so a
// shapeless body (a 5xx JSON blob, a loosely-parsed HTML error page, a
// truncated payload) flowed straight into the render pass and threw:
//   - `selectTarget(raw.leaderboard, …)` → `leaderboard.length` of undefined
//     (src/utils/gex-target/select-target.ts:97)
//   - `computeAttractingMomentum(s.features)` → `.gexDollars` of undefined
//     (src/utils/gex-target/scorers.ts:222)
//   - `timestamps.at(-1)` when `timestamps` arrived as a non-array
//     (src/hooks/useScrubController.ts:82)
// Validation now happens at the parse (the `validateSpike` pattern in
// src/hooks/useVegaSpikes.ts): bad rows are dropped, a bad envelope leaves
// the last-known-good state untouched and routes to this hook's existing
// error path.
//
// Faithfulness to `api/gex-target-history.ts` — over-strict validation
// would be worse than the crash, so:
//   - `availableDates`, `timestamps` and `candles` are present on ALL FOUR
//     of the handler's return paths (empty-DB, no-rows-for-date, single,
//     bulk), so requiring them cannot reject a legitimate payload.
//   - `snapshots` is NOT: the empty-DB and no-rows-for-date paths return the
//     single-snapshot shape even when `?all=true` was requested. It is
//     therefore optional and defaults to `[]`.
//   - The MagnetFeatures numerics the server builds with `num()` coerce a
//     NULL column to 0 before serializing, and a NUMERIC 'NaN' serializes
//     as JSON null. Accepting `number | null` and coalescing null to 0 is
//     strictly more permissive than the server's own semantics.

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNullableFiniteNumber(v: unknown): v is number | null {
  return v === null || isFiniteNumber(v);
}

/** Array of strings with non-string entries dropped; `null` if not an array. */
function toStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((s): s is string => typeof s === 'string');
}

const TIERS: readonly unknown[] = ['HIGH', 'MEDIUM', 'LOW', 'NONE'];
const WALL_SIDES: readonly unknown[] = ['CALL', 'PUT', 'NEUTRAL'];

/** Zeroed component scores — the shape `groupRowsByMode` itself emits. */
function zeroComponents(): ComponentScores {
  return {
    flowConfluence: 0,
    priceConfirm: 0,
    charmScore: 0,
    dominance: 0,
    clarity: 0,
    proximity: 0,
  };
}

function validateComponents(raw: unknown): ComponentScores {
  if (typeof raw !== 'object' || raw === null) return zeroComponents();
  const r = raw as Record<string, unknown>;
  return {
    flowConfluence: isFiniteNumber(r.flowConfluence) ? r.flowConfluence : 0,
    priceConfirm: isFiniteNumber(r.priceConfirm) ? r.priceConfirm : 0,
    charmScore: isFiniteNumber(r.charmScore) ? r.charmScore : 0,
    dominance: isFiniteNumber(r.dominance) ? r.dominance : 0,
    clarity: isFiniteNumber(r.clarity) ? r.clarity : 0,
    proximity: isFiniteNumber(r.proximity) ? r.proximity : 0,
  };
}

/**
 * Every field the scorers read arithmetically. `strike` must be a genuine
 * finite number — it is a Map key, a price-line value in PriceChart, and a
 * table row key — so a row without one is unusable and gets dropped.
 */
function validateFeatures(raw: unknown): MagnetFeatures | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    !isFiniteNumber(r.strike) ||
    !isNullableFiniteNumber(r.spot) ||
    !isNullableFiniteNumber(r.distFromSpot) ||
    !isNullableFiniteNumber(r.gexDollars) ||
    !isNullableFiniteNumber(r.callGexDollars) ||
    !isNullableFiniteNumber(r.putGexDollars) ||
    !isNullableFiniteNumber(r.callDelta) ||
    !isNullableFiniteNumber(r.putDelta) ||
    !isNullableFiniteNumber(r.deltaGex_1m) ||
    !isNullableFiniteNumber(r.deltaGex_5m) ||
    !isNullableFiniteNumber(r.deltaGex_20m) ||
    !isNullableFiniteNumber(r.deltaGex_60m) ||
    !isNullableFiniteNumber(r.prevGexDollars_1m) ||
    !isNullableFiniteNumber(r.prevGexDollars_5m) ||
    !isNullableFiniteNumber(r.prevGexDollars_10m) ||
    !isNullableFiniteNumber(r.prevGexDollars_15m) ||
    !isNullableFiniteNumber(r.prevGexDollars_20m) ||
    !isNullableFiniteNumber(r.prevGexDollars_60m) ||
    !isNullableFiniteNumber(r.deltaPct_1m) ||
    !isNullableFiniteNumber(r.deltaPct_5m) ||
    !isNullableFiniteNumber(r.deltaPct_20m) ||
    !isNullableFiniteNumber(r.deltaPct_60m) ||
    !isNullableFiniteNumber(r.callRatio) ||
    !isNullableFiniteNumber(r.charmNet) ||
    !isNullableFiniteNumber(r.deltaNet) ||
    !isNullableFiniteNumber(r.vannaNet) ||
    !isNullableFiniteNumber(r.minutesAfterNoonCT)
  ) {
    return null;
  }
  return {
    strike: r.strike,
    // NOT-NULL server columns — `?? 0` mirrors the server's own `num()`
    // handling of a NULL/NaN value, so nothing legitimate is lost.
    spot: r.spot ?? 0,
    distFromSpot: r.distFromSpot ?? 0,
    gexDollars: r.gexDollars ?? 0,
    callGexDollars: r.callGexDollars ?? 0,
    putGexDollars: r.putGexDollars ?? 0,
    callRatio: r.callRatio ?? 0,
    charmNet: r.charmNet ?? 0,
    deltaNet: r.deltaNet ?? 0,
    vannaNet: r.vannaNet ?? 0,
    minutesAfterNoonCT: r.minutesAfterNoonCT ?? 0,
    // Genuinely nullable columns — null is a meaningful "unavailable".
    callDelta: r.callDelta,
    putDelta: r.putDelta,
    deltaGex_1m: r.deltaGex_1m,
    deltaGex_5m: r.deltaGex_5m,
    deltaGex_20m: r.deltaGex_20m,
    deltaGex_60m: r.deltaGex_60m,
    prevGexDollars_1m: r.prevGexDollars_1m,
    prevGexDollars_5m: r.prevGexDollars_5m,
    prevGexDollars_10m: r.prevGexDollars_10m,
    prevGexDollars_15m: r.prevGexDollars_15m,
    prevGexDollars_20m: r.prevGexDollars_20m,
    prevGexDollars_60m: r.prevGexDollars_60m,
    deltaPct_1m: r.deltaPct_1m,
    deltaPct_5m: r.deltaPct_5m,
    deltaPct_20m: r.deltaPct_20m,
    deltaPct_60m: r.deltaPct_60m,
  };
}

/**
 * `components`, `finalScore`, `tier`, `wallSide` and `isTarget` are all
 * recomputed browser-side by `selectTarget` before anything renders, so a
 * bad value degrades to a neutral default rather than dropping the row.
 * Only `features` (and the `strike` inside it) is load-bearing.
 */
function validateStrikeScore(raw: unknown): StrikeScore | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const features = validateFeatures(r.features);
  if (features == null) return null;
  return {
    strike: isFiniteNumber(r.strike) ? r.strike : features.strike,
    features,
    components: validateComponents(r.components),
    finalScore: isFiniteNumber(r.finalScore) ? r.finalScore : 0,
    tier: TIERS.includes(r.tier) ? (r.tier as Tier) : 'NONE',
    wallSide: WALL_SIDES.includes(r.wallSide)
      ? (r.wallSide as WallSide)
      : 'NEUTRAL',
    rankByScore: isFiniteNumber(r.rankByScore) ? r.rankByScore : 0,
    rankBySize: isFiniteNumber(r.rankBySize) ? r.rankBySize : 0,
    isTarget: r.isTarget === true,
  };
}

/** A mode's TargetScore. Bad rows are dropped; a non-array leaderboard is fatal for the mode only. */
function validateTargetScore(raw: unknown): TargetScore | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.leaderboard)) return null;
  const leaderboard: StrikeScore[] = [];
  for (const row of r.leaderboard) {
    const score = validateStrikeScore(row);
    if (score) leaderboard.push(score);
  }
  return { target: validateStrikeScore(r.target), leaderboard };
}

function validateCandle(raw: unknown): SPXCandle | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    !isFiniteNumber(r.open) ||
    !isFiniteNumber(r.high) ||
    !isFiniteNumber(r.low) ||
    !isFiniteNumber(r.close) ||
    !isFiniteNumber(r.volume) ||
    !isFiniteNumber(r.datetime)
  ) {
    return null;
  }
  return {
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    datetime: r.datetime,
  };
}

/** Fields shared by the single-snapshot and bulk response shapes. */
interface GexTargetEnvelope {
  availableDates: string[];
  date: string | null;
  timestamps: string[];
  candles: SPXCandle[];
  previousClose: number | null;
}

function validateEnvelope(raw: unknown): GexTargetEnvelope | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const availableDates = toStringArray(r.availableDates);
  const timestamps = toStringArray(r.timestamps);
  if (
    availableDates == null ||
    timestamps == null ||
    !Array.isArray(r.candles)
  ) {
    return null;
  }
  const candles: SPXCandle[] = [];
  for (const row of r.candles) {
    const candle = validateCandle(row);
    if (candle) candles.push(candle);
  }
  return {
    availableDates,
    date: typeof r.date === 'string' ? r.date : null,
    timestamps,
    candles,
    previousClose: isNullableFiniteNumber(r.previousClose)
      ? r.previousClose
      : null,
  };
}

function validateHistoryResponse(
  raw: unknown,
): GexTargetHistoryResponse | null {
  const envelope = validateEnvelope(raw);
  if (envelope == null) return null;
  const r = raw as Record<string, unknown>;
  return {
    ...envelope,
    timestamp: typeof r.timestamp === 'string' ? r.timestamp : null,
    spot: isNullableFiniteNumber(r.spot) ? r.spot : null,
    oi: validateTargetScore(r.oi),
    vol: validateTargetScore(r.vol),
    dir: validateTargetScore(r.dir),
  };
}

function validateBulkSnapshot(raw: unknown): BulkSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  // The timestamp is the snapshot cache key and the scrub target — a
  // snapshot without one cannot be addressed, so it is dropped.
  if (typeof r.timestamp !== 'string') return null;
  return {
    timestamp: r.timestamp,
    spot: isNullableFiniteNumber(r.spot) ? r.spot : null,
    oi: validateTargetScore(r.oi),
    vol: validateTargetScore(r.vol),
    dir: validateTargetScore(r.dir),
  };
}

function validateBulkResponse(raw: unknown): GexTargetBulkResponse | null {
  const envelope = validateEnvelope(raw);
  if (envelope == null) return null;
  const r = raw as Record<string, unknown>;
  const snapshots: BulkSnapshot[] = [];
  // Optional by design — see the faithfulness note above.
  if (Array.isArray(r.snapshots)) {
    for (const row of r.snapshots) {
      const snapshot = validateBulkSnapshot(row);
      if (snapshot) snapshots.push(snapshot);
    }
  }
  return { ...envelope, snapshots };
}

export interface UseGexTargetReturn {
  // -- Three-mode parallel results
  /** OI-mode TargetScore for the displayed snapshot, or null when empty. */
  oi: TargetScore | null;
  /** VOL-mode TargetScore for the displayed snapshot, or null when empty. */
  vol: TargetScore | null;
  /** DIR-mode TargetScore for the displayed snapshot, or null when empty. */
  dir: TargetScore | null;

  // -- Snapshot context
  /** Spot price at the displayed snapshot, or null when no data. */
  spot: number | null;
  /** Timestamp currently being displayed (latest if live, scrub ts if scrubbing). */
  timestamp: string | null;
  /** All snapshot timestamps for the active date, ascending. */
  timestamps: string[];
  /** Regular-session SPX 1-minute candles for the active date, ascending. */
  candles: SPXCandle[];
  /**
   * Candles visible at the current scrub position -- filtered to <= scrubTimestamp.
   * Equals `candles` when live (not scrubbed).
   */
  visibleCandles: SPXCandle[];
  /** Previous session close (SPX), or null if not available. */
  previousClose: number | null;
  /**
   * Strike with the highest call-volume dominance in the OI leaderboard of
   * the first (opening) snapshot for the active date. Derived from the strike
   * with the most positive `callRatio` = (callVol - putVol) / (callVol + putVol).
   * Null until the bulk load resolves.
   */
  openingCallStrike: number | null;
  /**
   * Strike with the highest put-volume dominance (most negative `callRatio`)
   * in the OI leaderboard of the first snapshot. Null until bulk load resolves.
   */
  openingPutStrike: number | null;

  // -- Date browsing (panel-local)
  /** The date currently being viewed (YYYY-MM-DD in ET), panel-local state. */
  selectedDate: string;
  /** Change the viewed date. Clears scrub state as a side effect. */
  setSelectedDate: (date: string) => void;
  /** Every distinct trading date present in `gex_target_features`, ascending. */
  availableDates: string[];

  // -- Live / scrubbed state
  /**
   * True when the displayed snapshot is genuinely live: not scrubbed, market
   * is open, we're viewing today's data, AND the snapshot is within the
   * freshness threshold. False during after-hours or when looking at a
   * historical date -- those are backtest views.
   */
  isLive: boolean;
  /** True when `selectedDate` equals today's ET date. */
  isToday: boolean;
  /** True when the user has explicitly stepped backwards from the latest snapshot. */
  isScrubbed: boolean;
  /** True when there is at least one earlier snapshot the user can scrub to. */
  canScrubPrev: boolean;
  /** True when the user is currently scrubbed and can step forward. */
  canScrubNext: boolean;
  /** Step one snapshot earlier. */
  scrubPrev: () => void;
  /** Step one snapshot later (clears scrub when at the latest). */
  scrubNext: () => void;
  /** Jump directly to a specific snapshot timestamp. */
  scrubTo: (ts: string) => void;
  /**
   * Resume live mode. Clears scrub state AND resets `selectedDate` to today
   * if viewing a past date -- the "Live" control is the single way back to
   * the present across both scrub and backtest dimensions.
   */
  scrubLive: () => void;

  // -- Status
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Single hoisted CT formatter, reused across every candle. Constructing a
 * fresh `Intl.DateTimeFormat` is comparatively expensive, and the bulk
 * response carries ~390 candles re-filtered on every 60s poll — building one
 * formatter per candle was needless per-poll churn (AUD-M22). The formatter
 * is stateless, so a single module-scope instance is safe to share. Template
 * mirrors `ctFormatter` in `src/utils/timezone.ts`.
 */
const SESSION_CT_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  hour: 'numeric',
  minute: 'numeric',
  hour12: false,
});

/**
 * Filter candles to the regular SPX session: 8:30 AM – 3:00 PM CT.
 *
 * The DB cron occasionally stores early bars (9:00 AM ET = 8:00 AM CT)
 * tagged as regular-session by the UW source. This client-side guard
 * ensures the price chart never shows pre-market or post-market bars,
 * consistent with the user's 8:30–15:00 CT requirement. DST is handled
 * automatically by the `America/Chicago` timezone identifier.
 */
function filterRegularSessionCT(candles: SPXCandle[]): SPXCandle[] {
  return candles.filter((c) => {
    const parts = SESSION_CT_FORMATTER.formatToParts(new Date(c.datetime));
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    const mins = hour * 60 + minute;
    // 8:30 AM CT = 510 min, 3:00 PM CT = 900 min (exclusive)
    return mins >= 510 && mins < 900;
  });
}

export function useGexTarget(
  marketOpen: boolean,
  initialDate?: string,
): UseGexTargetReturn {
  const isOwner = checkIsOwner();

  // -- Per-snapshot data
  const [oi, setOi] = useState<TargetScore | null>(null);
  const [vol, setVol] = useState<TargetScore | null>(null);
  const [dir, setDir] = useState<TargetScore | null>(null);
  const [spot, setSpot] = useState<number | null>(null);
  const [timestamp, setTimestamp] = useState<string | null>(null);
  const [timestamps, setTimestamps] = useState<string[]>([]);
  const [candles, setCandles] = useState<SPXCandle[]>([]);
  const [previousClose, setPreviousClose] = useState<number | null>(null);
  const [availableDates, setAvailableDates] = useState<string[]>([]);

  // -- Status
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // -- Date state
  // Panel-local date state. `initialDate` only seeds this once at mount;
  // after that, `setSelectedDate` (exposed in the return) is the only way
  // to change it. Production does not pass `initialDate` and lets the hook
  // default to today. Tests pass a fixed date to exercise the branches
  // deterministically.
  const [selectedDate, setSelectedDate] = useState<string>(
    () => initialDate ?? getETToday(),
  );

  const mountedRef = useRef(true);
  /**
   * Monotonic request-sequence counter (AUD-M15). Every fetch — bulk or
   * single — increments this and captures its own value. Before writing any
   * state, the fetch checks that its captured value still equals the latest;
   * a stale, superseded response (e.g. a slow today-request still in flight
   * for up to 30s on a Neon hang when the user has since scrubbed to a past
   * date) is dropped instead of clobbering the newer selection's data.
   * Mirrors the abort-on-supersede pattern in useFetchedData.ts.
   */
  const requestSeqRef = useRef(0);
  /**
   * AbortController for the most recent in-flight request. A new fetch aborts
   * the prior one so a superseded request stops consuming the network as soon
   * as it's been replaced, complementing the sequence guard above.
   */
  const abortRef = useRef<AbortController | null>(null);
  /** Cache of every snapshot loaded for the current date (keyed by timestamp). */
  const allSnapshotsRef = useRef<Map<string, BulkSnapshot>>(new Map());
  const [openingCallStrike, setOpeningCallStrike] = useState<number | null>(
    null,
  );
  const [openingPutStrike, setOpeningPutStrike] = useState<number | null>(null);

  // Scrub state machine -- extracted to `useScrubController`. Owns the
  // pinned `scrubTimestamp` plus prev/next/to/live transitions.
  const scrub = useScrubController(timestamps);
  const { scrubTimestamp, isScrubbed } = scrub;

  // `todayET` recomputes each render so the panel flips from LIVE -> BACKTEST
  // at the midnight-ET session boundary without needing an explicit state
  // update. The `isToday` comparison then drives the dispatch ladder.
  const todayET = getETToday();
  const isToday = selectedDate === todayET;

  // Consecutive failure counter. Single transient Neon hang shouldn't
  // flash "signal timed out" — only surface the error once polling has
  // missed FAIL_GRACE_COUNT in a row. Same pattern as useGexStrikeExpiry.
  const failCountRef = useRef(0);

  const fetchData = useCallback(
    async (tsOverride?: string | null) => {
      // AUD-M15: claim a sequence number and abort any prior in-flight
      // request before issuing this one. The captured `seq` lets us drop the
      // response if a newer fetch supersedes us while this one is awaiting.
      abortRef.current?.abort();
      const seq = ++requestSeqRef.current;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const qs = new URLSearchParams();
        // Always send the date so the server doesn't have to infer ET.
        // The hook always has a concrete date in state (never undefined).
        qs.set('date', selectedDate);
        if (tsOverride) qs.set('ts', tsOverride);
        const res = await fetch(`/api/gex-target-history?${qs}`, {
          credentials: 'same-origin',
          // 30s covers ~p95 of API latency. 5s was too tight given the
          // intermittent Neon serverless HTTP cold-connection hangs the
          // /api/gex-target-history path is subject to (same root cause
          // as gex-strike-expiry — see api/_lib/db.ts withDbRetry).
          signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(30_000)]),
        });

        // Drop superseded or unmounted responses before touching any state.
        if (!mountedRef.current || seq !== requestSeqRef.current) return;

        if (!res.ok) {
          // 401 is the owner check -- silently swallow so guest visitors
          // don't see a scary error. Everything else counts toward the
          // failure streak but only surfaces after FAIL_GRACE_COUNT.
          if (res.status === 401) {
            failCountRef.current = 0;
            return;
          }
          failCountRef.current += 1;
          if (failCountRef.current >= FAIL_GRACE_COUNT) {
            setError('Failed to load GexTarget data');
          }
          return;
        }

        const data = validateHistoryResponse(await res.json());

        if (!mountedRef.current || seq !== requestSeqRef.current) return;

        if (data == null) {
          // Shapeless body (5xx JSON blob, HTML error page). Routed through
          // the same grace-counted path as an HTTP error, and deliberately
          // writing NO state: one bad poll must not wipe a good display.
          failCountRef.current += 1;
          if (failCountRef.current >= FAIL_GRACE_COUNT) {
            setError('Unexpected response shape from GexTarget data');
          }
          return;
        }

        // Three parallel modes -- always written as a triple so a successful
        // fetch never leaves a stale mix of old/new across the three fields.
        setOi(data.oi);
        setVol(data.vol);
        setDir(data.dir);
        setSpot(data.spot);
        setTimestamp(data.timestamp);
        setTimestamps(data.timestamps);
        setCandles(filterRegularSessionCT(data.candles));
        setPreviousClose(data.previousClose);
        setAvailableDates(data.availableDates);
        failCountRef.current = 0;
        setError(null);
      } catch (err) {
        // A supersede-driven abort isn't a real failure — don't count it
        // toward the streak or surface an error for the newer selection.
        if (!mountedRef.current || seq !== requestSeqRef.current) return;
        failCountRef.current += 1;
        if (failCountRef.current >= FAIL_GRACE_COUNT) {
          setError(getErrorMessage(err));
        }
      } finally {
        if (mountedRef.current && seq === requestSeqRef.current) {
          setLoading(false);
        }
      }
    },
    [selectedDate],
  );

  /**
   * Bulk-loads every snapshot for `selectedDate` in a single request
   * (`?all=true`). Called once per date change. Populates `allSnapshotsRef`
   * so that scrubbing is served from the local cache without per-step fetches.
   */
  const fetchAllSnapshots = useCallback(async () => {
    // AUD-M15: same supersede guard as fetchData. A bulk load for a freshly
    // selected date claims the latest sequence number and aborts any prior
    // in-flight request, so a slow earlier response can't overwrite it.
    abortRef.current?.abort();
    const seq = ++requestSeqRef.current;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const qs = new URLSearchParams();
      qs.set('date', selectedDate);
      qs.set('all', 'true');
      const res = await fetch(`/api/gex-target-history?${qs}`, {
        credentials: 'same-origin',
        signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(10_000)]),
      });
      if (!mountedRef.current || seq !== requestSeqRef.current) return;
      if (!res.ok) {
        if (res.status !== 401) setError('Failed to load GexTarget data');
        return;
      }
      const data = validateBulkResponse(await res.json());
      if (!mountedRef.current || seq !== requestSeqRef.current) return;

      if (data == null) {
        // Shapeless envelope — surface the panel's existing error state
        // (with its Retry button) instead of half-writing state from it.
        setError('Unexpected response shape from GexTarget data');
        return;
      }

      // Populate snapshot cache
      const cache = new Map<string, BulkSnapshot>();
      for (const snap of data.snapshots) {
        cache.set(snap.timestamp, snap);
      }
      allSnapshotsRef.current = cache;

      // Per-day fields — filter candles to 8:30 AM–3:00 PM CT only
      setCandles(filterRegularSessionCT(data.candles));
      setPreviousClose(data.previousClose);
      setTimestamps(data.timestamps);
      setAvailableDates(data.availableDates);

      // Opening walls: from the first snapshot's OI leaderboard, find the
      // strike with the largest dealer call-gamma-OI exposure (Call Wall)
      // and the largest dealer put-gamma-OI exposure (Put Wall). In
      // OI mode, callGexDollars and putGexDollars are UW's gamma × OI
      // dollar-weighted exposures — exactly where dealer hedging pressure
      // concentrates, so price tends to gravitate toward or pin at these
      // strikes. `Math.abs` normalizes sign conventions across the two
      // fields. The walls stay fixed for the day so the price chart can
      // draw static reference lines.
      const firstSnap = data.snapshots[0] ?? null;
      if (firstSnap?.oi?.leaderboard && firstSnap.oi.leaderboard.length > 0) {
        const board = firstSnap.oi.leaderboard;
        let maxCallGex = -Infinity;
        let maxPutGex = -Infinity;
        let callStrike: number | null = null;
        let putStrike: number | null = null;
        for (const row of board) {
          const callMag = Math.abs(row.features.callGexDollars);
          const putMag = Math.abs(row.features.putGexDollars);
          if (callMag > maxCallGex) {
            maxCallGex = callMag;
            callStrike = row.strike;
          }
          if (putMag > maxPutGex) {
            maxPutGex = putMag;
            putStrike = row.strike;
          }
        }
        setOpeningCallStrike(callStrike);
        setOpeningPutStrike(putStrike);
      } else {
        setOpeningCallStrike(null);
        setOpeningPutStrike(null);
      }

      // Set state from latest snapshot
      const latest = data.snapshots.at(-1) ?? null;
      setOi(latest?.oi ?? null);
      setVol(latest?.vol ?? null);
      setDir(latest?.dir ?? null);
      setSpot(latest?.spot ?? null);
      setTimestamp(latest?.timestamp ?? null);
      setError(null);
    } catch (err) {
      // Drop supersede-driven aborts; only surface errors for the live request.
      if (!mountedRef.current || seq !== requestSeqRef.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (mountedRef.current && seq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [selectedDate]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Abort any in-flight request on unmount so a late response can't run
      // its post-await body (AUD-M15 companion to the supersede guard).
      abortRef.current?.abort();
    };
  }, []);

  // Reset scrub state whenever the active date changes -- the previous date's
  // scrub timestamp is meaningless against a different day's snapshot list.
  // (`useScrubController` also defensively clears the pin if it disappears
  // from the timestamps array, but we want the clear to fire eagerly on date
  // change even when fixtures or caches happen to share the same ts string.)
  const clearScrub = scrub.scrubLive;
  useEffect(() => {
    clearScrub();
  }, [selectedDate, clearScrub]);

  // Effect 1 -- Bulk load (fires on date change or market-open transition).
  // Clears the stale cache and fetches all snapshots for the current date in
  // one request, sets initial state from the latest snapshot, and pre-populates
  // the cache for instant scrubbing. Always loads when the user is the owner:
  // post-session today still has the day's snapshots to scrub through, and
  // pre-session / weekend dates degrade gracefully to an empty list. Live
  // polling stays gated on `marketOpen` in Effect 2 below; this effect just
  // ensures the static day-of data is available as soon as the panel mounts.
  // `marketOpen` stays in the dep array so the effect re-fires when the
  // session starts (e.g. page was open before 9:30 AM ET).
  useEffect(() => {
    if (!isOwner) {
      setLoading(false);
      return;
    }
    allSnapshotsRef.current = new Map(); // clear stale cache
    setLoading(true);
    void fetchAllSnapshots();
  }, [isOwner, isToday, marketOpen, selectedDate, fetchAllSnapshots]);

  // Effect 2 -- Live polling (fires when live conditions change).
  // No immediate fetchData() call here -- the bulk load already set state
  // from the latest snapshot. The interval refreshes state after one poll
  // interval elapses. Extracted to `usePolling`; gates collapse the prior
  // four-condition guard `if (!isOwner || !isToday || !marketOpen || isScrubbed) return;`
  // into the conjunction `[isOwner, isToday, marketOpen, !isScrubbed]`.
  usePolling(() => void fetchData(), POLL_INTERVALS.GEX_TARGET, [
    isOwner,
    isToday,
    marketOpen,
    !isScrubbed,
  ]);

  // Effect 3 -- Scrub (instant from cache, fallback to fetch on cache miss).
  // Also handles exiting scrub mode: restores the latest cached snapshot so
  // `timestamp` is current and `isLive` evaluates correctly without an extra
  // network round-trip.
  useEffect(() => {
    if (!isScrubbed) {
      // Exiting scrub: restore the latest cached snapshot. Without this,
      // `timestamp` would still hold the scrubbed value (or undefined from a
      // cache-miss fallback fetch), making `isFresh` evaluate false and
      // leaving `isLive` stuck at false even after scrubLive / scrubNext.
      const latestTs = timestamps.at(-1);
      if (latestTs) {
        const latest = allSnapshotsRef.current.get(latestTs);
        if (latest) {
          setOi(latest.oi);
          setVol(latest.vol);
          setDir(latest.dir);
          setSpot(latest.spot);
          setTimestamp(latest.timestamp);
        }
      }
      return;
    }
    if (scrubTimestamp == null) return;
    const cached = allSnapshotsRef.current.get(scrubTimestamp);
    if (cached) {
      setOi(cached.oi);
      setVol(cached.vol);
      setDir(cached.dir);
      setSpot(cached.spot);
      setTimestamp(scrubTimestamp);
      setLoading(false);
    } else {
      void fetchData(scrubTimestamp);
    }
  }, [isScrubbed, scrubTimestamp, fetchData, timestamps]);

  // Wall-clock freshness -- extracted to `useWallClockFreshness`. The ticker
  // only runs while every gate is truthy: BACKTEST or scrubbed states have a
  // permanently-labeled badge, so re-rendering would be wasted work.
  //
  // Timing caveat (preserved from the original): between mount and the first
  // tick, `nowMs` is whatever `Date.now()` returned at mount. So a snapshot
  // exactly at the freshness boundary at mount can briefly read as fresh for
  // up to WALL_CLOCK_TICK_MS past its actual staleness -- total worst-case
  // "fresh badge on stale data" is STALE_THRESHOLD_MS + WALL_CLOCK_TICK_MS
  // (currently 2m30s). Acceptable because the threshold is already 2x the
  // poll interval.
  const { isFresh } = useWallClockFreshness(
    timestamp != null ? new Date(timestamp).getTime() : null,
    STALE_THRESHOLD_MS,
    { gates: [isToday, marketOpen, !isScrubbed], tickMs: WALL_CLOCK_TICK_MS },
  );

  // The displayed snapshot is "live" only when (1) we're in a state where
  // polling is active AND (2) the snapshot itself is recent. The second
  // clause catches the dial-back case: polling keeps firing, but each poll
  // returns the same stale snapshot, so the wall-clock comparison flips the
  // badge to BACKTEST while leaving the polling machinery alone.
  const isLive = !isScrubbed && marketOpen && isToday && isFresh;

  const { canScrubPrev, canScrubNext, scrubPrev, scrubNext, scrubTo } = scrub;

  const scrubLive = useCallback(() => {
    // Reset to live mode on both axes: clear scrub AND snap date back to
    // today. If the user was on a past date, this also kicks the dispatch
    // ladder into live polling via the `isToday` check. If they were
    // already on today with just scrub active, the date setter is a no-op
    // (state equality).
    scrub.scrubLive();
    setSelectedDate((cur) => {
      const today = getETToday();
      return cur === today ? cur : today;
    });
  }, [scrub]);

  const refresh = useCallback(() => {
    allSnapshotsRef.current = new Map();
    setLoading(true);
    void fetchAllSnapshots();
  }, [fetchAllSnapshots]);

  // Candles filtered to the scrub position for the price chart. When live
  // (not scrubbed) the full session candles are returned unchanged.
  const visibleCandles = useMemo(() => {
    if (scrubTimestamp == null) return candles;
    const limit = new Date(scrubTimestamp).getTime();
    return candles.filter((c) => c.datetime <= limit);
  }, [candles, scrubTimestamp]);

  // Stabilize the returned object's identity so a parent `useMemo` keyed on it
  // (App.tsx's panelMap barrier) holds when no underlying data changed. Every
  // field below is already render-stable on its own (useState values/setters,
  // useCallback fns, derived primitives, and the `visibleCandles` useMemo), so
  // the only churn was this object literal being freshly allocated each render.
  return useMemo(
    () => ({
      oi,
      vol,
      dir,
      spot,
      timestamp,
      timestamps,
      candles,
      visibleCandles,
      previousClose,
      openingCallStrike,
      openingPutStrike,
      selectedDate,
      setSelectedDate,
      availableDates,
      isLive,
      isToday,
      isScrubbed,
      canScrubPrev,
      canScrubNext,
      scrubPrev,
      scrubNext,
      scrubTo,
      scrubLive,
      loading,
      error,
      refresh,
    }),
    [
      oi,
      vol,
      dir,
      spot,
      timestamp,
      timestamps,
      candles,
      visibleCandles,
      previousClose,
      openingCallStrike,
      openingPutStrike,
      selectedDate,
      setSelectedDate,
      availableDates,
      isLive,
      isToday,
      isScrubbed,
      canScrubPrev,
      canScrubNext,
      scrubPrev,
      scrubNext,
      scrubTo,
      scrubLive,
      loading,
      error,
      refresh,
    ],
  );
}
