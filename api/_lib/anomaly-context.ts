/**
 * Strike IV Anomaly Detector — Phase 2 context capture.
 *
 * `gatherContextSnapshot(ticker, ts)` builds the ~35-field
 * `ContextSnapshot` that gets serialized into
 * `iv_anomalies.context_snapshot` (JSONB). The goal is forensic: at
 * EOD (Phase 4 resolve) and during later ML training we need to
 * reconstruct the full cross-asset state at T=detection to separate
 * tradeable alpha from regime-noise.
 *
 * **No new ingestion.** Every field is a join / aggregation over
 * existing cron streams:
 *
 *   - Own-ticker / SPX/SPY/QQQ 15m deltas: `strike_iv_snapshots.spot`
 *     (Phase 1 writes this minute-by-minute).
 *   - SPX spot for 5m/60m deltas: `spx_candles_1m` (1-min SPX bars).
 *   - Futures (ES, NQ, RTY, ZN, CL, GC, DX): `futures_bars`.
 *     ZN/CL/GC/DX double as bond/oil/gold/dollar proxies for the
 *     macro backdrop (no intraday TLT/USO/GLD/DXY ETF ingestion
 *     exists in this repo — futures proxies are as close as we get).
 *   - NQ OFI 1h: `computeMicrostructureSignals('NQ')` from
 *     `microstructure-signals.ts` (validated signal ρ=0.31).
 *   - VIX level + deltas: `market_snapshots.vix` (event-driven but
 *     regularly populated during active sessions).
 *   - VIX1D / VIX9D: only stored as daily closes. We return today's
 *     close if available; otherwise null.
 *   - Flow alerts: `flow_alerts` table (UW per-ticker alerts).
 *   - Dark prints: `dark_pool_levels` (aggregated-by-strike; we use
 *     this as a proxy for "recent prints" by selecting recent rows).
 *     Per `feedback_darkpool_filters.md`, the aggregation cron
 *     already drops average_price/derivative_priced/contingent trades
 *     upstream of this table.
 *   - Econ events: `economic_events` (today's calendar).
 *   - Institutional program: `institutional_blocks` latest row
 *     (Phase 81 table).
 *   - Net flow 5m: `flow_data` source='spx_flow' (or spy/qqq_flow).
 *   - NOPE: `nope_ticks` (SPY NOPE per-minute).
 *   - Zero-gamma: `zero_gamma_levels` (Phase 82 table).
 *
 * Known null-by-design fields (sources don't exist in this repo):
 *   - `iwm_delta_15m` (no intraday IWM ingestion — RTY futures are
 *     populated into a sibling field instead of swapped in here)
 *   - `ym_delta_15m` (no YM futures ingestion)
 *   - `spy_delta_15m` / `qqq_delta_15m` pull from
 *     `strike_iv_snapshots` spot column which is populated by
 *     Phase 1. `spx_delta_15m` uses `spx_candles_1m` since it's a
 *     more reliable 1-min cadence source.
 *
 * Each field is an independent query wrapped to return null on miss.
 * `Promise.all` composes them so a single slow source doesn't block
 * the rest; a single failure doesn't void the whole snapshot.
 */

import { getDb } from './db.js';
import { redis } from './schwab.js';
import { computeMicrostructureSignals } from './microstructure-signals.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import logger from './logger.js';

// ── Public type ──────────────────────────────────────────────

export interface ContextSnapshot {
  // Own-ticker dynamics
  spot_delta_5m: number | null;
  spot_delta_15m: number | null;
  spot_delta_60m: number | null;
  vwap_distance: number | null;
  volume_percentile: number | null;

  // Cross-ticker (macro tape check)
  spx_delta_15m: number | null;
  spy_delta_15m: number | null;
  qqq_delta_15m: number | null;
  iwm_delta_15m: number | null;

  // Futures (leading indicators)
  es_delta_15m: number | null;
  nq_delta_15m: number | null;
  ym_delta_15m: number | null;
  rty_delta_15m: number | null;
  nq_ofi_1h: number | null;

  // Vol regime
  vix_level: number | null;
  vix_delta_5m: number | null;
  vix_delta_15m: number | null;
  vix_term_1d: number | null;
  vix_term_9d: number | null;
  /**
   * Spot VIX itself (not a separate 30-day forward series). VIX is
   * already a 30-day forward-looking implied-variance measure, so we
   * expose it here for downstream ML consumers that want all three
   * term-structure points in one place (VIX1D / VIX9D / VIX). Named
   * `vix_30d_spot` to avoid implying a VIX3M / VIX30D index feed that
   * doesn't exist in this repo.
   */
  vix_30d_spot: number | null;

