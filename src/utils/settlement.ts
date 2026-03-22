import type { HistoryCandle } from '../types/api';
import type { SettlementResult } from '../components/SettlementCheck/types';

/**
 * Compute whether an iron condor would have survived from entry to settlement.
 * Pure function — no React dependencies — suitable for unit testing.
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

  for (let i = entryIndex; i < allCandles.length; i++) {
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
    callCushion: Math.round(callCushion * 100) / 100,
    putCushion: Math.round(putCushion * 100) / 100,
    settlement: Math.round(settlement * 100) / 100,
    remainingHigh: Math.round(remainingHigh * 100) / 100,
    remainingLow: Math.round(remainingLow * 100) / 100,
    settledSafe,
  };
}
