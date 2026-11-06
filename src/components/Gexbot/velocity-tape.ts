/**
 * Ordering, highlight and ranking rules for the velocity view.
 *
 * Owner decision (2026-10-29): rows stay in the fixed GEXBOT_UNDERLYING_ORDER
 * so a ticker is always in the same place, and a row is highlighted when its
 * last-minute taker delta flow (Δ agg_dex) is unusually large for that
 * ticker. Nothing is re-sorted by size: dollar sizes are not comparable
 * across tickers, and the three columns have different units.
 *
 * The strip's LOUDEST tile (owner decision 2026-11-05) ranks the same way:
 * by |Δ agg_dex| as a multiple of the ticker's own typical minute, so the
 * tile and the tape use one definition of "typical" and cannot disagree on
 * which row stands out.
 */

import type { VelocityRow } from '../../hooks/useGexbotData';
import { GEXBOT_UNDERLYING_ORDER } from './ticker-order';

/**
 * A minute counts as unusual at this multiple of the ticker's typical one.
 * Owner decision (2026-10-29), from a tune check on the 2026-10-28 and
 * 2026-10-29 sessions: 2x with a 0.05 floor lit SPX, SPY and QQQ in about 20%
 * of minutes (about 2.4 of the 14 rows each minute), which is too much to
 * read as unusual. 3x with a 0.25 floor lights the liquid names in about 9%
 * of minutes, the thin ones (HYG, VIX, UVXY) in about 0-0.5%, and about one
 * row per minute. This rests on only two sessions; re-tune on more history.
 */
export const UNUSUAL_MULTIPLE = 3;

/**
 * Floor on the "typical" minute change used for the highlight. agg_dex is
 * rounded to 0.01, so the illiquid tickers (HYG, VIX, UVXY) have a median
 * |Δ| of exactly 0; without a floor a single 0.01 tick would be "infinitely
 * unusual" and flag them all day. At 0.25 the threshold is 0.75.
 */
export const TYPICAL_FLOOR = 0.25;

/** Slack for floating-point products such as 3 * 0.4 = 1.2000000000000002. */
export const EPSILON = 1e-9;

/** The row's Δ agg_dex, or null when it is missing or not a number. */
function validChange(row: VelocityRow): number | null {
  const { dAggDex } = row;
  return dAggDex == null || Number.isNaN(dAggDex) ? null : dAggDex;
}

/** The ticker's typical minute for comparison: its session median, floored. */
function typicalMinute(row: VelocityRow): number {
  return Math.max(row.typicalAbsDAggDex ?? 0, TYPICAL_FLOOR);
}

/**
 * True when the floor, not the ticker's own median, is the denominator of
 * `unusualRatio` (a median under the floor, or none). The ratio is then a
 * multiple of the floor and must not be called a multiple of "typical".
 */
export function usesTypicalFloor(row: VelocityRow): boolean {
  return (row.typicalAbsDAggDex ?? 0) < TYPICAL_FLOOR;
}

/** True when |Δ agg_dex| ≥ 3 × max(typical |Δ|, floor). A null Δ never is. */
export function isUnusual(row: VelocityRow): boolean {
  const change = validChange(row);
  if (change === null) return false;
  return Math.abs(change) + EPSILON >= UNUSUAL_MULTIPLE * typicalMinute(row);
}

/**
 * |Δ agg_dex| as a multiple of max(typical |Δ|, floor): 3 or more is
 * "unusual" (see `isUnusual`). Null when the row has no valid change.
 */
export function unusualRatio(row: VelocityRow): number | null {
  const change = validChange(row);
  return change === null ? null : Math.abs(change) / typicalMinute(row);
}

/**
 * The 14 underlyings in GEXBOT_UNDERLYING_ORDER. Anything else (the futures
 * views, an unknown ticker) is dropped; an underlying with no row is simply
 * absent rather than shown empty.
 */
export function orderVelocityRows(rows: readonly VelocityRow[]): VelocityRow[] {
  const byTicker = new Map(rows.map((r) => [r.ticker, r]));
  return GEXBOT_UNDERLYING_ORDER.flatMap((t) => {
    const row = byTicker.get(t);
    return row ? [row] : [];
  });
}

/**
 * The underlying whose last-minute taker Δ flow is the biggest multiple of
 * its own typical minute, with that multiple. Futures views and unknown
 * tickers are skipped, as are rows with no valid change and rows whose
 * change is exactly 0. A tie goes to the earlier ticker in
 * GEXBOT_UNDERLYING_ORDER. Null when no row qualifies (for example in the
 * first minute of the session, when every change is null). The pick need not
 * be unusual: when nothing reaches the multiple it is still the top ratio, and
 * the caller asks `isUnusual(pick.row)` whether to call it that.
 */
export function pickMostUnusual(
  rows: readonly VelocityRow[],
): { row: VelocityRow; ratio: number } | null {
  let best: { row: VelocityRow; ratio: number } | null = null;
  for (const row of orderVelocityRows(rows)) {
    const ratio = unusualRatio(row);
    if (ratio !== null && ratio > (best?.ratio ?? 0)) best = { row, ratio };
  }
  return best;
}

/** A taker-Δ value for display: sign, 2 decimals, K and M suffixes. */
export function formatTakerDelta(value: number | null): string {
  if (value == null) return '—';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  const sign = value >= 0 ? '+' : '−';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(2)}K`;
  return `${sign}${abs.toFixed(2)}`;
}
