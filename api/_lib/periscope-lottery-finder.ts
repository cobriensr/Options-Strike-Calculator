/**
 * Detection logic for the Periscope-event-driven lottery alerts.
 *
 * Two entry points:
 *   - detectCallLottery(): runs Filter I (gamma panel, above-spot, deep_neg)
 *   - detectPutLottery():  runs Filter L (charm panel, below-spot)
 *
 * Both follow the same shape:
 *   1. Fetch the latest two Periscope slices for today's 0DTE expiry.
 *   2. Compute per-strike slice-over-slice deltas.
 *   3. Apply the v3 strict filter (see PERISCOPE_LOTTERY_THRESHOLDS).
 *   4. Augment each candidate with gex_target_features, market_snapshots,
 *      net_flow_per_ticker_history (QQQ for call lottery only) values.
 *   5. Return PeriscopeLotteryFire records ready for upsert.
 *
 * The cron handlers (detect-periscope-call-lottery, detect-periscope-put-lottery)
 * wrap these with withCronInstrumentation, Sentry, and the upsert call.
 */

import { getDb } from './db.js';
import {
  PERISCOPE_LOTTERY_THRESHOLDS,
  type PeriscopeLotteryFire,
} from './periscope-lottery-types.js';

type DbNumeric = string | number;
type DbTimestamp = string | Date;

interface SliceRow {
  captured_at: DbTimestamp;
  strike: DbNumeric;
  greek_post: DbNumeric;
  greek_prior: DbNumeric;
  greek_delta: DbNumeric;
  spot_at_event: DbNumeric;
  lvl_rank: DbNumeric;
  chg_rank: DbNumeric;
}

interface GexTargetRow {
  gex_dollars: DbNumeric;
  call_ratio: DbNumeric;
}

interface FlowRow {
  sum_call: DbNumeric | null;
  sum_put: DbNumeric | null;
}

const toNum = (v: DbNumeric | null | undefined): number =>
  v == null ? Number.NaN : typeof v === 'number' ? v : Number(v);

const toDate = (v: DbTimestamp): Date => (v instanceof Date ? v : new Date(v));

/** YYYY-MM-DD in America/Chicago (matches the trading-day boundary the
 * cron observes — 0DTE expiry rolls at 15:00 CT, not UTC midnight). */
const isoDate = (d: Date): string =>
  d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

/**
 * Pull the two most-recent Periscope slices for the given panel and expiry,
 * compute per-strike deltas, and rank within the top-1% per-day subset.
 *
 * Returns rows ready for filter application. The ranking happens server-side
 * inside the CTE so the result is small (only top-1% candidates).
 */
