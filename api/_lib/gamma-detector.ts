/**
 * Gamma-Node Composite Detector — shared detection logic.
 *
 * Pure(ish) functions + DB helpers used by:
 *  - cron/detect-gamma-setups.ts (1-min real-time fire detection)
 *  - cron/backfill-gamma-setup-outcomes.ts (EOD forward-return backfill)
 *  - api/gamma-setups-active.ts (frontend tile read)
 *
 * Three trigger types:
 *  - E1 long-call breakthrough: bar opens below +γ ceiling, breaks above,
 *    closes above, next 3 bars hold above.
 *  - E5 long-put failed-reversal: a recent (≤10 min) down-wick rejected
 *    a +γ floor, but price never recovered, and now broke 1pt below the
 *    wick low.
 *  - PCS Monday rejection: down-wick at a SMALL (|gex|≤$500k) +γ floor,
 *    bar.open > node, bar.low < node, bar.close > node. Monday + ES basis
 *    holding + not flat-gap day.
 *
 * Detection is INTENTIONALLY CONSERVATIVE for Phase 1 — better to miss
 * a setup than to fire a false positive on a brand-new alert system.
 * Tune the thresholds once we have live data (Phase 3).
 *
 * Spec: docs/superpowers/specs/gamma-node-composite-detector-2026-05-21.md
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';

import { withDbRetry } from './db.js';
import { getETDateStr } from '../../src/utils/timezone.js';

type Sql = NeonQueryFunction<false, false>;

// ============================================================
// CONSTANTS — kept here for easy tuning
// ============================================================

/** Maximum |gex| for the PCS Monday "small wall" filter. */
export const PCS_MAX_ABS_GEX = 500_000;

/** ES basis change is "top quartile" if >= +0.5 pts in last 5 min.
 *  Phase 1: this is a placeholder threshold — refine after backtest. */
export const PCS_ES_BASIS_MIN_CHANGE = 0.5;

/** Pre-day filter thresholds for the MAXIMUM-tier upgrade on Monday. */
export const PREDAY_5D_RET_THRESHOLD = -0.01;
export const PREDAY_IV_RANK_THRESHOLD = 25;

/** Flat-gap day threshold: |open_gap| < 0.1% means PCS is skipped per
 *  D3 anti-filter from the brainstorm analysis. */
export const FLAT_GAP_PCT_THRESHOLD = 0.1;

/** E1 hold-bar count: number of consecutive bars after the breakthrough
 *  bar that must all close above the node strike. */
export const E1_HOLD_BARS = 3;

/** E5 lookback: how many bars back to scan for the original wick. */
export const E5_LOOKBACK_BARS = 10;

/** E5 breakdown threshold: current bar's low must be this many points
 *  below the wick low for a breakdown confirmation. */
export const E5_BREAKDOWN_PTS = 1.0;

/** Minimum bar range (high - low, in points) for a wick to qualify as
 *  a "meaningful" setup. The brainstorm v4 analysis filtered to bars
 *  with range >= p75 (~4 pts). Without this, the E5 detector fires on
 *  every tiny wick that gets broken by 1pt, producing thousands of
 *  false positives — the 2026-05-23 backfill showed n=1451 fires with
 *  mean ret_30m = -2.61 (vs backtest +8.95) before this filter was added.
 *  Applies to both E5 and PCS Monday wick filters. E1 has its own
 *  3-bar-hold structural filter and doesn't need it. */
export const MIN_WICK_RANGE_PTS = 4.0;

/** Periscope snapshot freshness — only consider snapshots within this
 *  many minutes of NOW for live fires (matches periscope's 10-min cron). */
export const PERISCOPE_MAX_AGE_MIN = 15;

// ============================================================
// TYPES
// ============================================================

export type SignalType = 'e1_long_call' | 'e5_long_put' | 'pcs_monday';

export type ConfidenceTier = 'MAXIMUM' | 'HIGH' | 'MEDIUM';

export type DowLabel =
  | 'Monday'
  | 'Tuesday'
  | 'Wednesday'
  | 'Thursday'
  | 'Friday';

