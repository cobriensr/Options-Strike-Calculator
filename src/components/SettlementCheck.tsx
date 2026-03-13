/**
 * SettlementCheck — Shows whether an iron condor would have survived
 * from entry time to settlement, using actual historical SPX candles.
 *
 * Only renders in backtest mode (when historySnapshot is available).
 */

import { useMemo } from 'react';
import type { Theme } from '../themes';
import type { HistoryCandle } from '../types/api';
import type { HistorySnapshot } from '../hooks/useHistoryData';

interface Props {
  readonly th: Theme;
  readonly snapshot: HistorySnapshot;
  readonly allCandles: readonly HistoryCandle[];
  readonly allDeltas: ReadonlyArray<
    { delta: number; callStrike: number; putStrike: number } | { error: string }
  >;
  readonly entryTimeLabel?: string;
}

interface SettlementResult {
  delta: number;
  callStrike: number;
  putStrike: number;
  survived: boolean;
  callBreached: boolean;
  putBreached: boolean;
  callCushion: number;
  putCushion: number;
  settlement: number;
  remainingHigh: number;
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

const targetDeltas = [5, 8, 10, 12, 15];

export default function SettlementCheck({
  th,
  snapshot,
  allCandles,
  allDeltas,
  entryTimeLabel,
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
  const actualRange = remainingHigh - remainingLow;
  const settleMove = settlement - entryPrice;

  const survived = results.filter((r) => r.survived).length;
  const total = results.length;
  const displayTime = entryTimeLabel ?? snapshot.candle.time;

  return (
    <div>
      <div className="text-accent mb-2.5 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
        Settlement Check
      </div>

      {/* Summary card */}
      <div
        className="mb-3 rounded-[10px] p-3.5"
        style={{
          backgroundColor:
            survived === total
              ? th.green + '0C'
              : survived >= total / 2
                ? '#E8A3170C'
                : th.red + '0C',
          border: `1px solid ${survived === total ? th.green + '25' : survived >= total / 2 ? '#E8A31725' : th.red + '25'}`,
        }}
      >
        {/* Top line: verdict */}
        <div className="mb-2 flex items-center gap-2">
          <span
            className="font-sans text-[13px] font-bold"
            style={{
              color:
                survived === total
                  ? th.green
                  : survived >= total / 2
                    ? '#E8A317'
                    : th.red,
            }}
          >
            {survived === total
              ? '\u2705 All Survived'
              : survived === 0
                ? '\u274C All Breached'
                : `\u26A0\uFE0F ${survived}/${total} Survived`}
          </span>
        </div>

        {/* Context line */}
        <div className="text-secondary font-sans text-[11px] leading-relaxed">
          Entry at {displayTime} with SPX at {entryPrice.toFixed(0)}. SPX ranged{' '}
          {actualRange.toFixed(0)} pts ({remainingLow.toFixed(0)} \u2013{' '}
          {remainingHigh.toFixed(0)}) and settled at {settlement.toFixed(0)} (
          {settleMove >= 0 ? '+' : ''}
          {settleMove.toFixed(0)} from entry).
        </div>
      </div>

      {/* Delta rows */}
      <div className="grid gap-2">
        {results.map((r) => (
          <DeltaRow
            key={r.delta}
            th={th}
            r={r}
            remainingHigh={remainingHigh}
            remainingLow={remainingLow}
          />
        ))}
      </div>

      {/* Legend */}
      <div className="mt-2.5 flex items-center gap-4 font-sans text-[9px]">
        <span className="text-muted flex items-center gap-1">
          <span
            className="inline-block h-1.5 w-3 rounded-full"
            style={{ backgroundColor: th.surfaceAlt }}
          />
          Strike corridor
        </span>
        <span className="text-muted flex items-center gap-1">
          <span
            className="inline-block h-1.5 w-3 rounded-full"
            style={{ backgroundColor: th.green + '70' }}
          />
          Actual SPX range
        </span>
      </div>
    </div>
  );
}

// ============================================================
// DELTA ROW
// ============================================================

function DeltaRow({
  th,
  r,
  remainingHigh,
  remainingLow,
}: {
  th: Theme;
  r: SettlementResult;
  remainingHigh: number;
  remainingLow: number;
}) {
  const width = r.callStrike - r.putStrike;
  const closerSide =
    Math.abs(r.callCushion) < Math.abs(r.putCushion) ? 'call' : 'put';
  const closerCushion = closerSide === 'call' ? r.callCushion : r.putCushion;

  // Bar positions as percentages within the strike range
  const lowPct = Math.max(
    0,
    Math.min(100, ((remainingLow - r.putStrike) / width) * 100),
  );
  const highPct = Math.max(
    0,
    Math.min(100, ((remainingHigh - r.putStrike) / width) * 100),
  );
  const barLeft = lowPct;
  const barWidth = Math.max(1, highPct - lowPct);

  const barColor = r.survived ? th.green : th.red;

  return (
    <div className="bg-surface border-edge overflow-hidden rounded-lg border">
      <div className="flex items-center gap-3 p-2.5 pb-2">
        {/* Delta + icon */}
        <div className="w-[44px] shrink-0">
          <span
            className="font-mono text-[14px] font-bold"
            style={{ color: r.survived ? th.green : th.red }}
          >
            {r.delta}Δ
          </span>
        </div>

        {/* Verdict text */}
        <div className="min-w-0 flex-1">
          {r.survived ? (
            <span className="font-sans text-[11px]" style={{ color: th.green }}>
              Safe by {Math.abs(closerCushion).toFixed(0)} pts
              <span className="text-muted ml-1 text-[10px]">
                (nearest: {closerSide === 'call' ? 'call' : 'put'} side)
              </span>
            </span>
          ) : (
            <span className="font-sans text-[11px]" style={{ color: th.red }}>
              {r.callBreached && r.putBreached
                ? `Both sides breached \u2014 call by ${Math.abs(r.callCushion).toFixed(0)}, put by ${Math.abs(r.putCushion).toFixed(0)}`
                : r.callBreached
                  ? `Call breached by ${Math.abs(r.callCushion).toFixed(0)} pts (SPX hit ${remainingHigh.toFixed(0)})`
                  : `Put breached by ${Math.abs(r.putCushion).toFixed(0)} pts (SPX hit ${remainingLow.toFixed(0)})`}
            </span>
          )}
        </div>
      </div>

      {/* Visual bar */}
      <div className="px-2.5 pb-2.5">
        <div className="relative">
          {/* Strike labels */}
          <div className="mb-0.5 flex justify-between font-mono text-[8px]">
            <span style={{ color: th.red + 'AA' }}>
              {r.putStrike.toFixed(0)}
            </span>
            <span style={{ color: th.green + 'AA' }}>
              {r.callStrike.toFixed(0)}
            </span>
          </div>

          {/* Track */}
          <div
            className="relative h-[6px] w-full overflow-visible rounded-full"
            style={{ backgroundColor: th.surfaceAlt }}
          >
            {/* Actual price range */}
            <div
              className="absolute top-0 h-full rounded-full"
              style={{
                left: `${barLeft}%`,
                width: `${barWidth}%`,
                backgroundColor: barColor + '50',
                border: `1px solid ${barColor}80`,
              }}
            />

            {/* Breach overflow indicators */}
            {r.putBreached && (
              <div
                className="absolute top-0 left-0 h-full rounded-l-full"
                style={{
                  width: `${Math.min(20, Math.abs((remainingLow - r.putStrike) / width) * 100)}%`,
                  backgroundColor: th.red + '40',
                  borderLeft: `2px solid ${th.red}`,
                }}
              />
            )}
            {r.callBreached && (
              <div
                className="absolute top-0 right-0 h-full rounded-r-full"
                style={{
                  width: `${Math.min(20, Math.abs((remainingHigh - r.callStrike) / width) * 100)}%`,
                  backgroundColor: th.red + '40',
                  borderRight: `2px solid ${th.red}`,
                }}
              />
            )}
          </div>

          {/* Cushion labels below the bar */}
          <div className="mt-0.5 flex justify-between font-mono text-[8px]">
            <span style={{ color: r.putBreached ? th.red : th.textMuted }}>
              {r.putCushion >= 0 ? '+' : ''}
              {r.putCushion.toFixed(0)}
            </span>
            <span style={{ color: r.callBreached ? th.red : th.textMuted }}>
              {r.callCushion >= 0 ? '+' : ''}
              {r.callCushion.toFixed(0)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
