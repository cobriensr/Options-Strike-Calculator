/**
 * Read helpers for the GEXBot capture tables (`gexbot_snapshots`,
 * `gexbot_api_capture`). Each helper returns a typed view shape
 * consumed by `api/gexbot.ts`.
 *
 * Spec: docs/superpowers/specs/gexbot-frontend-2026-05-16.md
 *
 * The list readers (`getLatestSnapshots`, `getVelocityTape`,
 * `getConvexityTrend`, `getMaxchangeWinners`) return `[]` when the source
 * tables are empty — the frontend renders empty-state for that case.
 * `getSiblingConfirmation` returns one no-data row per sibling instead (and
 * `[]` only for a ticker with no siblings). `getLatestGexbotSnapshotAt`
 * returns `null` when no row is in its window. A DB failure propagates from
 * every helper (after `withDbRetry`); `api/gexbot.ts` turns it into a 500
 * plus a Sentry capture.
 */

import { getDb, withDbRetry } from './db.js';
import { GEXBOT_TICKERS } from './gexbot-client.js';

// Per-attempt timeout for read queries — same budget the rest of the
// codebase uses. 3 attempts × 10s = 30s fail-fast, before Vercel's
// 300s gateway timeout surfaces as HTTP 504 in the browser.
const READ_RETRIES = 2;
const READ_TIMEOUT_MS = 10_000;

// ────────────────────────────────────────────────────────────
// Types — shared with src/components/Gexbot/types.ts via JSON
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

/**
 * One ticker's minute-over-minute change, for the velocity tape. Every delta
 * is `null` when it cannot be trusted: no prior snapshot in the ET session,
 * the prior is more than 3 minutes older, or the vendor repeated the prior
 * `source_timestamp` (the 09:30 VIX repeat of the prior close).
 */
export interface VelocityRow {
  ticker: string;
  capturedAt: string;
  /** Nearest listed expiry in days (0 = same-day). Differs per ticker. */
  minDte: number | null;
  /** Change in `agg_dex` (session-cumulative taker delta) over the minute. */
  dAggDex: number | null;
  /** Change in `zgr` (call minus put GEX imbalance) over the minute. */
  dZgr: number | null;
  /** Change in `zcvr` (net convexity) over the minute. */
  dZcvr: number | null;
  /**
   * Median |dAggDex| over the ticker's valid minutes this ET session, so the
   * client can rank a move against that ticker's own norm. Null until the
   * session has one valid change.
   */
  typicalAbsDAggDex: number | null;
}

export interface MaxchangeWinnerRow {
  ticker: string;
  endpoint: string;
  category: string;
  capturedAt: string;
  /** `[strike, change]` tuples per lookback window. */
  windows: {
    current: [number, number] | null;
    one: [number, number] | null;
    five: [number, number] | null;
    ten: [number, number] | null;
    fifteen: [number, number] | null;
    thirty: [number, number] | null;
  };
}

export interface ConvexityTrendRow {
  ticker: string;
  /** Latest nearest-expiry DTE for the ticker, or null if unreported. */
  minDte: number | null;
  /** Time-ordered `[isoTimestamp, zcvr]` points, oldest first. */
  series: Array<[string, number]>;
}

export type SiblingVerdict = 'agree' | 'disagree' | 'none';

export interface SiblingConfirmRow {
  ticker: string;
  /**
   * Net taker delta across the nearest-expiry chain (`min_dte`; not always
   * 0DTE) at the fire time. + = net long delta.
   */
  netDex: number | null;
  /** Call minus put GEX imbalance. Context only; not in the verdict. */
  zgr: number | null;
  /** When the snapshot behind this row was captured; null when none. */
  capturedAt: string | null;
  verdict: SiblingVerdict;
}

// ────────────────────────────────────────────────────────────
// Sibling-asset grouping — see spec for rationale
// ────────────────────────────────────────────────────────────

/**
 * Const-typed grouping so `SIBLING_GROUPS.broad` is a readonly tuple
 * (not `T | undefined` under noUncheckedIndexedAccess). Single-stock
 * alerts default to `broad` siblings since most large-caps move with
 * SPY/QQQ.
 */
export const SIBLING_GROUPS = {
  broad: ['SPX', 'SPY', 'QQQ', 'IWM', 'NDX'] as const,
  vol: ['VIX', 'UVXY'] as const,
  bonds: ['TLT', 'HYG'] as const,
  metals: ['GLD', 'SLV'] as const,
  energy: ['USO'] as const,
} as const;