export interface Bar {
  /** Bar start timestamp (TIMESTAMPTZ from index_candles_1m.timestamp). */
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface GammaNode {
  strike: number;
  /** Raw periscope gamma value. Positive = call gex / floor side;
   *  negative = put gex / ceiling side. Detector cares about
   *  positive-γ floors/ceilings only. */
  value: number;
}

export interface DayContext {
  today: string;
  dow_label: DowLabel | null;
  day_open: number;
  prior_close: number;
  open_gap_pct: number;
  prior_5d_ret: number | null;
  prior_iv_rank: number | null;
  pre_day_filter_fires: boolean;
  is_fomc_day: boolean;
  is_dom_1_5: boolean;
  is_dom_16_20: boolean;
}

export interface DetectorFire {
  fired_at: Date;
  signal_type: SignalType;
  dow_label: DowLabel;
  confidence_tier: ConfidenceTier;
  spot_at_fire: number;
  node_strike: number;
  node_gex: number;
  bar_open: number;
  bar_high: number;
  bar_low: number;
  bar_close: number;
  bar_range: number;
  es_basis_change_5m: number | null;
  prior_5d_ret: number | null;
  prior_iv_rank: number | null;
  pre_day_filter_fires: boolean;
  open_gap_pct: number | null;
  is_fomc_day: boolean;
  is_dom_1_5: boolean;
  is_dom_16_20: boolean;
}

// ============================================================
// DAY + DOW HELPERS
// ============================================================

const DOW_LABELS: ReadonlyArray<DowLabel | null> = [
  null, // 0 = Sunday
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  null, // 6 = Saturday
];

/**
 * Resolve the New York calendar DOW for a given Date. Returns null for
 * weekends so callers can short-circuit cron work on Sat/Sun.
 */
export function getDowLabel(d: Date): DowLabel | null {
  // Use ET-string to derive NY-day index then look it up. `Intl` weekday
  // names would be locale-fragile.
  const etDateStr = getETDateStr(d);
  // Construct a UTC midnight Date for that local date so .getUTCDay()
  // gives a stable weekday regardless of the runtime's local TZ.
  const parts = etDateStr.split('-');
  const year = Number(parts[0] ?? '0');
  const month = Number(parts[1] ?? '1');
  const day = Number(parts[2] ?? '1');
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  return DOW_LABELS[utcDate.getUTCDay()] ?? null;
}

/**
 * Map (DOW, pre-day filter) to the confidence tier shown on the tile.
 *
 * - MAXIMUM: Monday + pre-day filter (prior_5d<-1% AND prior_iv_rank>25)
 * - HIGH: Monday OR Friday
 * - MEDIUM: Tuesday/Wednesday/Thursday
 */
export function getConfidenceTier(
  dow: DowLabel,
  preDayFilterFires: boolean,
): ConfidenceTier {
  if (dow === 'Monday' && preDayFilterFires) return 'MAXIMUM';
  if (dow === 'Monday' || dow === 'Friday') return 'HIGH';
  return 'MEDIUM';
}

/**
 * Day-of-month from an ET-anchored date string. Pure helper for the
 * DOM 1-5 and DOM 16-20 anti-filter flags.
 */
export function getDomFromEtDateStr(etDateStr: string): number {
  const parts = etDateStr.split('-');
  return Number.parseInt(parts[2] ?? '0', 10);
}

// ============================================================
// DB LOADERS
// ============================================================

interface CandleRow {
  timestamp: string | Date;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
}

/**
 * Load the most recent N bars for SPX from index_candles_1m, RTH only.
 * Bars are returned chronologically oldest-first. SQL sorts DESC + LIMIT
 * to bound the row count, then JS rebuilds the array in ASC order by
 * walking the DESC result from the end — no in-place mutation, no
 * `.reverse()` (lint sonarjs/no-array-reverse).
 */
export async function loadRecentBars(
  sql: Sql,
  today: string,
  limit: number = 20,
): Promise<Bar[]> {
  const rows = (await withDbRetry(
    () => sql`
      SELECT timestamp, open, high, low, close
      FROM index_candles_1m
      WHERE symbol = 'SPX' AND market_time = 'r' AND date = ${today}::date
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `,
    2,
    10_000,
  )) as CandleRow[];
  const bars: Bar[] = [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i];
    if (r == null) continue;
    bars.push({
      timestamp: new Date(r.timestamp as string),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
    });
  }
  return bars;
}

interface GammaRow {
  strike: number;
  value: string | number;
}