  // Macro backdrop (futures proxies — see module doc)
  dxy_delta_15m: number | null;
  tlt_delta_15m: number | null;
  gld_delta_15m: number | null;
  uso_delta_15m: number | null;

  // Flow context
  recent_flow_alerts: Array<{ ts: string; type: string; premium: number }>;
  /**
   * Recent dark-pool prints from `dark_pool_levels`. **SPX-only**: the
   * underlying aggregation is SPX-scoped, so this field is always `[]`
   * for SPY/QQQ anomalies to avoid mis-attributing SPX flow to a
   * different ticker. `premium` holds the aggregated dollar premium,
   * not a share/contract count.
   */
  spx_recent_dark_prints: Array<{
    ts: string;
    price: number;
    premium: number;
  }>;

  // Event proximity
  econ_release_t_minus: number | null;
  econ_release_t_plus: number | null;
  econ_release_name: string | null;

  // Institutional
  institutional_program_latest: {
    ts: string;
    premium: number;
    side: string;
  } | null;

  // Options aggregates
  net_flow_5m: number | null;
  nope_current: number | null;
  put_premium_0dte_pctile: number | null;

  // Gamma structure
  zero_gamma_level: number | null;
  zero_gamma_distance_pct: number | null;
}

// ── Helpers ──────────────────────────────────────────────────

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** ts minus N minutes, as an ISO string. */
function minusMinutes(ts: Date, mins: number): string {
  return new Date(ts.getTime() - mins * 60_000).toISOString();
}

/** Fraction-change helper: null if either value is null/zero/non-finite. */
function pctDelta(earlier: number | null, later: number | null): number | null {
  if (earlier == null || later == null) return null;
  if (!Number.isFinite(earlier) || !Number.isFinite(later)) return null;
  if (earlier === 0) return null;
  const v = (later - earlier) / earlier;
  return Number.isFinite(v) ? v : null;
}

/** Absolute-change helper (for VIX, expressed in VIX points). */
function absDelta(earlier: number | null, later: number | null): number | null {
  if (earlier == null || later == null) return null;
  if (!Number.isFinite(earlier) || !Number.isFinite(later)) return null;
  return later - earlier;
}

async function runSafe<T>(
  label: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger.warn(
      { err, label },
      'anomaly-context: source failed, using fallback',
    );
    return fallback;
  }
}

// ── Source-specific queries ──────────────────────────────────

/**
 * Look up the latest spot price for a ticker from strike_iv_snapshots
 * within a staleness window. Used for SPY/QQQ own-ticker and cross-ticker
 * deltas (since spx_candles_1m is SPX-only).
 */
async function getSpotFromStrikeIV(
  ticker: string,
  at: Date,
  stalenessMs: number,
): Promise<number | null> {
  const sql = getDb();
  const atIso = at.toISOString();
  const earliestIso = new Date(at.getTime() - stalenessMs).toISOString();
  const rows = await sql`
    SELECT spot FROM strike_iv_snapshots
    WHERE ticker = ${ticker}
      AND ts <= ${atIso}
      AND ts >= ${earliestIso}
    ORDER BY ts DESC
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return toNum(rows[0]!.spot);
}

/**
 * SPX 1-min close at a given point in time. Uses the 2-min staleness
 * window convention from vix-divergence.ts (composite index friendly).
 */
async function getSpxCloseAt(at: Date): Promise<number | null> {
  const sql = getDb();
  const atIso = at.toISOString();
  const earliest = new Date(at.getTime() - 2 * 60_000);
  const earliestIso = earliest.toISOString();
  const atDate = getETDateStr(at);
  const earliestDate = getETDateStr(earliest);
  const dates = atDate === earliestDate ? [atDate] : [earliestDate, atDate];
  const rows = await sql`
    SELECT close FROM spx_candles_1m
    WHERE date = ANY(${dates})
      AND timestamp <= ${atIso}
      AND timestamp >= ${earliestIso}
    ORDER BY timestamp DESC
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return toNum(rows[0]!.close);
}

