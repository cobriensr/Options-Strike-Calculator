/**
 * Ranking for the velocity tape.
 *
 * Rows are ordered by how unusual each ticker's last-minute taker delta flow
 * (Δ agg_dex) is against that ticker's own typical minute: |Δ| divided by
 * the median |Δ| the server computed over the ET session. Dollar sizes are
 * not comparable across tickers (SPX moves orders of magnitude more than
 * HYG), and the three columns have different units, so neither a raw sum nor
 * a raw sort is used.
 */

import type { VelocityRow } from '../../hooks/useGexbotData';

/**
 * How many times its own typical minute this ticker just moved.
 * - no change available (first minute, gap, stale repeat): `null`, sorts last;
 * - zero change: 0;
 * - nonzero change against a zero or unknown norm: `Infinity` (any move is
 *   unusual when the ticker has never moved, or has no history yet).
 */
export function velocityScore(row: VelocityRow): number | null {
  const { dAggDex, typicalAbsDAggDex } = row;
  if (dAggDex == null || Number.isNaN(dAggDex)) return null;
  const move = Math.abs(dAggDex);
  if (move === 0) return 0;
  if (typicalAbsDAggDex == null || typicalAbsDAggDex <= 0) return Infinity;
  return move / typicalAbsDAggDex;
}

export function sortVelocityRows(rows: readonly VelocityRow[]): VelocityRow[] {
  return rows
    .map((row) => ({ row, score: velocityScore(row) }))
    .sort((a, b) => {
      if (a.score !== b.score) {
        if (a.score === null) return 1;
        if (b.score === null) return -1;
        // Infinity - Infinity is NaN, so compare instead of subtracting.
        return a.score > b.score ? -1 : 1;
      }
      // Stable tiebreaker so render order is deterministic.
      return a.row.ticker.localeCompare(b.row.ticker);
    })
    .map(({ row }) => row);
}