async function fetchCandidates(
  panel: 'gamma' | 'charm',
  expiry: string,
): Promise<SliceRow[]> {
  const sql = getDb();
  const dayTopPct =
    panel === 'gamma'
      ? PERISCOPE_LOTTERY_THRESHOLDS.CALL.DAY_TOP_PCT
      : PERISCOPE_LOTTERY_THRESHOLDS.PUT.DAY_TOP_PCT;
  // Stage-1 day-threshold quantile: 1 - dayTopPct (e.g. 0.99 for top-1%)
  const quantile = 1 - dayTopPct;

  const rows = (await sql`
    WITH latest_slot AS (
      SELECT MAX(captured_at) AS captured_at
      FROM periscope_snapshots
      WHERE panel = ${panel} AND expiry = ${expiry}
    ),
    prior_slot AS (
      SELECT MAX(captured_at) AS captured_at
      FROM periscope_snapshots
      WHERE panel = ${panel} AND expiry = ${expiry}
        AND captured_at < (SELECT captured_at FROM latest_slot)
    ),
    pairs AS (
      SELECT s.captured_at, s.strike,
             s.value AS greek_post,
             p.value AS greek_prior,
             (s.value - p.value) AS greek_delta
      FROM periscope_snapshots s
      JOIN periscope_snapshots p
        ON p.strike = s.strike
       AND p.expiry = s.expiry
       AND p.panel  = s.panel
       AND p.captured_at = (SELECT captured_at FROM prior_slot)
      WHERE s.panel = ${panel}
        AND s.expiry = ${expiry}
        AND s.captured_at = (SELECT captured_at FROM latest_slot)
    ),
    day_delta_pool AS (
      -- Per-day population of |delta| for the top-N% threshold
      SELECT (ABS(value - LAG(value) OVER (PARTITION BY strike ORDER BY captured_at))) AS abs_delta
      FROM periscope_snapshots
      WHERE panel = ${panel} AND expiry = ${expiry}
    ),
    day_threshold AS (
      SELECT PERCENTILE_CONT(${quantile}) WITHIN GROUP (ORDER BY abs_delta) AS d_thresh
      FROM day_delta_pool
      WHERE abs_delta IS NOT NULL
    ),
    candidates AS (
      SELECT p.*,
             PERCENT_RANK() OVER (ORDER BY ABS(p.greek_post)) AS lvl_rank,
             PERCENT_RANK() OVER (ORDER BY ABS(p.greek_delta)) AS chg_rank
      FROM pairs p
      WHERE ABS(p.greek_delta) >= (SELECT d_thresh FROM day_threshold)
    ),
    spot_lookup AS (
      SELECT c.captured_at, c.strike, c.greek_post, c.greek_prior,
             c.greek_delta, c.lvl_rank, c.chg_rank,
             (SELECT close::numeric FROM index_candles_1m
              WHERE symbol = 'SPX' AND timestamp <= c.captured_at
              ORDER BY timestamp DESC LIMIT 1) AS spot_at_event
      FROM candidates c
    )
    SELECT * FROM spot_lookup
    WHERE spot_at_event IS NOT NULL
  `) as SliceRow[];

  return rows;
}

/**
 * Fetch gex_target_features (mode='oi') for the given strike at-or-before ts.
 * Returns null if no row exists.
 */
async function fetchGexTarget(
  strike: number,
  ts: Date,
): Promise<GexTargetRow | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT gex_dollars, call_ratio
    FROM gex_target_features
    WHERE strike = ${strike}
      AND mode = 'oi'
      AND timestamp <= ${ts}
    ORDER BY timestamp DESC
    LIMIT 1
  `) as GexTargetRow[];
  return rows[0] ?? null;
}

/**
 * Compute QQQ net premium balance over the (ts - 30min, ts] window.
 * Returns null if no data. Range [-1, +1] — positive = call-heavy.
 */
async function fetchQqqNetPremBalance30m(ts: Date): Promise<number | null> {
  const sql = getDb();
  const windowStart = new Date(ts.getTime() - 30 * 60_000);
  const rows = (await sql`
    SELECT SUM(net_call_prem)::numeric AS sum_call,
           SUM(net_put_prem)::numeric  AS sum_put
    FROM net_flow_per_ticker_history
    WHERE ticker = 'QQQ'
      AND ts > ${windowStart}
      AND ts <= ${ts}
  `) as FlowRow[];
  const r = rows[0];
  if (!r) return null;
  const c = toNum(r.sum_call);
  const p = toNum(r.sum_put);
  if (Number.isNaN(c) || Number.isNaN(p)) return null;
  const total = Math.abs(c) + Math.abs(p);
  if (total === 0) return null;
  return (c - p) / total;
}

/**
 * First observed option price at trade_strike within +5 minutes of ts.
 * Pulled from ws_option_trades (live SPX tape from the uw-stream daemon).
 */
async function fetchEntryPx(
  expiry: string,
  tradeStrike: number,
  optionType: 'C' | 'P',
  ts: Date,
): Promise<number | null> {
  const sql = getDb();
  const windowEnd = new Date(ts.getTime() + 5 * 60_000);
  const rows = (await sql`
    SELECT price::numeric AS price
    FROM ws_option_trades
    WHERE ticker = 'SPXW'
      AND expiry = ${expiry}
      AND strike = ${tradeStrike}
      AND option_type = ${optionType}
      AND executed_at >= ${ts}
      AND executed_at <= ${windowEnd}
      AND canceled = FALSE
      AND price > 0
    ORDER BY executed_at ASC
    LIMIT 1
  `) as { price: DbNumeric }[];
  return rows[0] ? toNum(rows[0].price) : null;
}

/** Latest VIX from market_snapshots at-or-before ts */
async function fetchLatestVix(ts: Date): Promise<number | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT vix::numeric AS vix
    FROM market_snapshots
    WHERE created_at <= ${ts}
      AND vix IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1
  `) as { vix: DbNumeric }[];
  return rows[0] ? toNum(rows[0].vix) : null;
}

