/**
 * SettlementCheck — Shows whether an iron condor would have survived
 * from entry time to settlement, using actual historical SPX candles.
 *
 * Only renders in backtest mode (when historySnapshot is available).
 *
 * Takes the calculator's recommended strikes and checks the actual
 * SPX high/low from entry through close.
 */

import { useMemo } from 'react';
import type { Theme } from '../themes';
import type { HistoryCandle } from '../types/api';
import type { HistorySnapshot } from '../hooks/useHistoryData';

interface Props {
  readonly th: Theme;
  readonly snapshot: HistorySnapshot;
  readonly allCandles: readonly HistoryCandle[];
  /** allDeltas from CalculationResults — may include error entries */
  readonly allDeltas: ReadonlyArray<
    { delta: number; callStrike: number; putStrike: number } | { error: string }
  >;
}

interface SettlementResult {
  delta: number;
  callStrike: number;
  putStrike: number;
  survived: boolean;
  callBreached: boolean;
  putBreached: boolean;
  /** How close SPX got to the call strike (negative = breached) */
  callCushion: number;
  /** How close SPX got to the put strike (negative = breached) */
  putCushion: number;
  /** SPX settlement price (last candle close) */
  settlement: number;
  /** Max SPX after entry */
  remainingHigh: number;
  /** Min SPX after entry */
  remainingLow: number;
}

function computeSettlement(
  allCandles: readonly HistoryCandle[],
  entryIndex: number,
  callStrike: number,
  putStrike: number,
  delta: number,
): SettlementResult | null {
  if (entryIndex >= allCandles.length - 1) return null;

  // Compute remaining-day high/low from entry candle through settlement
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
  };
}

// Test the key deltas: 5, 8, 10, 12, 15 (typical IC strike choices)
const targetDeltas = [5, 8, 10, 12, 15];

export default function SettlementCheck({
  th,
  snapshot,
  allCandles,
  allDeltas,
}: Props) {
  const results = useMemo(() => {
    const validDeltas = allDeltas.filter(
      (d): d is { delta: number; callStrike: number; putStrike: number } =>
        !('error' in d),
    );
    const out: SettlementResult[] = [];
    for (const target of targetDeltas) {
      const entry = validDeltas.find((d) => d.delta === target);
      if (!entry) continue;

      const r = computeSettlement(
        allCandles,
        snapshot.candleIndex,
        entry.callStrike,
        entry.putStrike,
        target,
      );
      if (r) out.push(r);
    }
    return out;
  }, [allCandles, allDeltas, snapshot]);

  if (results.length === 0) return null;

  const settlement = results[0]!.settlement;
  const remainingHigh = results[0]!.remainingHigh;
  const remainingLow = results[0]!.remainingLow;
  const entryPrice = snapshot.spot;

  const survived = results.filter((r) => r.survived).length;
  const total = results.length;

  return (
    <div>
      <div className="text-accent mb-2.5 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
        Settlement Check
      </div>

      {/* Summary bar */}
      <div
        className="mb-3 rounded-[10px] p-3"
        style={{
          backgroundColor:
            survived === total
              ? th.green + '12'
              : survived >= total / 2
                ? '#E8A31712'
                : th.red + '12',
          border: `1px solid ${survived === total ? th.green + '30' : survived >= total / 2 ? '#E8A31730' : th.red + '30'}`,
        }}
      >
        <div className="flex items-center justify-between">
          <div>
            <span
              className="font-sans text-[11px] font-bold"
              style={{
                color:
                  survived === total
                    ? th.green
                    : survived >= total / 2
                      ? '#E8A317'
                      : th.red,
              }}
            >
              {survived}/{total} SURVIVED
            </span>
            <span className="text-secondary ml-2 font-sans text-[11px]">
              Entry {snapshot.candle.time} @ {entryPrice.toFixed(0)} →
              Settlement {settlement.toFixed(0)}
            </span>
          </div>
          <span className="text-muted font-mono text-[10px]">
            H {remainingHigh.toFixed(0)} / L {remainingLow.toFixed(0)}
          </span>
        </div>
      </div>

      {/* Delta rows */}
      <div className="grid gap-1.5">
        {results.map((r) => {
          const width = r.callStrike - r.putStrike;
          const rangeUsed = remainingHigh - remainingLow;

          return (
            <div
              key={r.delta}
              className="bg-surface border-edge flex items-center gap-3 rounded-lg border p-2.5"
            >
              {/* Delta label */}
              <div className="w-[36px] shrink-0 text-center">
                <span
                  className="font-mono text-[13px] font-bold"
                  style={{
                    color: r.survived ? th.green : th.red,
                  }}
                >
                  {r.delta}\u0394
                </span>
              </div>

              {/* Strike range visualization */}
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex justify-between font-mono text-[9px]">
                  <span className="text-muted">{r.putStrike.toFixed(0)}P</span>
                  <span className="text-muted">{r.callStrike.toFixed(0)}C</span>
                </div>
                <div
                  className="relative h-2 w-full overflow-hidden rounded-full"
                  style={{ backgroundColor: th.surfaceAlt }}
                >
                  {/* Actual price range bar */}
                  <div
                    className="absolute top-0 h-full rounded-full"
                    style={{
                      left: `${100 - Math.min(100, ((r.callStrike - remainingHigh) / width) * 100 + ((remainingHigh - remainingLow) / width) * 100)}%`,
                      width: `${Math.min(100, (rangeUsed / width) * 100)}%`,
                      backgroundColor: r.survived
                        ? th.green + '60'
                        : th.red + '60',
                    }}
                  />
                </div>
              </div>

              {/* Result */}
              <div className="w-[72px] shrink-0 text-right">
                {r.survived ? (
                  <span
                    className="font-sans text-[10px] font-bold"
                    style={{ color: th.green }}
                  >
                    +{Math.min(r.callCushion, r.putCushion).toFixed(0)} pts
                  </span>
                ) : (
                  <span
                    className="font-sans text-[10px] font-bold"
                    style={{ color: th.red }}
                  >
                    {r.callBreached
                      ? `C \u2212${Math.abs(r.callCushion).toFixed(0)}`
                      : `P \u2212${Math.abs(r.putCushion).toFixed(0)}`}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footnote */}
      <div className="text-muted mt-2 font-sans text-[10px] leading-relaxed">
        Compares recommended short strikes at entry to the actual SPX high/low
        from {snapshot.candle.time} through settlement. Cushion shows the
        nearest approach. Negative means breached.
      </div>
    </div>
  );
}