function siblingsFor(ticker: string): readonly string[] {
  for (const group of Object.values(SIBLING_GROUPS)) {
    if ((group as readonly string[]).includes(ticker)) {
      return group.filter((t) => t !== ticker);
    }
  }
  return SIBLING_GROUPS.broad.filter((t) => t !== ticker);
}

// ────────────────────────────────────────────────────────────
// Numeric coercion (Neon serverless driver returns NUMERIC as string)
// ────────────────────────────────────────────────────────────

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

// ────────────────────────────────────────────────────────────
// Query: latest snapshots (one row per ticker)
// ────────────────────────────────────────────────────────────

interface RawSnapshotsRow {
  ticker: string;
  captured_at: string | Date;
  spot: unknown;
  zero_gamma: unknown;
  z_mlgamma: unknown;
  z_msgamma: unknown;
  zcvr: unknown;
  zgr: unknown;
  zvanna: unknown;
  zcharm: unknown;
  o_mlgamma: unknown;
  o_msgamma: unknown;
  ocvr: unknown;
  ogr: unknown;
  ovanna: unknown;
  ocharm: unknown;
  one_dexoflow: unknown;
  one_gexoflow: unknown;
  one_cvroflow: unknown;
  min_dte: unknown;
}

export async function getLatestSnapshots(): Promise<SnapshotsLatestRow[]> {
  const sql = getDb();
  // 15-min freshness window: fetch crons run 1/min, so anything older
  // is stale (cron-down, ticker decommissioned, weekend) and shouldn't
  // appear in "latest" results. Also bounds the DISTINCT ON scan to
  // recent rows in the (ticker, captured_at DESC) index.
  const rows = (await withDbRetry(
    () => sql`
      SELECT DISTINCT ON (ticker)
        ticker, captured_at,
        spot, zero_gamma,
        z_mlgamma, z_msgamma, zcvr, zgr, zvanna, zcharm,
        o_mlgamma, o_msgamma, ocvr, ogr, ovanna, ocharm,
        one_dexoflow, one_gexoflow, one_cvroflow,
        min_dte
      FROM gexbot_snapshots
      WHERE captured_at >= now() - INTERVAL '15 minutes'
      ORDER BY ticker, captured_at DESC
    `,
    READ_RETRIES,
    READ_TIMEOUT_MS,
  )) as RawSnapshotsRow[];

  return rows.map((r) => ({
    ticker: r.ticker,
    capturedAt: toIso(r.captured_at),
    spot: toNum(r.spot),
    zeroGamma: toNum(r.zero_gamma),
    zMlgamma: toNum(r.z_mlgamma),
    zMsgamma: toNum(r.z_msgamma),
    zcvr: toNum(r.zcvr),
    zgr: toNum(r.zgr),
    zvanna: toNum(r.zvanna),
    zcharm: toNum(r.zcharm),
    oMlgamma: toNum(r.o_mlgamma),
    oMsgamma: toNum(r.o_msgamma),
    ocvr: toNum(r.ocvr),
    ogr: toNum(r.ogr),
    ovanna: toNum(r.ovanna),
    ocharm: toNum(r.ocharm),
    oneDexoflow: toNum(r.one_dexoflow),
    oneGexoflow: toNum(r.one_gexoflow),
    oneCvroflow: toNum(r.one_cvroflow),
    minDte: toNum(r.min_dte),
  }));
}

// ────────────────────────────────────────────────────────────
// Query: velocity tape (minute-over-minute change per ticker)
// ────────────────────────────────────────────────────────────

interface RawVelocityRow {
  ticker: string;
  captured_at: string | Date;
  min_dte: unknown;
  d_agg_dex: unknown;
  d_zgr: unknown;
  d_zcvr: unknown;
  typical_abs_d_agg_dex: unknown;
}