/**
 * Per-candidate filter + augmentation for the call lottery. Extracted
 * so the live cron and the historical backfill can share the same
 * downstream logic. Returns null when the candidate fails the filter
 * (caller skips it); a fire record otherwise.
 */
async function applyCallFilter(
  c: SliceRow,
  expiry: string,
): Promise<PeriscopeLotteryFire | null> {
  const t = PERISCOPE_LOTTERY_THRESHOLDS.CALL;
  const strike = Math.round(toNum(c.strike));
  const spot = toNum(c.spot_at_event);
  const greekPost = toNum(c.greek_post);
  const greekDelta = toNum(c.greek_delta);
  const lvlRank = toNum(c.lvl_rank);
  const chgRank = toNum(c.chg_rank);
  const strikeDist = strike - spot;
  const fireTime = toDate(c.captured_at);

  if (strike <= spot) return null;
  if (greekPost >= 0) return null;
  if (lvlRank < t.RANK_FLOOR || chgRank < t.RANK_FLOOR) return null;
  if (strikeDist < t.STRIKE_DIST_MIN_PTS) return null;

  const gex = await fetchGexTarget(strike, fireTime);
  const gexDollars = gex ? toNum(gex.gex_dollars) : null;
  if (
    gexDollars === null ||
    Number.isNaN(gexDollars) ||
    gexDollars >= t.GEX_DOLLARS_MAX
  )
    return null;

  const callRatio = gex ? toNum(gex.call_ratio) : null;
  const qqqBalance = await fetchQqqNetPremBalance30m(fireTime);
  const tradeStrike = strike + t.TRADE_OFFSET_PTS;
  const entryPx = await fetchEntryPx(expiry, tradeStrike, 'C', fireTime);
  const vix = await fetchLatestVix(fireTime);

  return {
    fireType: 'call_lottery',
    fireTime,
    expiry,
    eventStrike: strike,
    tradeStrike,
    spotAtEvent: spot,
    strikeDist,
    greekPost,
    greekDelta,
    greekLvlRank: lvlRank,
    greekChgRank: chgRank,
    gexDollars,
    callRatio,
    qqqNetPremBalance30m: qqqBalance,
    entryPx,
    vix,
    v3StrictPass: true,
    v4Badge:
      qqqBalance !== null &&
      Math.abs(qqqBalance) >= t.QQQ_BALANCE_BADGE_MIN_ABS,
    peakPx: null,
    peakPct: null,
    peakTime: null,
    eodClosePx: null,
    realizedRPeak: null,
    realizedREod: null,
    outcomeLocked: false,
  };
}

/**
 * Filter I — call lottery. Runs the v3 strict filter cascade:
 *
 *   strike > spot
 *   greek_post < 0 (deep_neg)
 *   lvl_rank >= 0.90 AND chg_rank >= 0.90
 *   strike - spot >= 15
 *   gex_dollars < 1e9 (signed value — catches both deep-negative and
 *                       low-positive book maturity)
 */