/**
 * Load the positive-gamma strikes from the most recent periscope snapshot
 * for today's 0DTE expiry. Returns empty array if no snapshot found within
 * PERISCOPE_MAX_AGE_MIN minutes.
 */
export async function loadPositiveGammaNodes(
  sql: Sql,
  today: string,
): Promise<GammaNode[]> {
  // Latest captured_at for today's 0DTE gamma panel, within the freshness
  // window. Subquery + IN keeps it to a single round-trip.
  const rows = (await withDbRetry(
    () => sql`
      SELECT strike, value
      FROM periscope_snapshots
      WHERE panel = 'gamma'
        AND expiry = ${today}::date
        AND captured_at = (
          SELECT MAX(captured_at)
          FROM periscope_snapshots
          WHERE panel = 'gamma'
            AND expiry = ${today}::date
            AND captured_at >= NOW() - (${PERISCOPE_MAX_AGE_MIN}::int * INTERVAL '1 minute')
        )
        AND value > 0
      ORDER BY strike
    `,
    2,
    10_000,
  )) as GammaRow[];
  return rows.map((r) => ({
    strike: Number(r.strike),
    value: Number(r.value),
  }));
}

interface VolRealizedRow {
  date: string | Date;
  iv_rank: string | number | null;
}

interface DayCloseRow {
  day_close: string | number;
}

/**
 * Compute a 5-day SPX close-to-close return ending at the prior trading
 * day's close, plus look up the prior day's iv_rank. Both feed the
 * pre-day filter (prior_5d < -1% AND prior_iv_rank > 25).
 *
 * Returns nulls when history is insufficient (e.g. first 5 RTH days of a
 * fresh DB) — callers should treat null as "filter does not fire".
 */
export async function loadPreDayFilter(
  sql: Sql,
  today: string,
): Promise<{ prior_5d_ret: number | null; prior_iv_rank: number | null }> {
  // Last 6 distinct SPX RTH dates ending strictly before today. Six rows
  // gives us 5 deltas (newest minus oldest = 5-day return).
  const closeRows = (await withDbRetry(
    () => sql`
      SELECT (array_agg(close ORDER BY timestamp DESC))[1] AS day_close
      FROM index_candles_1m
      WHERE symbol = 'SPX' AND market_time = 'r' AND date < ${today}::date
      GROUP BY date
      ORDER BY date DESC
      LIMIT 6
    `,
    2,
    10_000,
  )) as DayCloseRow[];

  let prior5dRet: number | null = null;
  const newestRow = closeRows.at(0);
  const oldestRow = closeRows.at(5);
  if (newestRow != null && oldestRow != null) {
    const newest = Number(newestRow.day_close);
    const oldest = Number(oldestRow.day_close);
    if (oldest > 0) {
      prior5dRet = (newest - oldest) / oldest;
    }
  }

  const ivRows = (await withDbRetry(
    () => sql`
      SELECT date, iv_rank
      FROM vol_realized
      WHERE date < ${today}::date
      ORDER BY date DESC
      LIMIT 1
    `,
    2,
    10_000,
  )) as VolRealizedRow[];
  const ivRow = ivRows.at(0);
  const priorIvRank =
    ivRow != null && ivRow.iv_rank != null ? Number(ivRow.iv_rank) : null;

  return { prior_5d_ret: prior5dRet, prior_iv_rank: priorIvRank };
}

/**
 * Assemble the full DayContext: today's open, gap-from-yesterday, pre-day
 * filter status, DOM-based calendar anti-filter flags. FOMC-day flag is
 * NOT populated here — pass it in from the caller (cron uses a stub for
 * Phase 1, can be wired to `economic_events` later).
 */