/**
 * Latest snapshot per ticker, differenced against the snapshot before it
 * with `LAG` over `captured_at`.
 *
 * - Scope: the current ET session only (`agg_dex` is session-cumulative, so
 *   a difference across the overnight reset is meaningless). The ET-midnight
 *   bound truncates the ET wall-clock timestamp, then converts it back to
 *   timestamptz, so it is right on both sides of a DST change.
 * - Gap rule: a prior snapshot more than 3 minutes older (about two missed
 *   1-min cron runs) yields null deltas, never a multi-minute change dressed
 *   up as one minute.
 * - Stale rule: a prior with the same `source_timestamp` is the vendor
 *   replaying its last value, so the "change" is an artifact; null deltas.
 *   A prior whose `source_timestamp` predates the ET session is the same
 *   artifact: VIX's 09:30 row carries the prior close's timestamp, so the
 *   09:31 "change" would be a jump from yesterday's close.
 * - Freshness: tickers whose newest snapshot is over 15 minutes old are
 *   dropped, matching `getLatestSnapshots`.
 * - `typical_abs_d_agg_dex` is the per-ticker median |Δagg_dex| over the
 *   session's valid minutes (at most ~390 rows per ticker, so a cheap
 *   ordered-set aggregate).
 *
 * "Now" is a bound JS clock reading rather than SQL `now()`, so the whole
 * statement is evaluated against one instant.
 */
export async function getVelocityTape(): Promise<VelocityRow[]> {
  const sql = getDb();
  const nowIso = new Date().toISOString();
  const rows = (await withDbRetry(
    () => sql`
      WITH bounds AS (
        SELECT
          ${nowIso}::timestamptz AS now_ts,
          date_trunc('day', ${nowIso}::timestamptz AT TIME ZONE 'America/New_York')
            AT TIME ZONE 'America/New_York' AS day_start
      ),
      lagged AS (
        SELECT
          s.ticker, s.captured_at, s.min_dte, s.source_timestamp,
          s.agg_dex, s.zgr, s.zcvr,
          LAG(s.captured_at)       OVER w AS prev_at,
          LAG(s.source_timestamp)  OVER w AS prev_src,
          LAG(s.agg_dex)           OVER w AS prev_agg_dex,
          LAG(s.zgr)               OVER w AS prev_zgr,
          LAG(s.zcvr)              OVER w AS prev_zcvr
        FROM gexbot_snapshots s, bounds b
        WHERE s.captured_at >= b.day_start
          AND s.captured_at <= b.now_ts
        WINDOW w AS (PARTITION BY s.ticker ORDER BY s.captured_at)
      ),
      paired AS (
        SELECT
          l.*,
          (
            l.prev_at IS NOT NULL
            AND l.captured_at - l.prev_at <= INTERVAL '3 minutes'
            AND (l.prev_src IS NULL
                 OR l.prev_src >= extract(epoch FROM b.day_start))
            AND (l.source_timestamp IS NULL
                 OR l.source_timestamp IS DISTINCT FROM l.prev_src)
          ) AS ok
        FROM lagged l, bounds b
      ),
      diffs AS (
        SELECT
          p.ticker, p.captured_at, p.min_dte,
          CASE WHEN p.ok THEN (p.agg_dex - p.prev_agg_dex)::float8 END AS d_agg_dex,
          CASE WHEN p.ok THEN (p.zgr - p.prev_zgr)::float8 END AS d_zgr,
          CASE WHEN p.ok THEN (p.zcvr - p.prev_zcvr)::float8 END AS d_zcvr
        FROM paired p
      ),
      typical AS (
        SELECT
          ticker,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(d_agg_dex)) AS median_abs
        FROM diffs
        WHERE d_agg_dex IS NOT NULL
        GROUP BY ticker
      ),
      latest AS (
        SELECT DISTINCT ON (d.ticker) d.*
        FROM diffs d, bounds b
        WHERE d.captured_at >= b.now_ts - INTERVAL '15 minutes'
        ORDER BY d.ticker, d.captured_at DESC
      )
      SELECT
        l.ticker, l.captured_at, l.min_dte,
        l.d_agg_dex, l.d_zgr, l.d_zcvr,
        t.median_abs::float8 AS typical_abs_d_agg_dex
      FROM latest l
      LEFT JOIN typical t USING (ticker)
      ORDER BY l.ticker
    `,
    READ_RETRIES,
    READ_TIMEOUT_MS,
  )) as RawVelocityRow[];

  return rows.map((r) => ({
    ticker: r.ticker,
    capturedAt: toIso(r.captured_at),
    minDte: toNum(r.min_dte),
    dAggDex: toNum(r.d_agg_dex),
    dZgr: toNum(r.d_zgr),
    dZcvr: toNum(r.d_zcvr),
    typicalAbsDAggDex: toNum(r.typical_abs_d_agg_dex),
  }));
}

// ────────────────────────────────────────────────────────────
// Query: convexity trend (last 60 min per ticker)
// ────────────────────────────────────────────────────────────

