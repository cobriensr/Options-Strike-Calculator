import type { HistoryCandle } from '../types/api.js';
import type { SettlementResult } from '../components/SettlementCheck/types.js';
import { round2 } from './formatting.js';

/**
 * Compute whether an iron condor would have survived from entry to settlement.
 *
 * Entry convention: `entryIndex` is the candle whose **close** is used as the
 * entry price (matching `useHistoryData.getStateAtTime` which sets
 * `spot = candle.close` at the matching candle's close). The entry candle's
 * high and low therefore represent price action *before* the entry price was
 * established and MUST NOT count as post-entry breaches. The breach scan
 * starts at `entryIndex + 1` for this reason.
 *
 * This keeps the semantic consistent with `useHistoryData.computeRunningOHLC`,
 * which already includes the entry candle in the *pre-entry* running OHLC
 * (loop runs `i = 0; i <= endIdx`). If we included the entry candle here too,
 * the same bar would be counted on both sides of the entry line.
 *
 * Pure function — no React dependencies — suitable for unit testing.
 *
 * @param allCandles Full day's 5-min candles in chronological order.
 * @param entryIndex Index of the candle at whose close we are committing.
 *                   Must be strictly less than `allCandles.length - 1`
 *                   (there needs to be at least one candle after entry).
 * @param callStrike Short call strike (a breach is `high >= callStrike`).
 * @param putStrike  Short put strike (a breach is `low <= putStrike`).
 * @param delta      Row delta, passed through unchanged.
 * @returns null if there is no candle strictly after `entryIndex`; otherwise
 *          a SettlementResult with survive/breach/cushion/settlement fields.
 */
export function computeSettlement(
  allCandles: readonly HistoryCandle[],
  entryIndex: number,
  callStrike: number,
  putStrike: number,
  delta: number,
): SettlementResult | null {
  if (entryIndex >= allCandles.length - 1) return null;

  let remainingHigh = -Infinity;
  let remainingLow = Infinity;

  // Start at entryIndex + 1 — see the "Entry convention" note above.
  for (let i = entryIndex + 1; i < allCandles.length; i++) {
    const c = allCandles[i]!;
    if (c.high > remainingHigh) remainingHigh = c.high;
    if (c.low < remainingLow) remainingLow = c.low;
  }

  const settlement = allCandles.at(-1)!.close;
  const callCushion = callStrike - remainingHigh;
  const putCushion = remainingLow - putStrike;
  const callBreached = remainingHigh >= callStrike;
  const putBreached = remainingLow <= putStrike;
  const settledSafe = settlement > putStrike && settlement < callStrike;

  return {
    delta,
    callStrike,
    putStrike,
    survived: !callBreached && !putBreached,
    callBreached,
    putBreached,
    callCushion: round2(callCushion),
    putCushion: round2(putCushion),
    settlement: round2(settlement),
    remainingHigh: round2(remainingHigh),
    remainingLow: round2(remainingLow),
    settledSafe,
  };
}