export async function loadDayContext(
  sql: Sql,
  now: Date,
  opts: { isFomcDay?: boolean } = {},
): Promise<DayContext> {
  const today = getETDateStr(now);
  const dowLabel = getDowLabel(now);
  const dom = getDomFromEtDateStr(today);

  // Today's RTH open + yesterday's close.
  const todayOpenRows = (await withDbRetry(
    () => sql`
      SELECT (array_agg(open ORDER BY timestamp ASC))[1] AS day_open
      FROM index_candles_1m
      WHERE symbol = 'SPX' AND market_time = 'r' AND date = ${today}::date
    `,
    2,
    10_000,
  )) as { day_open: string | number | null }[];
  const dayOpen = Number(todayOpenRows[0]?.day_open ?? 0);

  const priorCloseRows = (await withDbRetry(
    () => sql`
      SELECT (array_agg(close ORDER BY timestamp DESC))[1] AS day_close
      FROM index_candles_1m
      WHERE symbol = 'SPX' AND market_time = 'r' AND date < ${today}::date
      GROUP BY date
      ORDER BY date DESC
      LIMIT 1
    `,
    2,
    10_000,
  )) as DayCloseRow[];
  const priorClose = Number(priorCloseRows[0]?.day_close ?? 0);

  const openGapPct =
    priorClose > 0 && dayOpen > 0
      ? ((dayOpen - priorClose) / priorClose) * 100
      : 0;

  const { prior_5d_ret, prior_iv_rank } = await loadPreDayFilter(sql, today);
  const preDayFilterFires =
    prior_5d_ret != null &&
    prior_iv_rank != null &&
    prior_5d_ret < PREDAY_5D_RET_THRESHOLD &&
    prior_iv_rank > PREDAY_IV_RANK_THRESHOLD;

  return {
    today,
    dow_label: dowLabel,
    day_open: dayOpen,
    prior_close: priorClose,
    open_gap_pct: openGapPct,
    prior_5d_ret,
    prior_iv_rank,
    pre_day_filter_fires: preDayFilterFires,
    is_fomc_day: opts.isFomcDay === true,
    is_dom_1_5: dom >= 1 && dom <= 5,
    is_dom_16_20: dom >= 16 && dom <= 20,
  };
}

// ============================================================
// ES BASIS (Phase 1 placeholder — returns null when unavailable)
// ============================================================

interface EsBarRow {
  close: string | number;
}

/**
 * Compute the 5-min change in ES futures relative to SPX cash.
 * Positive value = ES outperforming cash (holding bid). Returns null when
 * either ES or SPX history is missing.
 *
 * ES bars live in `futures_bars` with `symbol='ES'` (the Databento sidecar
 * ingests front-month ES into that table — there is also an `es_bars`
 * table in the schema but it's empty / deprecated). A naïve query of
 * `es_bars` was the original Phase 1 bug: the table has no `date` or
 * `interval_min` columns, the query threw, the catch swallowed it, and
 * the PCS Monday detector's basis filter was silently disabled at deploy.
 *
 * `referenceTime` is the timestamp the 6-minute window is anchored to.
 * Defaults to NOW() so the live cron is parameter-free; the historical
 * backfill script passes the bar's `ts` to get cycle-accurate basis.
 *
 * Phase 1 simple form: last-bar close minus 5-bars-ago close for each
 * series, then subtract. A more robust spread z-score is tuning, not infra.
 */
export async function computeEsBasisChange5m(
  sql: Sql,
  referenceTime: Date = new Date(),
): Promise<number | null> {
  const refIso = referenceTime.toISOString();

  const esRows = (await withDbRetry(
    () => sql`
      SELECT close
      FROM futures_bars
      WHERE symbol = 'ES'
        AND ts >= ${refIso}::timestamptz - INTERVAL '6 minutes'
        AND ts <= ${refIso}::timestamptz
      ORDER BY ts DESC
      LIMIT 6
    `,
    2,
    10_000,
  )) as EsBarRow[];
  if (esRows.length < 6) return null;

  const spxRows = (await withDbRetry(
    () => sql`
      SELECT close
      FROM index_candles_1m
      WHERE symbol = 'SPX' AND market_time = 'r'
        AND timestamp >= ${refIso}::timestamptz - INTERVAL '6 minutes'
        AND timestamp <= ${refIso}::timestamptz
      ORDER BY timestamp DESC
      LIMIT 6
    `,
    2,
    10_000,
  )) as EsBarRow[];
  if (spxRows.length < 6) return null;

  const esNow = esRows.at(0);
  const esThen = esRows.at(5);
  const spxNow = spxRows.at(0);
  const spxThen = spxRows.at(5);
  if (esNow == null || esThen == null || spxNow == null || spxThen == null) {
    return null;
  }
  const esDelta = Number(esNow.close) - Number(esThen.close);
  const spxDelta = Number(spxNow.close) - Number(spxThen.close);
  return esDelta - spxDelta;
}