interface RawConvexityPoint {
  ticker: string;
  captured_at: string | Date;
  zcvr: unknown;
  min_dte?: unknown;
}

export async function getConvexityTrend(
  windowMinutes = 60,
): Promise<ConvexityTrendRow[]> {
  const sql = getDb();
  const rows = (await withDbRetry(
    () => sql`
      SELECT ticker, captured_at, zcvr, min_dte
      FROM gexbot_snapshots
      WHERE captured_at >= now() - (${windowMinutes}::int * INTERVAL '1 minute')
        AND zcvr IS NOT NULL
      ORDER BY ticker, captured_at ASC
    `,
    READ_RETRIES,
    READ_TIMEOUT_MS,
  )) as RawConvexityPoint[];

  const byTicker = new Map<
    string,
    { series: Array<[string, number]>; minDte: number | null }
  >();
  for (const r of rows) {
    const value = toNum(r.zcvr);
    if (value === null) continue;
    const entry = byTicker.get(r.ticker) ?? { series: [], minDte: null };
    entry.series.push([toIso(r.captured_at), value]);
    // Rows are oldest-first: keep the last non-null DTE in the window.
    entry.minDte = toNum(r.min_dte) ?? entry.minDte;
    byTicker.set(r.ticker, entry);
  }
  return Array.from(byTicker, ([ticker, { series, minDte }]) => ({
    ticker,
    minDte,
    series,
  }));
}

// ────────────────────────────────────────────────────────────
// Query: latest maxchange winners
// ────────────────────────────────────────────────────────────

interface RawCaptureRow {
  ticker: string;
  endpoint: string;
  category: string;
  captured_at: string | Date;
  raw_response: unknown;
}

/**
 * GEXBot's INT32 "no value" sentinel (-2147483.648) shows up in maxchange
 * windows around the close (seen 15:59:46-16:00:00 ET). Anything at or below
 * this floor is the sentinel, never a real strike or change, so the whole
 * tuple is dropped.
 */
const MAXCHANGE_SENTINEL_FLOOR = -2_147_483;

function pickWindowTuple(raw: unknown, key: string): [number, number] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = (raw as Record<string, unknown>)[key];
  if (!Array.isArray(value) || value.length < 2) return null;
  const strike = toNum(value[0]);
  const change = toNum(value[1]);
  if (strike === null || change === null) return null;
  if (strike <= MAXCHANGE_SENTINEL_FLOOR || change <= MAXCHANGE_SENTINEL_FLOOR)
    return null;
  return [strike, change];
}

export async function getMaxchangeWinners(): Promise<MaxchangeWinnerRow[]> {
  const sql = getDb();
  // 5-min freshness window: fetch-gexbot-fast writes 1/min for every
  // (ticker, endpoint, category) tuple, so anything older than 5 min
  // is stale. Without this bound the DISTINCT ON has to walk through
  // a full day's worth of captures (16 tickers × ~11 categories × 60
  // min × ~6 hours ≈ 60k+ rows) to find the latest per tuple — slow
  // enough under Neon load to blow past the client's 10s fetch
  // timeout and surface as "Request timed out (HTTP 0)". With the
  // bound the scan is ~16 × 11 ≈ 175 rows.
  const rows = (await withDbRetry(
    () => sql`
      SELECT DISTINCT ON (ticker, endpoint, category)
        ticker, endpoint, category, captured_at, raw_response
      FROM gexbot_api_capture
      WHERE category LIKE '%/maxchange'
        AND captured_at >= now() - INTERVAL '5 minutes'
      ORDER BY ticker, endpoint, category, captured_at DESC
    `,
    READ_RETRIES,
    READ_TIMEOUT_MS,
  )) as RawCaptureRow[];

  return rows.map((r) => ({
    ticker: r.ticker,
    endpoint: r.endpoint,
    category: r.category,
    capturedAt: toIso(r.captured_at),
    windows: {
      current: pickWindowTuple(r.raw_response, 'current'),
      one: pickWindowTuple(r.raw_response, 'one'),
      five: pickWindowTuple(r.raw_response, 'five'),
      ten: pickWindowTuple(r.raw_response, 'ten'),
      fifteen: pickWindowTuple(r.raw_response, 'fifteen'),
      thirty: pickWindowTuple(r.raw_response, 'thirty'),
    },
  }));
}

// ────────────────────────────────────────────────────────────
// Query: sibling taker-flow direction at an alert's fire time
// ────────────────────────────────────────────────────────────