/**
 * Latest futures close at/before `at` within a staleness window.
 * Window is 20 minutes so a 15-minute lookback can still find a bar
 * even if the latest minute is missing (ES/NQ are near-continuous but
 * ZN/GC/DX can gap).
 */
async function getFuturesCloseAt(
  symbol: string,
  at: Date,
): Promise<number | null> {
  const sql = getDb();
  const atIso = at.toISOString();
  const earliestIso = new Date(at.getTime() - 20 * 60_000).toISOString();
  const rows = await sql`
    SELECT close FROM futures_bars
    WHERE symbol = ${symbol}
      AND ts <= ${atIso}
      AND ts >= ${earliestIso}
    ORDER BY ts DESC
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return toNum(rows[0]!.close);
}

/**
 * VIX level at a given point in time. market_snapshots is event-driven
 * (written whenever the calculator runs) so we widen the staleness
 * window to 10 min vs 2 min for cadence-driven sources.
 */
async function getVixAt(at: Date): Promise<number | null> {
  const sql = getDb();
  const atIso = at.toISOString();
  const earliestIso = new Date(at.getTime() - 10 * 60_000).toISOString();
  const rows = await sql`
    SELECT vix FROM market_snapshots
    WHERE created_at <= ${atIso}
      AND created_at >= ${earliestIso}
      AND vix IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return toNum(rows[0]!.vix);
}

/**
 * Latest VIX9D level from market_snapshots today. Same event-driven
 * source as VIX — returns null if the calculator hasn't run today.
 */