// ============================================================
// TRIGGER DETECTORS
// ============================================================

/**
 * Find the highest +γ strike strictly below `price`. Returns null if no
 * positive-gamma node exists below the price.
 */
export function findNearestFloorBelow(
  nodes: ReadonlyArray<GammaNode>,
  price: number,
): GammaNode | null {
  let best: GammaNode | null = null;
  for (const n of nodes) {
    if (n.strike < price && (best == null || n.strike > best.strike)) {
      best = n;
    }
  }
  return best;
}

/**
 * Find the lowest +γ strike strictly above `price`. Returns null if no
 * positive-gamma node exists above the price.
 */
export function findNearestCeilingAbove(
  nodes: ReadonlyArray<GammaNode>,
  price: number,
): GammaNode | null {
  let best: GammaNode | null = null;
  for (const n of nodes) {
    if (n.strike > price && (best == null || n.strike < best.strike)) {
      best = n;
    }
  }
  return best;
}

/**
 * E1 long-call breakthrough detector.
 *
 * Looks for the pattern at bar T - HOLD_BARS - 1 (the breakthrough bar):
 *   - bar.open < node AND bar.high > node AND bar.close > node
 *   - For some +γ ceiling node from the latest periscope snapshot
 *   - The next HOLD_BARS bars (incl. current) all closed above node
 *
 * The "fire" timestamp is bar T's timestamp — i.e., we fire ONCE the hold
 * is confirmed, not at the original breakthrough bar.
 */
export function detectE1(
  bars: ReadonlyArray<Bar>,
  nodes: ReadonlyArray<GammaNode>,
): { breakBar: Bar; holdBar: Bar; node: GammaNode } | null {
  // Need at least HOLD_BARS + 1 bars (1 breakthrough + N hold).
  if (bars.length < E1_HOLD_BARS + 1) return null;

  // breakIdx is the index of the candidate breakthrough bar (oldest
  // possible: 0; newest possible: bars.length - HOLD_BARS - 1). The
  // length guard above proves breakIdx >= 0 and bars[breakIdx] is
  // defined, but TS's noUncheckedIndexedAccess can't see that.
  const breakIdx = bars.length - E1_HOLD_BARS - 1;
  const breakBar = bars[breakIdx];
  const holdBar = bars.at(-1);
  if (breakBar == null || holdBar == null) return null;

  // Find a +γ ceiling that was above the breakthrough bar's open and was
  // taken out by the breakthrough bar's close.
  for (const node of nodes) {
    if (
      breakBar.open < node.strike &&
      breakBar.high > node.strike &&
      breakBar.close > node.strike
    ) {
      let allHeld = true;
      for (let i = breakIdx + 1; i < bars.length; i += 1) {
        const next = bars[i];
        if (next == null || next.close <= node.strike) {
          allHeld = false;
          break;
        }
      }
      if (allHeld) {
        return { breakBar, holdBar, node };
      }
    }
  }
  return null;
}

/**
 * E5 long-put failed-reversal detector — DISABLED 2026-05-23.
 *
 * The brainstorm's E5 result (+8.95 pts mean, walk-forward stable) was
 * measured on a sample pre-filtered by FORWARD-looking ret_30m < 0:
 * only wicks whose bounce later failed got into the dataset. The
 * brainstorm script then measured forward return from the breakdown
 * bar within that already-conditioned sample.
 *
 * A real-time detector cannot apply that filter — at the moment of
 * breakdown, it does not know whether the bounce has truly failed.
 * The 2026-05-23 backfill, even after adding range + first-break
 * filters, showed mean ret_30m = -3.87 (n=179) — negative expected
 * value. At +γ floors, breakdowns of small magnitude get bought back
 * by dealers; the brainstorm's "failed bounce → breakdown
 * continuation" only manifests on a subset selected with future
 * information.
 *
 * E5 stays in the codebase (call sites + types) so a future iteration
 * can swap in a real-time approximation of the failed-bounce condition
 * (e.g., wick happened >=N minutes ago AND price has not reclaimed
 * wick.high AND a slow grind has set in). Until that lands, this
 * function returns null so the detector cron and backfill script
 * don't fire E5 alerts.
 *
 * Refs:
 * - docs/superpowers/specs/gamma-node-composite-detector-2026-05-21.md
 * - backfill validation 2026-05-23 (see commit messages around d4fa331d)
 */