export async function detectCallLottery(
  expiry: string,
): Promise<PeriscopeLotteryFire[]> {
  const candidates = await fetchCandidates('gamma', expiry);
  const fires: PeriscopeLotteryFire[] = [];
  for (const c of candidates) {
    const fire = await applyCallFilter(c, expiry);
    if (fire) fires.push(fire);
  }
  return fires;
}

/**
 * Per-candidate filter + augmentation for the put lottery. Same shape
 * as applyCallFilter — extracted so live and backfill share it.
 */
async function applyPutFilter(
  c: SliceRow,
  expiry: string,
): Promise<PeriscopeLotteryFire | null> {
  const t = PERISCOPE_LOTTERY_THRESHOLDS.PUT;
  const strike = Math.round(toNum(c.strike));
  const spot = toNum(c.spot_at_event);
  const greekPost = toNum(c.greek_post);
  const greekDelta = toNum(c.greek_delta);
  const lvlRank = toNum(c.lvl_rank);
  const chgRank = toNum(c.chg_rank);
  const strikeDist = spot - strike;
  const fireTime = toDate(c.captured_at);

  if (strike >= spot) return null;
  if (strikeDist < t.STRIKE_DIST_MIN_PTS) return null;

  const gex = await fetchGexTarget(strike, fireTime);
  const gexDollars = gex ? toNum(gex.gex_dollars) : null;
  const callRatio = gex ? toNum(gex.call_ratio) : null;
  if (
    callRatio === null ||
    Number.isNaN(callRatio) ||
    callRatio >= t.CALL_RATIO_MAX
  )
    return null;

  const tradeStrike = strike - t.TRADE_OFFSET_PTS;
  const entryPx = await fetchEntryPx(expiry, tradeStrike, 'P', fireTime);
  const vix = await fetchLatestVix(fireTime);

  return {
    fireType: 'put_lottery',
    fireTime,
    expiry,
    eventStrike: strike,
    tradeStrike,
    spotAtEvent: spot,
    strikeDist,
    greekPost,
    greekDelta,
    greekLvlRank: lvlRank,
    greekChgRank: chgRank,
    gexDollars,
    callRatio,
    qqqNetPremBalance30m: null, // not used for L
    entryPx,
    vix,
    v3StrictPass: true,
    v4Badge: entryPx !== null && entryPx <= t.ENTRY_PX_BADGE_MAX,
    peakPx: null,
    peakPct: null,
    peakTime: null,
    eodClosePx: null,
    realizedRPeak: null,
    realizedREod: null,
    outcomeLocked: false,
  };
}

/**
 * Filter L — put lottery.
 *
 *   strike < spot
 *   (no sign filter — both post_pos and post_neg charm produce winners)
 *   chg_rank above the day's top-5% threshold (achieved via fetchCandidates)
 *   spot - strike >= 10
 *   call_ratio < 1.5 (put-dominated wing — call-heavy strikes have no
 *                     dealer short-put book to force-hedge)
 */
export async function detectPutLottery(
  expiry: string,
): Promise<PeriscopeLotteryFire[]> {
  const candidates = await fetchCandidates('charm', expiry);
  const fires: PeriscopeLotteryFire[] = [];
  for (const c of candidates) {
    const fire = await applyPutFilter(c, expiry);
    if (fire) fires.push(fire);
  }
  return fires;
}

/**
 * Pull ALL slice-pair events for the expiry's full day. Same query
 * shape as fetchCandidates but using a LAG window for slice-over-slice
 * deltas instead of `latest_slot vs prior_slot` join, and partitioning
 * `lvl_rank` / `chg_rank` by `captured_at` so per-slot ranking matches
 * the live cron's semantics.
 *
 * Used by the historical backfill — never by the live cron.
 *
 * Semantic note vs. the live `fetchCandidates`: the live query joins
 * the latest slot's rows against a single global `prior_slot`
 * captured_at. This backfill uses `LAG(value) OVER (PARTITION BY
 * strike ORDER BY captured_at)`, which gives the strike's own previous
 * row regardless of whether other strikes were captured in between.
 * In practice Periscope publishes every strike on every 10-min slice,
 * so the LAG row's captured_at == the previous slot's captured_at and
 * the two queries are equivalent. If a strike ever misses a slice, the
 * backfill spans a longer time gap for that one transition only.
 */