/**
 * How far before a fire time a snapshot may sit and still count, for every
 * fire-time lookup (`getLatestGexbotSnapshotAt` and the sibling read).
 * fetch-gexbot-fast runs once a minute, so 180 s tolerates two consecutive
 * missed runs; the older 120 s budget survived only one.
 */
export const FIRE_TIME_MAX_AGE_SECONDS = 180;

/**
 * Direction read of one sibling against the alert's side.
 * `net_dex` is the net taker delta across the nearest-expiry chain
 * (`min_dte`; 0DTE only on a ticker with a same-day expiry): positive means
 * takers are net long delta (call-side flow), negative the opposite.
 *   - call alert: net_dex > 0 → agree, net_dex < 0 → disagree
 *   - put alert:  net_dex < 0 → agree, net_dex > 0 → disagree
 *   - zero or missing → none (never agree on both sides)
 */
export function siblingVerdict(
  side: 'call' | 'put',
  netDex: number | null,
): SiblingVerdict {
  if (netDex === null || netDex === 0) return 'none';
  const callSide = netDex > 0;
  return callSide === (side === 'call') ? 'agree' : 'disagree';
}

interface RawSiblingRow {
  ticker: string;
  captured_at: string | Date;
  net_dex: unknown;
  zgr: unknown;
}

/**
 * For an alert on `ticker` going `side`, read each sibling's taker-flow
 * direction (the sign of `net_dex`) from the snapshot at or before `asOf`
 * (the alert's fire time) and no more than 180 s older. `zgr` rides along
 * as context only; it does not enter the verdict.
 *
 * A row also needs a vendor `source_timestamp` (Unix seconds) inside the
 * same window. At the 09:30-09:31 ET open the vendor repeats VIX's prior
 * close, so a fresh `captured_at` can carry the previous session's reading.
 * A NULL `source_timestamp` carries no evidence either way and is kept.
 *
 * Returns one row per sibling. A sibling with no snapshot in the window
 * (fire older than the live table's ~2 sessions, cron miss) gets a
 * `none` row with null readings. The Parquet archive is not read.
 */
export async function getSiblingConfirmation(
  ticker: string,
  side: 'call' | 'put',
  asOf: Date,
): Promise<SiblingConfirmRow[]> {
  const siblings = siblingsFor(mapToGexbotTicker(ticker) ?? ticker);
  if (siblings.length === 0) return [];

  const sql = getDb();
  const upperBound = asOf.toISOString();
  const lowerBound = new Date(
    asOf.getTime() - FIRE_TIME_MAX_AGE_SECONDS * 1000,
  ).toISOString();
  const rows = (await withDbRetry(
    () => sql`
      SELECT DISTINCT ON (ticker)
        ticker, captured_at, net_dex, zgr
      FROM gexbot_snapshots
      WHERE ticker = ANY(${siblings as readonly string[]}::text[])
        AND captured_at >= ${lowerBound}::timestamptz
        AND captured_at <= ${upperBound}::timestamptz
        AND (source_timestamp IS NULL
             OR source_timestamp >= extract(epoch FROM ${lowerBound}::timestamptz))
      ORDER BY ticker, captured_at DESC
    `,
    READ_RETRIES,
    READ_TIMEOUT_MS,
  )) as RawSiblingRow[];

  const byTicker = new Map(rows.map((r) => [r.ticker, r]));
  return siblings.map((sibling) => {
    const r = byTicker.get(sibling);
    const netDex = r ? toNum(r.net_dex) : null;
    return {
      ticker: sibling,
      netDex,
      zgr: r ? toNum(r.zgr) : null,
      capturedAt: r ? toIso(r.captured_at) : null,
      verdict: siblingVerdict(side, netDex),
    };
  });
}

// ────────────────────────────────────────────────────────────
// Live lookup: most recent gexbot_snapshots row for a ticker at fire time
// ────────────────────────────────────────────────────────────

/**
 * The 16-ticker GexBot enum, derived from the canonical list in
 * `gexbot-client.ts` (`GEXBOT_TICKERS`) so adding a 17th ticker only
 * requires updating one source. detect crons should pass
 * `underlying_symbol` through `mapToGexbotTicker` before calling
 * `getLatestGexbotSnapshotAt` — the alert universe (UW Full Tape) is
 * wider than GexBot's coverage.
 */