/* eslint-disable @typescript-eslint/no-unused-vars -- stub: args kept for call-site stability + future reactivation */
export function detectE5(
  _bars: ReadonlyArray<Bar>,
  _nodes: ReadonlyArray<GammaNode>,
): { wickBar: Bar; breakBar: Bar; node: GammaNode } | null {
  return null;
}
/* eslint-enable @typescript-eslint/no-unused-vars */

/**
 * PCS Monday rejection detector.
 *
 * Looks for a down-wick at a SMALL +γ floor (|gex| ≤ PCS_MAX_ABS_GEX) on
 * the most recent closed bar. Filter requirements:
 *   - DOW = Monday (caller checks)
 *   - NOT a flat-gap day (|open_gap_pct| >= FLAT_GAP_PCT_THRESHOLD)
 *   - ES basis change >= PCS_ES_BASIS_MIN_CHANGE (ES holding bid) when
 *     basis data is available; pass-through when null
 *
 * Returns the detected bar + node if all gates pass.
 */
export function detectPcsMonday(
  bars: ReadonlyArray<Bar>,
  nodes: ReadonlyArray<GammaNode>,
  dayCtx: DayContext,
  esBasisChange: number | null,
): { wickBar: Bar; node: GammaNode } | null {
  if (dayCtx.dow_label !== 'Monday') return null;
  if (Math.abs(dayCtx.open_gap_pct) < FLAT_GAP_PCT_THRESHOLD) return null;
  if (esBasisChange != null && esBasisChange < PCS_ES_BASIS_MIN_CHANGE) {
    return null;
  }
  if (bars.length === 0) return null;
  const wickBar = bars.at(-1);
  if (wickBar == null) return null;

  // Range filter — drop noise wicks (matches the v4 brainstorm
  // event-set, which only considered bars with range >= p75 ~ 4pt).
  if (wickBar.high - wickBar.low < MIN_WICK_RANGE_PTS) return null;

  for (const node of nodes) {
    if (Math.abs(node.value) > PCS_MAX_ABS_GEX) continue;
    const isWick =
      wickBar.open > node.strike &&
      wickBar.low < node.strike &&
      wickBar.close > node.strike;
    if (isWick) return { wickBar, node };
  }
  return null;
}

// ============================================================
// PERSISTENCE
// ============================================================

/**
 * Insert a detected fire into ws_gamma_setup_fires. UNIQUE
 * (fired_at, signal_type, node_strike) makes this idempotent — re-running
 * the cron on the same minute on the same setup is a no-op.
 *
 * Returns true when a row was actually inserted, false when the ON
 * CONFLICT clause skipped it (so the caller can count new fires).
 */
export async function insertFire(
  sql: Sql,
  fire: DetectorFire,
): Promise<boolean> {
  const rows = (await withDbRetry(
    () => sql`
      INSERT INTO ws_gamma_setup_fires (
        fired_at, signal_type, dow_label, confidence_tier,
        spot_at_fire, node_strike, node_gex,
        bar_open, bar_high, bar_low, bar_close, bar_range,
        es_basis_change_5m, prior_5d_ret, prior_iv_rank,
        pre_day_filter_fires, open_gap_pct,
        is_fomc_day, is_dom_1_5, is_dom_16_20
      ) VALUES (
        ${fire.fired_at.toISOString()}::timestamptz,
        ${fire.signal_type},
        ${fire.dow_label},
        ${fire.confidence_tier},
        ${fire.spot_at_fire},
        ${fire.node_strike},
        ${fire.node_gex},
        ${fire.bar_open}, ${fire.bar_high}, ${fire.bar_low},
        ${fire.bar_close}, ${fire.bar_range},
        ${fire.es_basis_change_5m},
        ${fire.prior_5d_ret},
        ${fire.prior_iv_rank},
        ${fire.pre_day_filter_fires},
        ${fire.open_gap_pct},
        ${fire.is_fomc_day},
        ${fire.is_dom_1_5},
        ${fire.is_dom_16_20}
      )
      ON CONFLICT (fired_at, signal_type, node_strike) DO NOTHING
      RETURNING id
    `,
    2,
    10_000,
  )) as { id: number }[];
  return rows.length > 0;
}
