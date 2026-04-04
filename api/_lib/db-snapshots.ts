/**
 * Snapshot-related database operations.
 *
 * Handles saving and querying market_snapshots, plus VIX OHLC derivation.
 */

import { getDb } from './db.js';

// ============================================================
// TYPES
// ============================================================

type Maybe<T> = T | null | undefined;

export interface SnapshotInput {
  date: string;
  entryTime: string;

  // Prices
  spx?: Maybe<number>;
  spy?: Maybe<number>;
  spxOpen?: Maybe<number>;
  spxHigh?: Maybe<number>;
  spxLow?: Maybe<number>;
  prevClose?: Maybe<number>;

  // Volatility
  vix?: Maybe<number>;
  vix1d?: Maybe<number>;
  vix9d?: Maybe<number>;
  vvix?: Maybe<number>;

  // Calculator
  sigma?: Maybe<number>;
  sigmaSource?: Maybe<string>;
  tYears?: Maybe<number>;
  hoursRemaining?: Maybe<number>;
  skewPct?: Maybe<number>;

  // Regime
  regimeZone?: Maybe<string>;
  clusterMult?: Maybe<number>;
  dowMultHL?: Maybe<number>;
  dowMultOC?: Maybe<number>;
  dowLabel?: Maybe<string>;

  // Delta guide
  icCeiling?: Maybe<number>;
  putSpreadCeiling?: Maybe<number>;
  callSpreadCeiling?: Maybe<number>;
  moderateDelta?: Maybe<number>;
  conservativeDelta?: Maybe<number>;

  // Range thresholds
  medianOcPct?: Maybe<number>;
  medianHlPct?: Maybe<number>;
  p90OcPct?: Maybe<number>;
  p90HlPct?: Maybe<number>;
  p90OcPts?: Maybe<number>;
  p90HlPts?: Maybe<number>;

  // Opening range
  openingRangeAvailable?: Maybe<boolean>;
  openingRangeHigh?: Maybe<number>;
  openingRangeLow?: Maybe<number>;
  openingRangePctConsumed?: Maybe<number>;
  openingRangeSignal?: Maybe<string>;

  // Term structure
  vixTermSignal?: Maybe<string>;

  // Overnight
  overnightGap?: Maybe<number>;

  // Strikes
  strikes?: Maybe<Record<string, unknown>>;

  // Events
  isEarlyClose?: Maybe<boolean>;
  isEventDay?: Maybe<boolean>;
  eventNames?: Maybe<string[]>;

  isBacktest?: Maybe<boolean>;
}

// ============================================================
// MARKET SNAPSHOT
// ============================================================

/**
 * Save a market snapshot. Uses ON CONFLICT DO UPDATE so re-saves at the
 * same date+time overwrite with the latest calculator state.
 * Returns the snapshot ID (new or updated).
 */