async function getVix9dLatest(): Promise<number | null> {
  const sql = getDb();
  const today = getETDateStr(new Date());
  const rows = await sql`
    SELECT vix9d FROM market_snapshots
    WHERE date = ${today}
      AND vix9d IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return toNum(rows[0]!.vix9d);
}

/**
 * Latest VIX1D close from the Redis daily map populated by
 * refresh-vix1d cron. The map is keyed by ISO date (YYYY-MM-DD) and
 * stores {o,h,l,c}; we only want the close. Returns null on Redis miss
 * or if the most recent entry isn't today's.
 */
async function getVix1dLatest(): Promise<number | null> {
  try {
    const map = (await redis.get('vix1d:daily-map')) as
      | Record<string, { o: number; h: number; l: number; c: number }>
      | null
      | string;
    if (!map) return null;
    const parsed =
      typeof map === 'string'
        ? (JSON.parse(map) as Record<string, { c: number }>)
        : (map as Record<string, { c: number }>);
    const today = getETDateStr(new Date());
    const entry = parsed[today];
    if (!entry) {
      // Fall back to the most recent entry (last weekday's close).
      const keys = Object.keys(parsed).sort();
      const lastKey = keys[keys.length - 1];
      if (!lastKey) return null;
      return toNum(parsed[lastKey]!.c);
    }
    return toNum(entry.c);
  } catch (err) {
    logger.warn({ err }, 'getVix1dLatest: redis read failed');
    return null;
  }
}

/**
 * Recent UW flow alerts for the same ticker, within the last 15 min.
 */
async function getRecentFlowAlerts(
  ticker: string,
  at: Date,
): Promise<Array<{ ts: string; type: string; premium: number }>> {
  const sql = getDb();
  const atIso = at.toISOString();
  const earliestIso = minusMinutes(at, 15);
  const rows = await sql`
    SELECT created_at, alert_rule, total_premium
    FROM flow_alerts
    WHERE ticker = ${ticker}
      AND created_at >= ${earliestIso}
      AND created_at <= ${atIso}
    ORDER BY created_at DESC
    LIMIT 20
  `;
  return rows.map((r) => {
    const ts =
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at);
    return {
      ts,
      type: String(r.alert_rule ?? 'unknown'),
      premium: toNum(r.total_premium) ?? 0,
    };
  });
}

/**
 * Recent dark pool levels (aggregated-by-strike prints) within the last
 * 15 min. The aggregation cron already drops average_price/derivative/
 * contingent trades upstream, so what lands here is already filtered
 * per feedback_darkpool_filters.md.
 *
 * **SPX-only**: `dark_pool_levels` is SPX-scoped in this repo. Callers
 * must gate on ticker === 'SPX' to avoid returning SPX prints for SPY
 * or QQQ anomalies. The output field maps `total_premium` (dollars) to
 * `premium` — not `size` — so downstream consumers aren't misled into
 * treating it as a share/contract count.
 */
async function getRecentDarkPrints(
  at: Date,
): Promise<Array<{ ts: string; price: number; premium: number }>> {
  const sql = getDb();
  const atIso = at.toISOString();
  const earliestIso = minusMinutes(at, 15);
  const today = getETDateStr(at);
  const rows = await sql`
    SELECT latest_time, spx_approx, total_premium
    FROM dark_pool_levels
    WHERE date = ${today}
      AND latest_time >= ${earliestIso}
      AND latest_time <= ${atIso}
    ORDER BY latest_time DESC
    LIMIT 20
  `;
  return rows.map((r) => {
    const ts =
      r.latest_time instanceof Date
        ? r.latest_time.toISOString()
        : String(r.latest_time);
    return {
      ts,
      price: toNum(r.spx_approx) ?? 0,
      premium: toNum(r.total_premium) ?? 0,
    };
  });
}

/**
 * Closest econ event on either side of `at`, within ±60 min.
 * Returns minutes since/until and the event name.
 */
async function getEconProximity(at: Date): Promise<{
  tMinus: number | null;
  tPlus: number | null;
  name: string | null;
}> {
  const sql = getDb();
  const today = getETDateStr(at);
  const rows = await sql`
    SELECT event_name, event_time
    FROM economic_events
    WHERE date = ${today}
  `;
  if (rows.length === 0) return { tMinus: null, tPlus: null, name: null };

  const now = at.getTime();
  let closestPast: { mins: number; name: string } | null = null;
  let closestFuture: { mins: number; name: string } | null = null;

  for (const r of rows) {
    const evtTs =
      r.event_time instanceof Date
        ? r.event_time.getTime()
        : new Date(String(r.event_time)).getTime();
    if (!Number.isFinite(evtTs)) continue;
    const diffMs = evtTs - now;
    const diffMins = diffMs / 60_000;
    const name = String(r.event_name ?? 'unknown');
    if (diffMs < 0 && Math.abs(diffMins) <= 60) {
      if (closestPast == null || Math.abs(diffMins) < closestPast.mins) {
        closestPast = { mins: Math.abs(diffMins), name };
      }
    } else if (diffMs > 0 && diffMins <= 60) {
      if (closestFuture == null || diffMins < closestFuture.mins) {
        closestFuture = { mins: diffMins, name };
      }
    }
  }

  // Return the closest overall for the `name` field. The spec has
  // both t_minus and t_plus nullable individually.
  let name: string | null = null;
  if (closestPast && closestFuture) {
    name =
      closestPast.mins < closestFuture.mins
        ? closestPast.name
        : closestFuture.name;
  } else {
    name = closestPast?.name ?? closestFuture?.name ?? null;
  }

  return {
    tMinus: closestPast?.mins ?? null,
    tPlus: closestFuture?.mins ?? null,
    name,
  };
}

async function getInstitutionalLatest(at: Date): Promise<{
  ts: string;
  premium: number;
  side: string;
} | null> {
  const sql = getDb();
  const atIso = at.toISOString();
  const earliestIso = minusMinutes(at, 60);
  const rows = await sql`
    SELECT executed_at, premium, side
    FROM institutional_blocks
    WHERE executed_at <= ${atIso}
      AND executed_at >= ${earliestIso}
    ORDER BY executed_at DESC
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const r = rows[0]!;
  const ts =
    r.executed_at instanceof Date
      ? r.executed_at.toISOString()
      : String(r.executed_at);
  return {
    ts,
    premium: toNum(r.premium) ?? 0,
    side: String(r.side ?? 'unknown'),
  };
}

/**
 * Net flow change over the last 5 min from flow_data.
 * Ticker-aware: uses spx_flow for SPX, spy_flow for SPY, qqq_flow for QQQ.
 * Returns the delta in (ncp + npp) — i.e. net options premium $ — over
 * the 5-min window.
 */