export const GEXBOT_TICKER_SET: ReadonlySet<string> = new Set<string>(
  GEXBOT_TICKERS,
);

/**
 * Alert-table → GexBot ticker normalization. The Silent Boom / Lottery
 * feeds use OPRA weekly-cash root symbols (SPXW / NDXP / RUTW); GexBot
 * publishes per their cash-index root (SPX / NDX / RUT). The mapping
 * ensures fires on those roots pick up the same dealer-state snapshot
 * GexBot reports for the underlying cash index.
 *
 * Returns null when the input is outside the GexBot universe — callers
 * should skip the snapshot lookup and leave the gex_ columns NULL.
 */
export function mapToGexbotTicker(underlying: string): string | null {
  if (underlying === 'SPXW') return 'SPX';
  if (underlying === 'NDXP') return 'NDX';
  if (underlying === 'RUTW') return 'RUT';
  return GEXBOT_TICKER_SET.has(underlying) ? underlying : null;
}

/**
 * Top GexBot scalars stashed at fire time on alert tables. The set of
 * eight matches the 2026-05-26 univariate probe's strongest predictors
 * plus a freshness timestamp. See migration #180.
 */
export interface FireTimeGexbotSnapshot {
  oneCvroflow: number | null;
  netPutDex: number | null;
  oneDexoflow: number | null;
  oneGexoflow: number | null;
  zcvr: number | null;
  zeroGamma: number | null;
  spot: number | null;
  capturedAt: Date;
}

interface RawFireTimeRow {
  captured_at: Date | string;
  one_cvroflow: unknown;
  net_put_dex: unknown;
  one_dexoflow: unknown;
  one_gexoflow: unknown;
  zcvr: unknown;
  zero_gamma: unknown;
  spot: unknown;
}

/**
 * Fetch the most recent `gexbot_snapshots` row for `gexbotTicker` whose
 * `captured_at` is at-or-before `asOf` but no older than `maxAgeSeconds`.
 *
 * Same stale-vendor-timestamp rule as the sibling read: a row whose
 * `source_timestamp` (Unix seconds) predates the window is the vendor
 * replaying an older reading (VIX's prior close at the 09:30 open), so it
 * is not "at fire time" even though its `captured_at` is fresh. A NULL
 * `source_timestamp` carries no evidence either way and is kept.
 *
 * Returns `null` when no row matches the freshness window — callers MUST
 * be prepared for that case (ticker outside cron coverage, cron miss,
 * weekend hour, etc.) and write NULL into the gex_ columns.
 *
 * Defaults: 180-second max age (tolerates 2 consecutive missed
 * fetch-gexbot-fast runs at 1-min cadence — the prior 120s budget only
 * survived a single cron miss, which is real in practice).
 */
export async function getLatestGexbotSnapshotAt(
  gexbotTicker: string,
  asOf: Date,
  maxAgeSeconds = FIRE_TIME_MAX_AGE_SECONDS,
): Promise<FireTimeGexbotSnapshot | null> {
  const sql = getDb();
  const lowerBoundMs = asOf.getTime() - maxAgeSeconds * 1000;
  const lowerBound = new Date(lowerBoundMs).toISOString();
  const upperBound = asOf.toISOString();

  const rows = (await withDbRetry(
    () => sql`
      SELECT
        captured_at,
        one_cvroflow, net_put_dex, one_dexoflow, one_gexoflow,
        zcvr, zero_gamma, spot
      FROM gexbot_snapshots
      WHERE ticker = ${gexbotTicker}
        AND captured_at >= ${lowerBound}::timestamptz
        AND captured_at <= ${upperBound}::timestamptz
        AND (source_timestamp IS NULL
             OR source_timestamp >= extract(epoch FROM ${lowerBound}::timestamptz))
      ORDER BY captured_at DESC
      LIMIT 1
    `,
    READ_RETRIES,
    READ_TIMEOUT_MS,
  )) as RawFireTimeRow[];

  const row = rows[0];
  if (!row) return null;
  return {
    oneCvroflow: toNum(row.one_cvroflow),
    netPutDex: toNum(row.net_put_dex),
    oneDexoflow: toNum(row.one_dexoflow),
    oneGexoflow: toNum(row.one_gexoflow),
    zcvr: toNum(row.zcvr),
    zeroGamma: toNum(row.zero_gamma),
    spot: toNum(row.spot),
    capturedAt:
      row.captured_at instanceof Date
        ? row.captured_at
        : new Date(row.captured_at),
  };
}