export async function saveSnapshot(
  input: SnapshotInput,
): Promise<number | null> {
  const sql = getDb();

  const vix1dVixRatio =
    input.vix1d && input.vix && input.vix > 0 ? input.vix1d / input.vix : null;
  const vixVix9dRatio =
    input.vix && input.vix9d && input.vix9d > 0
      ? input.vix / input.vix9d
      : null;

  const result = await sql`
    INSERT INTO market_snapshots (
      date, entry_time,
      spx, spy, spx_open, spx_high, spx_low, prev_close,
      vix, vix1d, vix9d, vvix, vix1d_vix_ratio, vix_vix9d_ratio,
      sigma, sigma_source, t_years, hours_remaining, skew_pct,
      regime_zone, cluster_mult, dow_mult_hl, dow_mult_oc, dow_label,
      ic_ceiling, put_spread_ceiling, call_spread_ceiling, moderate_delta, conservative_delta,
      median_oc_pct, median_hl_pct, p90_oc_pct, p90_hl_pct, p90_oc_pts, p90_hl_pts,
      opening_range_available, opening_range_high, opening_range_low,
      opening_range_pct_consumed, opening_range_signal,
      vix_term_signal, overnight_gap,
      strikes,
      is_early_close, is_event_day, event_names,
      is_backtest
    ) VALUES (
      ${input.date}, ${input.entryTime},
      ${input.spx ?? null}, ${input.spy ?? null},
      ${input.spxOpen ?? null}, ${input.spxHigh ?? null},
      ${input.spxLow ?? null}, ${input.prevClose ?? null},
      ${input.vix ?? null}, ${input.vix1d ?? null},
      ${input.vix9d ?? null}, ${input.vvix ?? null},
      ${vix1dVixRatio}, ${vixVix9dRatio},
      ${input.sigma ?? null}, ${input.sigmaSource ?? null},
      ${input.tYears ?? null}, ${input.hoursRemaining ?? null},
      ${input.skewPct ?? null},
      ${input.regimeZone ?? null}, ${input.clusterMult ?? null},
      ${input.dowMultHL ?? null}, ${input.dowMultOC ?? null},
      ${input.dowLabel ?? null},
      ${input.icCeiling ?? null}, ${input.putSpreadCeiling ?? null},
      ${input.callSpreadCeiling ?? null}, ${input.moderateDelta ?? null},
      ${input.conservativeDelta ?? null},
      ${input.medianOcPct ?? null}, ${input.medianHlPct ?? null},
      ${input.p90OcPct ?? null}, ${input.p90HlPct ?? null},
      ${input.p90OcPts ?? null}, ${input.p90HlPts ?? null},
      ${input.openingRangeAvailable ?? null},
      ${input.openingRangeHigh ?? null}, ${input.openingRangeLow ?? null},
      ${input.openingRangePctConsumed ?? null}, ${input.openingRangeSignal ?? null},
      ${input.vixTermSignal ?? null}, ${input.overnightGap ?? null},
      ${input.strikes ? JSON.stringify(input.strikes) : null},
      ${input.isEarlyClose ?? false}, ${input.isEventDay ?? false},
      ${input.eventNames ?? null},
      ${input.isBacktest ?? false}
    )
    ON CONFLICT (date, entry_time) DO UPDATE SET
      spx = EXCLUDED.spx,
      spy = EXCLUDED.spy,
      spx_open = EXCLUDED.spx_open,
      spx_high = EXCLUDED.spx_high,
      spx_low = EXCLUDED.spx_low,
      prev_close = EXCLUDED.prev_close,
      vix = EXCLUDED.vix,
      vix1d = EXCLUDED.vix1d,
      vix9d = EXCLUDED.vix9d,
      vvix = EXCLUDED.vvix,
      vix1d_vix_ratio = EXCLUDED.vix1d_vix_ratio,
      vix_vix9d_ratio = EXCLUDED.vix_vix9d_ratio,
      sigma = EXCLUDED.sigma,
      sigma_source = EXCLUDED.sigma_source,
      t_years = EXCLUDED.t_years,
      hours_remaining = EXCLUDED.hours_remaining,
      skew_pct = EXCLUDED.skew_pct,
      regime_zone = EXCLUDED.regime_zone,
      cluster_mult = EXCLUDED.cluster_mult,
      dow_mult_hl = EXCLUDED.dow_mult_hl,
      dow_mult_oc = EXCLUDED.dow_mult_oc,
      dow_label = EXCLUDED.dow_label,
      ic_ceiling = EXCLUDED.ic_ceiling,
      put_spread_ceiling = EXCLUDED.put_spread_ceiling,
      call_spread_ceiling = EXCLUDED.call_spread_ceiling,
      moderate_delta = EXCLUDED.moderate_delta,
      conservative_delta = EXCLUDED.conservative_delta,
      median_oc_pct = EXCLUDED.median_oc_pct,
      median_hl_pct = EXCLUDED.median_hl_pct,
      p90_oc_pct = EXCLUDED.p90_oc_pct,
      p90_hl_pct = EXCLUDED.p90_hl_pct,
      p90_oc_pts = EXCLUDED.p90_oc_pts,
      p90_hl_pts = EXCLUDED.p90_hl_pts,
      opening_range_available = EXCLUDED.opening_range_available,
      opening_range_high = EXCLUDED.opening_range_high,
      opening_range_low = EXCLUDED.opening_range_low,
      opening_range_pct_consumed = EXCLUDED.opening_range_pct_consumed,
      opening_range_signal = EXCLUDED.opening_range_signal,
      vix_term_signal = EXCLUDED.vix_term_signal,
      overnight_gap = EXCLUDED.overnight_gap,
      strikes = EXCLUDED.strikes,
      is_early_close = EXCLUDED.is_early_close,
      is_event_day = EXCLUDED.is_event_day,
      event_names = EXCLUDED.event_names,
      is_backtest = EXCLUDED.is_backtest
    RETURNING id
  `;

  return result.length > 0 ? ((result[0]?.id as number) ?? null) : null;
}

// ============================================================
// VIX OHLC FROM SNAPSHOTS
// ============================================================

/**
 * Parse an entry_time string like "9:35 AM" or "3:00 PM" to minutes
 * since midnight for chronological sorting.
 */
function parseEntryTimeMinutes(t: string): number {
  const timePattern = /^(\d+):(\d+)\s*(AM|PM)$/i;
  const m = timePattern.exec(t);
  if (!m) return Number.NaN;
  let h = Number.parseInt(m[1]!, 10);
  const min = Number.parseInt(m[2]!, 10);
  if (h < 1 || h > 12 || min < 0 || min > 59) return Number.NaN;
  const isPm = m[3]!.toUpperCase() === 'PM';
  if (isPm && h !== 12) h += 12;
  else if (!isPm && h === 12) h = 0;
  return h * 60 + min;
}

/**
 * Derive VIX OHLC for a given date from recorded market_snapshots.
 * open  = VIX at the earliest snapshot
 * close = VIX at the latest snapshot
 * high  = MAX(vix) across all snapshots
 * low   = MIN(vix) across all snapshots
 * Returns null if no snapshots exist for the date.
 */
export async function getVixOhlcFromSnapshots(date: string): Promise<{
  open: number;
  high: number;
  low: number;
  close: number;
  count: number;
} | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT entry_time, vix::text AS vix
    FROM market_snapshots
    WHERE date = ${date} AND vix IS NOT NULL
  `;

  if (rows.length === 0) return null;

  const sorted = rows
    .map((r) => ({
      t: parseEntryTimeMinutes((r as { entry_time: string }).entry_time),
      vix: Number((r as { vix: string }).vix),
    }))
    .filter((r) => !Number.isNaN(r.t) && !Number.isNaN(r.vix))
    .sort((a, b) => a.t - b.t);

  if (sorted.length === 0) return null;

  const viixes = sorted.map((r) => r.vix);
  return {
    open: sorted[0]!.vix,
    close: sorted.at(-1)!.vix,
    high: Math.max(...viixes),
    low: Math.min(...viixes),
    count: sorted.length,
  };
}