async function getNetFlow5m(ticker: string, at: Date): Promise<number | null> {
  const source =
    ticker === 'SPX' ? 'spx_flow' : ticker === 'SPY' ? 'spy_flow' : 'qqq_flow';
  const sql = getDb();
  const atIso = at.toISOString();
  const priorIso = minusMinutes(at, 5);
  const earliestIso = minusMinutes(at, 10);
  const [latest, prior] = await Promise.all([
    sql`
      SELECT ncp, npp FROM flow_data
      WHERE source = ${source}
        AND timestamp <= ${atIso}
        AND timestamp >= ${priorIso}
      ORDER BY timestamp DESC
      LIMIT 1
    `,
    sql`
      SELECT ncp, npp FROM flow_data
      WHERE source = ${source}
        AND timestamp <= ${priorIso}
        AND timestamp >= ${earliestIso}
      ORDER BY timestamp DESC
      LIMIT 1
    `,
  ]);
  if (latest.length === 0 || prior.length === 0) return null;
  const latestSum = (toNum(latest[0]!.ncp) ?? 0) + (toNum(latest[0]!.npp) ?? 0);
  const priorSum = (toNum(prior[0]!.ncp) ?? 0) + (toNum(prior[0]!.npp) ?? 0);
  return latestSum - priorSum;
}

