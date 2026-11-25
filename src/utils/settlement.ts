import type { HistoryCandle } from '../types/api.js';
import type { SettlementResult } from '../types/settlement.js';
import { round2 } from './formatting.js';

/**
 * Compute whether an iron condor would have survived from entry to settlement.
 *
 * Entry convention: `entryIndex` is the last bar that had ended by the entry
 * slot, as `historySnapshotAt` / `spxSlotStateAsOf` report it as `candleIndex`
 * / `entryIndex` ("a row at slot T uses only bars that end at or before T").
 * The entry price is that bar's **close**. The entry bar's high and low
 * therefore represent price action *before* the entry price was established
 * and MUST NOT count as post-entry breaches. The breach scan starts at
 * `entryIndex + 1` for this reason.
 *
 * This keeps the semantic consistent with the running OHLC at entry, which
 * covers the bars ended by the slot, the entry bar included. If we included
 * the entry bar here too, the same bar would be counted on both sides of the
 * entry line.
 *
 * `entryIndex` is -1 at the open (8:30 CT), where no bar has ended. The entry
 * price is then the first bar's open, nothing before it is a pre-entry bar,
 * and the scan starts at bar 0: the whole session is post-entry.
 *
 * Pure function — no React dependencies — suitable for unit testing.
 *
 * @param allCandles Full day's 5-min candles in chronological order.
 * @param entryIndex Index of the last bar ended by the entry slot, whose close
 *                   is the entry price; -1 when no bar has ended (the entry is
 *                   the first bar's open). Must be strictly less than
 *                   `allCandles.length - 1` (there needs to be at least one
 *                   candle after entry).
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
