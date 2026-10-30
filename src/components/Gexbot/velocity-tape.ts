/**
 * Ordering and highlight rules for the velocity tape.
 *
 * Owner decision (2026-10-29): rows stay in the fixed GEXBOT_UNDERLYING_ORDER
 * so a ticker is always in the same place, and a row is highlighted when its
 * last-minute taker delta flow (Δ agg_dex) is unusually large for that
 * ticker. Nothing is re-sorted by size: dollar sizes are not comparable
 * across tickers, and the three columns have different units.
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
const UNUSUAL_MULTIPLE = 3;

/**
 * Floor on the "typical" minute change used for the highlight. agg_dex is
 * rounded to 0.01, so the illiquid tickers (HYG, VIX, UVXY) have a median
 * |Δ| of exactly 0; without a floor a single 0.01 tick would be "infinitely
 * unusual" and flag them all day. At 0.25 the threshold is 0.75.
 */
const TYPICAL_FLOOR = 0.25;

/** Slack for floating-point products such as 3 * 0.4 = 1.2000000000000002. */
const EPSILON = 1e-9;

/** True when |Δ agg_dex| ≥ 3 × max(typical |Δ|, floor). A null Δ never is. */
export function isUnusual(row: VelocityRow): boolean {
  const { dAggDex, typicalAbsDAggDex } = row;
  if (dAggDex == null || Number.isNaN(dAggDex)) return false;
  const typical = Math.max(typicalAbsDAggDex ?? 0, TYPICAL_FLOOR);
  return Math.abs(dAggDex) + EPSILON >= UNUSUAL_MULTIPLE * typical;
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