/** Latest SPY NOPE value at/before `at` within 2-min staleness. */
async function getNopeLatest(at: Date): Promise<number | null> {
  const sql = getDb();
  const atIso = at.toISOString();
  const earliestIso = minusMinutes(at, 2);
  const rows = await sql`
    SELECT nope FROM nope_ticks
    WHERE ticker = 'SPY'
      AND timestamp <= ${atIso}
      AND timestamp >= ${earliestIso}
    ORDER BY timestamp DESC
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return toNum(rows[0]!.nope);
}

/**
 * Today's cumulative SPX put premium (npp) vs the same-time-of-day
 * distribution from the trailing 30 trading days.
 * Returns null when insufficient history.
 */
async function getPutPremium0dtePctile(at: Date): Promise<number | null> {
  const sql = getDb();
  const today = getETDateStr(at);
  const atIso = at.toISOString();
  const priorIso = minusMinutes(at, 5);
  const thirtyDaysAgoIso = new Date(
    at.getTime() - 30 * 24 * 60 * 60_000,
  ).toISOString();

  // Today's latest cumulative npp (most-recent in the last 5 min).
  const todayRows = await sql`
    SELECT npp FROM flow_data
    WHERE source = 'spx_flow'
      AND date = ${today}
      AND timestamp <= ${atIso}
      AND timestamp >= ${priorIso}
    ORDER BY timestamp DESC
    LIMIT 1
  `;
  const todayNpp = todayRows.length > 0 ? toNum(todayRows[0]!.npp) : null;
  if (todayNpp == null) return null;

  // Historical same-time-of-day comparison: pull all rows from the last
  // 30 trading days and pick the one closest to the target wall-clock
  // time in JS (avoids a fragile Postgres `date + time` construction
  // that fails silently at query time).
  const targetSeconds =
    at.getUTCHours() * 3600 + at.getUTCMinutes() * 60 + at.getUTCSeconds();
  const historyRows = await sql`
    SELECT date, timestamp, npp
    FROM flow_data
    WHERE source = 'spx_flow'
      AND date < ${today}
      AND timestamp >= ${thirtyDaysAgoIso}
    ORDER BY date DESC, timestamp ASC
    LIMIT 5000
  `;

  // Reduce to one npp per date: the sample whose UTC time-of-day is
  // closest to the target's. Rows come pre-sorted by (date, timestamp)
  // so we just compute the per-row lag and keep the min per date.
  const nppByDate = new Map<string, { lag: number; npp: number }>();
  for (const r of historyRows) {
    const d = String(r.date);
    const n = toNum(r.npp);
    if (n == null) continue;
    const rowTs =
      r.timestamp instanceof Date ? r.timestamp : new Date(String(r.timestamp));
    if (Number.isNaN(rowTs.getTime())) continue;
    const rowSeconds =
      rowTs.getUTCHours() * 3600 +
      rowTs.getUTCMinutes() * 60 +
      rowTs.getUTCSeconds();
    const lag = Math.abs(rowSeconds - targetSeconds);
    const prev = nppByDate.get(d);
    if (!prev || lag < prev.lag) nppByDate.set(d, { lag, npp: n });
  }

  const samples = [...nppByDate.values()].map((v) => v.npp);
  if (samples.length < 5) return null;

  // Percentile rank: what fraction of historical npp values are strictly
  // above todayNpp? npp is negative for put-heavy sessions, so a smaller
  // (more-negative) todayNpp means MORE put pressure today — and more
  // historical samples will be above it. The returned percentile is the
  // "put-pressure rank" where 100 = most put-heavy observed.
  const countAbove = samples.filter((v) => v > todayNpp).length;
  return (countAbove / samples.length) * 100;
}

async function getZeroGammaLatest(at: Date): Promise<{
  level: number | null;
  distancePct: number | null;
}> {
  const sql = getDb();
  const atIso = at.toISOString();
  const earliestIso = minusMinutes(at, 10);
  const rows = await sql`
    SELECT spot, zero_gamma
    FROM zero_gamma_levels
    WHERE ticker = 'SPX'
      AND ts <= ${atIso}
      AND ts >= ${earliestIso}
    ORDER BY ts DESC
    LIMIT 1
  `;
  if (rows.length === 0) return { level: null, distancePct: null };
  const spot = toNum(rows[0]!.spot);
  const zeroGamma = toNum(rows[0]!.zero_gamma);
  if (zeroGamma == null || spot == null || spot === 0) {
    return { level: zeroGamma, distancePct: null };
  }
  return {
    level: zeroGamma,
    distancePct: ((spot - zeroGamma) / spot) * 100,
  };
}

// ── Orchestrator ─────────────────────────────────────────────

/**
 * Build the full ContextSnapshot for an anomaly at (ticker, ts).
 *
 * Each field is fetched independently. A failing source logs and
 * resolves to null/[] rather than rejecting the whole snapshot —
 * per spec, the downstream consumer is expected to null-check.
 */
export async function gatherContextSnapshot(
  ticker: string,
  ts: Date,
): Promise<ContextSnapshot> {
  const atNow = ts;
  const at5m = new Date(ts.getTime() - 5 * 60_000);
  const at15m = new Date(ts.getTime() - 15 * 60_000);
  const at60m = new Date(ts.getTime() - 60 * 60_000);

  // Same-staleness windows keep the deltas comparable across tickers.
  const SPOT_STALENESS = 5 * 60_000; // 5 min — strike_iv is written every minute

  // Own-ticker spot series.
  const [ownNow, own5m, own15m, own60m] = await Promise.all([
    runSafe(
      'own-now',
      () => getSpotFromStrikeIV(ticker, atNow, SPOT_STALENESS),
      null,
    ),
    runSafe(
      'own-5m',
      () => getSpotFromStrikeIV(ticker, at5m, SPOT_STALENESS),
      null,
    ),
    runSafe(
      'own-15m',
      () => getSpotFromStrikeIV(ticker, at15m, SPOT_STALENESS),
      null,
    ),
    runSafe(
      'own-60m',
      () => getSpotFromStrikeIV(ticker, at60m, SPOT_STALENESS),
      null,
    ),
  ]);

  // Cross-ticker spots. SPX gets the 1-min candle source for fidelity;
  // SPY/QQQ/IWM fall back to strike_iv_snapshots when populated.
  const [spxNow, spx15m, spyNow, spy15m, qqqNow, qqq15m] = await Promise.all([
    runSafe('spx-now', () => getSpxCloseAt(atNow), null),
    runSafe('spx-15m', () => getSpxCloseAt(at15m), null),
    runSafe(
      'spy-now',
      () => getSpotFromStrikeIV('SPY', atNow, SPOT_STALENESS),
      null,
    ),
    runSafe(
      'spy-15m',
      () => getSpotFromStrikeIV('SPY', at15m, SPOT_STALENESS),
      null,
    ),
    runSafe(
      'qqq-now',
      () => getSpotFromStrikeIV('QQQ', atNow, SPOT_STALENESS),
      null,
    ),
    runSafe(
      'qqq-15m',
      () => getSpotFromStrikeIV('QQQ', at15m, SPOT_STALENESS),
      null,
    ),
  ]);

  // Futures closes at T=now and T-15m.
  const futuresSymbols = ['ES', 'NQ', 'RTY', 'ZN', 'CL', 'GC', 'DX'] as const;
  const futuresAtNow = await Promise.all(
    futuresSymbols.map((s) =>
      runSafe(`fut-now-${s}`, () => getFuturesCloseAt(s, atNow), null),
    ),
  );
  const futuresAt15m = await Promise.all(
    futuresSymbols.map((s) =>
      runSafe(`fut-15m-${s}`, () => getFuturesCloseAt(s, at15m), null),
    ),
  );

  // NQ OFI 1h. The function short-circuits on missing sidecar data.
  const nqSignals = await runSafe(
    'nq-ofi',
    () => computeMicrostructureSignals(atNow, 'NQ'),
    null,
  );

  // VIX current + deltas.
  const [vixNow, vix5m, vix15m] = await Promise.all([
    runSafe('vix-now', () => getVixAt(atNow), null),
    runSafe('vix-5m', () => getVixAt(at5m), null),
    runSafe('vix-15m', () => getVixAt(at15m), null),
  ]);
  const [vix1d, vix9d] = await Promise.all([
    runSafe('vix1d', () => getVix1dLatest(), null),
    runSafe('vix9d', () => getVix9dLatest(), null),
  ]);

  // Flow context. Dark prints are SPX-only (dark_pool_levels is a
  // SPX-aggregated feed) — for SPY/QQQ anomalies we return [] rather
  // than mis-attributing SPX flow to a different ticker.
  const [flowAlerts, darkPrints] = await Promise.all([
    runSafe('flow-alerts', () => getRecentFlowAlerts(ticker, atNow), []),
    ticker === 'SPX'
      ? runSafe('dark-prints', () => getRecentDarkPrints(atNow), [])
      : Promise.resolve(
          [] as Array<{ ts: string; price: number; premium: number }>,
        ),
  ]);

  // Event proximity / institutional / options aggregates.
  const [econ, inst, netFlow, nope, pctile, zeroGamma] = await Promise.all([
    runSafe('econ', () => getEconProximity(atNow), {
      tMinus: null,
      tPlus: null,
      name: null,
    }),
    runSafe('inst', () => getInstitutionalLatest(atNow), null),
    runSafe('net-flow', () => getNetFlow5m(ticker, atNow), null),
    runSafe('nope', () => getNopeLatest(atNow), null),
    runSafe('put-pctile', () => getPutPremium0dtePctile(atNow), null),
    runSafe('zero-gamma', () => getZeroGammaLatest(atNow), {
      level: null,
      distancePct: null,
    }),
  ]);

  // Assemble.
  return {
    spot_delta_5m: pctDelta(own5m, ownNow),
    spot_delta_15m: pctDelta(own15m, ownNow),
    spot_delta_60m: pctDelta(own60m, ownNow),
    vwap_distance: null, // no session-VWAP source exists — null by design
    volume_percentile: null, // no 30-day per-time-of-day volume distribution

    spx_delta_15m: pctDelta(spx15m, spxNow),
    spy_delta_15m: pctDelta(spy15m, spyNow),
    qqq_delta_15m: pctDelta(qqq15m, qqqNow),
    iwm_delta_15m: null, // no intraday IWM ingestion; RTY is proxied below

    es_delta_15m: pctDelta(futuresAt15m[0] ?? null, futuresAtNow[0] ?? null),
    nq_delta_15m: pctDelta(futuresAt15m[1] ?? null, futuresAtNow[1] ?? null),
    ym_delta_15m: null, // YM not ingested; ES is best-available index proxy
    rty_delta_15m: pctDelta(futuresAt15m[2] ?? null, futuresAtNow[2] ?? null),
    nq_ofi_1h: nqSignals?.ofi1h ?? null,

    vix_level: vixNow,
    vix_delta_5m: absDelta(vix5m, vixNow),
    vix_delta_15m: absDelta(vix15m, vixNow),
    vix_term_1d: vix1d,
    vix_term_9d: vix9d,
    vix_30d_spot: vixNow,

    dxy_delta_15m: pctDelta(futuresAt15m[6] ?? null, futuresAtNow[6] ?? null),
    tlt_delta_15m: pctDelta(futuresAt15m[3] ?? null, futuresAtNow[3] ?? null),
    gld_delta_15m: pctDelta(futuresAt15m[5] ?? null, futuresAtNow[5] ?? null),
    uso_delta_15m: pctDelta(futuresAt15m[4] ?? null, futuresAtNow[4] ?? null),

    recent_flow_alerts: flowAlerts,
    spx_recent_dark_prints: darkPrints,

    econ_release_t_minus: econ.tMinus,
    econ_release_t_plus: econ.tPlus,
    econ_release_name: econ.name,

    institutional_program_latest: inst,

    net_flow_5m: netFlow,
    nope_current: nope,
    put_premium_0dte_pctile: pctile,

    zero_gamma_level: zeroGamma.level,
    zero_gamma_distance_pct: zeroGamma.distancePct,
  };
}
