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

/** A minute counts as unusual at this multiple of the ticker's typical one. */
export const UNUSUAL_MULTIPLE = 2;

/**
 * Floor on the "typical" minute change used for the highlight. agg_dex is
 * rounded to 0.01, so the illiquid tickers (HYG, VIX, UVXY) have a median
 * |Δ| of exactly 0; without a floor a single 0.01 tick would be "infinitely
 * unusual" and flag them all day. At 0.05 the threshold is 0.10, ten ticks.
 */
export const TYPICAL_FLOOR = 0.05;

/** True when |Δ agg_dex| ≥ 2 × max(typical |Δ|, floor). A null Δ never is. */
export function isUnusual(row: VelocityRow): boolean {
  const { dAggDex, typicalAbsDAggDex } = row;
  if (dAggDex == null || Number.isNaN(dAggDex)) return false;
  const typical = Math.max(typicalAbsDAggDex ?? 0, TYPICAL_FLOOR);
  return Math.abs(dAggDex) >= UNUSUAL_MULTIPLE * typical;
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