async function fetchAllCandidatesForExpiry(
  panel: 'gamma' | 'charm',
  expiry: string,
): Promise<SliceRow[]> {
  const sql = getDb();
  const dayTopPct =
    panel === 'gamma'
      ? PERISCOPE_LOTTERY_THRESHOLDS.CALL.DAY_TOP_PCT
      : PERISCOPE_LOTTERY_THRESHOLDS.PUT.DAY_TOP_PCT;
  const quantile = 1 - dayTopPct;

  const rows = (await sql`
    WITH pairs AS (
      SELECT
        captured_at,
        strike,
        value AS greek_post,
        LAG(value) OVER (PARTITION BY strike ORDER BY captured_at)
          AS greek_prior,
        value - LAG(value) OVER (PARTITION BY strike ORDER BY captured_at)
          AS greek_delta
      FROM periscope_snapshots
      WHERE panel = ${panel} AND expiry = ${expiry}
    ),
    day_threshold AS (
      SELECT PERCENTILE_CONT(${quantile})
        WITHIN GROUP (ORDER BY ABS(greek_delta)) AS d_thresh
      FROM pairs
      WHERE greek_delta IS NOT NULL
    ),
    candidates AS (
      SELECT
        p.*,
        PERCENT_RANK() OVER (PARTITION BY captured_at ORDER BY ABS(greek_post))
          AS lvl_rank,
        PERCENT_RANK() OVER (PARTITION BY captured_at ORDER BY ABS(greek_delta))
          AS chg_rank
      FROM pairs p
      WHERE p.greek_prior IS NOT NULL
        AND ABS(p.greek_delta) >= (SELECT d_thresh FROM day_threshold)
    ),
    spot_lookup AS (
      SELECT
        c.captured_at, c.strike, c.greek_post, c.greek_prior,
        c.greek_delta, c.lvl_rank, c.chg_rank,
        (SELECT close::numeric FROM index_candles_1m
         WHERE symbol = 'SPX' AND timestamp <= c.captured_at
         ORDER BY timestamp DESC LIMIT 1) AS spot_at_event
      FROM candidates c
    )
    SELECT * FROM spot_lookup
    WHERE spot_at_event IS NOT NULL
    ORDER BY captured_at, strike
  `) as SliceRow[];

  return rows;
}

/**
 * Backfill variants — run the full v3 strict filter across every
 * slice-pair in the day, not just the latest. Identical downstream
 * semantics to the live `detectCallLottery` / `detectPutLottery`.
 */
export async function detectCallLotteryAllForDate(
  expiry: string,
): Promise<PeriscopeLotteryFire[]> {
  const candidates = await fetchAllCandidatesForExpiry('gamma', expiry);
  const fires: PeriscopeLotteryFire[] = [];
  for (const c of candidates) {
    const fire = await applyCallFilter(c, expiry);
    if (fire) fires.push(fire);
  }
  return fires;
}

export async function detectPutLotteryAllForDate(
  expiry: string,
): Promise<PeriscopeLotteryFire[]> {
  const candidates = await fetchAllCandidatesForExpiry('charm', expiry);
  const fires: PeriscopeLotteryFire[] = [];
  for (const c of candidates) {
    const fire = await applyPutFilter(c, expiry);
    if (fire) fires.push(fire);
  }
  return fires;
}

/** Today as YYYY-MM-DD (UTC date — periscope rows key off this). */
export function todayExpiry(): string {
  return isoDate(new Date());
}

export {
  fetchCandidates,
  fetchGexTarget,
  fetchQqqNetPremBalance30m,
  fetchEntryPx,
  fetchLatestVix,
};
