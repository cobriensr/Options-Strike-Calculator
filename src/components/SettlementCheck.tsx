/**
 * SettlementCheck — Shows whether an iron condor would have survived
 * from entry time to settlement, using actual historical SPX candles.
 *
 * Only renders in backtest mode (when historySnapshot is available).
 */

import { useState, useMemo } from 'react';
import type { Theme } from '../themes';
import type { HistoryCandle } from '../types/api';
import type { HistorySnapshot } from '../hooks/useHistoryData';

interface Props {
  readonly th: Theme;
  readonly snapshot: HistorySnapshot;
  readonly allCandles: readonly HistoryCandle[];
  readonly allDeltas: ReadonlyArray<
    | {
        delta: number;
        callStrike: number;
        putStrike: number;
        callSnapped?: number;
        putSnapped?: number;
      }
    | { error: string }
  >;
  readonly entryTimeLabel?: string;
}

interface SettlementResult {
  delta: number;
  callStrike: number;
  putStrike: number;
  /** Never touched either strike intraday */
  survived: boolean;
  callBreached: boolean;
  putBreached: boolean;
  callCushion: number;
  putCushion: number;
  settlement: number;
  remainingHigh: number;
  remainingLow: number;
  /** Settlement price ended between strikes (max profit even if breached intraday) */
  settledSafe: boolean;
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
      (
        d,
      ): d is {
        delta: number;
        callStrike: number;
        putStrike: number;
        callSnapped?: number;
        putSnapped?: number;
      } => !('error' in d),
    );
    const out: SettlementResult[] = [];
    for (const target of targetDeltas) {
      const entry = validDeltas.find((d) => d.delta === target);
      if (!entry) continue;

      // Use snapped strikes (nearest 5) if available, otherwise raw
      const call = entry.callSnapped ?? entry.callStrike;
      const put = entry.putSnapped ?? entry.putStrike;

      const r = computeSettlement(
        allCandles,
        snapshot.candleIndex,
        call,
        put,
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
  const settledSafeCount = results.filter((r) => r.settledSafe).length;
  const settledLossCount = results.filter((r) => !r.settledSafe).length;
  const breachedButSafe = results.filter(
    (r) => !r.survived && r.settledSafe,
  ).length;
  const total = results.length;
  const displayTime = entryTimeLabel ?? snapshot.candle.time;

  // Tightness analysis across all rows
  const TIGHT_PTS = 25;
  const WARN_PTS = 50;
  const allCushions = results.map((r) =>
    Math.min(Math.abs(r.callCushion), Math.abs(r.putCushion)),
  );
  const minCushionOverall = Math.min(...allCushions);
  const tightCount = results.filter(
    (r) =>
      r.survived &&
      Math.min(Math.abs(r.callCushion), Math.abs(r.putCushion)) < TIGHT_PTS,
  ).length;

  // Determine overall verdict color — factor in tightness
  let verdictColor: string;
  let verdictBg: string;
  let verdictBorder: string;

  if (settledLossCount > 0) {
    verdictColor = th.red;
    verdictBg = th.red + '0C';
    verdictBorder = th.red + '25';
  } else if (
    !results.every((r) => r.survived) ||
    minCushionOverall < WARN_PTS
  ) {
    verdictColor = '#E8A317';
    verdictBg = '#E8A3170C';
    verdictBorder = '#E8A31725';
  } else {
    verdictColor = th.green;
    verdictBg = th.green + '0C';
    verdictBorder = th.green + '25';
  }

  // Verdict text
  let verdictText: string;
  if (survived === total && minCushionOverall >= WARN_PTS) {
    verdictText = '\u2705 All Survived';
  } else if (survived === total && minCushionOverall < TIGHT_PTS) {
    verdictText = `\u26A0\uFE0F All survived, ${tightCount} close call${tightCount > 1 ? 's' : ''} (tightest: ${minCushionOverall.toFixed(0)} pts)`;
  } else if (survived === total) {
    verdictText = `\u26A0\uFE0F All survived, tightest cushion ${minCushionOverall.toFixed(0)} pts`;
  } else if (settledSafeCount === total) {
    verdictText = `\u26A0\uFE0F ${breachedButSafe} breached intraday, all settled safe \u2014 max profit`;
  } else if (settledLossCount === total) {
    verdictText = `\u274C All settled beyond strikes`;
  } else {
    verdictText = `${settledSafeCount}/${total} max profit at settlement (${settledLossCount} loss)`;
  }

  return (
    <div>
      <div className="text-accent mb-2.5 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
        Settlement Check
      </div>

      {/* Summary card */}
      <div
        className="mb-3 rounded-[10px] p-3.5"
        style={{
          backgroundColor: verdictBg,
          border: `1px solid ${verdictBorder}`,
        }}
      >
        <div className="mb-2 flex items-center gap-2">
          <span
            className="font-sans text-[13px] font-bold"
            style={{ color: verdictColor }}
          >
            {verdictText}
          </span>
        </div>

        <div className="text-secondary font-sans text-[11px] leading-relaxed">
          Entry at {displayTime} with SPX at {entryPrice.toFixed(0)}. SPX ranged{' '}
          {actualRange.toFixed(0)} pts ({remainingLow.toFixed(0)}
          {' \u2013 '}
          {remainingHigh.toFixed(0)}) and settled at {settlement.toFixed(0)} (
          {settleMove >= 0 ? '+' : ''}
          {settleMove.toFixed(0)} from entry).
        </div>

        {/* Stop-loss insight */}
        {survived > 0 && minCushionOverall < WARN_PTS && (
          <div className="text-muted mt-1.5 font-sans text-[10px] leading-normal">
            <strong style={{ color: '#D97706' }}>Stop-loss note:</strong> A{' '}
            {minCushionOverall.toFixed(0)}-pt stop would have been triggered on
            the{' '}
            {Math.min(
              Math.abs(results.at(-1)!.callCushion),
              Math.abs(results.at(-1)!.putCushion),
            ) === minCushionOverall
              ? `${results.at(-1)!.delta}\u0394`
              : 'tightest'}{' '}
            row, even though it settled safe.
          </div>
        )}
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
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 font-sans text-[9px]">
        <span className="text-muted flex items-center gap-1">
          <span
            className="inline-block h-1.5 w-3 rounded-full"
            style={{ backgroundColor: th.green + '70' }}
          />
          Comfortable ({'\u2265'}50 pts)
        </span>
        <span className="text-muted flex items-center gap-1">
          <span
            className="inline-block h-1.5 w-3 rounded-full"
            style={{ backgroundColor: '#E8A31770' }}
          />
          Tight (25{'\u2013'}50 pts)
        </span>
        <span className="text-muted flex items-center gap-1">
          <span
            className="inline-block h-1.5 w-3 rounded-full"
            style={{ backgroundColor: '#D9770670' }}
          />
          Close call ({'<'}25 pts)
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
  const [showTooltip, setShowTooltip] = useState(false);

  const width = r.callStrike - r.putStrike;
  const closerSide =
    Math.abs(r.callCushion) < Math.abs(r.putCushion) ? 'call' : 'put';
  const closerCushion = closerSide === 'call' ? r.callCushion : r.putCushion;
  const minCushion = Math.min(Math.abs(r.callCushion), Math.abs(r.putCushion));

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

  // Tightness thresholds for survived rows
  const TIGHT_PTS = 25; // < 25 pts cushion = close call
  const WARN_PTS = 50; // < 50 pts = caution

  // Color logic:
  //   survived + comfortable (>50) → green
  //   survived + caution (25-50)   → amber
  //   survived + tight (<25)       → amber (darker)
  //   breached + settled safe      → amber
  //   breached + settled loss      → red
  let rowColor: string;
  let barColor: string;
  if (r.survived) {
    if (minCushion < TIGHT_PTS) {
      rowColor = '#D97706'; // dark amber — close call
      barColor = '#D97706';
    } else if (minCushion < WARN_PTS) {
      rowColor = '#E8A317'; // amber — caution
      barColor = '#E8A317';
    } else {
      rowColor = th.green;
      barColor = th.green;
    }
  } else if (r.settledSafe) {
    rowColor = '#E8A317';
    barColor = '#E8A317';
  } else {
    rowColor = th.red;
    barColor = th.red;
  }

  // Tightness label for survived rows
  let tightnessLabel = '';
  if (r.survived) {
    if (minCushion < TIGHT_PTS) tightnessLabel = 'CLOSE CALL';
    else if (minCushion < WARN_PTS) tightnessLabel = 'TIGHT';
  }

  return (
    <div className="bg-surface border-edge overflow-hidden rounded-lg border">
      <div className="flex items-center gap-3 p-2.5 pb-1">
        {/* Delta label */}
        <div className="w-[44px] shrink-0">
          <span
            className="font-mono text-[14px] font-bold"
            style={{ color: rowColor }}
          >
            {r.delta}Δ
          </span>
        </div>

        {/* Verdict text */}
        <div className="min-w-0 flex-1">
          {r.survived ? (
            <span className="font-sans text-[11px]" style={{ color: rowColor }}>
              Safe by {Math.abs(closerCushion).toFixed(0)} pts
              <span className="text-muted ml-1 text-[10px]">
                (nearest: {closerSide} side)
              </span>
              {tightnessLabel && (
                <span
                  className="ml-1.5 rounded-sm px-1 py-0.5 font-sans text-[8px] font-bold tracking-wider"
                  style={{ backgroundColor: rowColor + '18', color: rowColor }}
                >
                  {tightnessLabel}
                </span>
              )}
            </span>
          ) : r.settledSafe ? (
            <span
              className="font-sans text-[11px]"
              style={{ color: '#E8A317' }}
            >
              Breached intraday, settled safe
              <span
                className="font-sans text-[10px] font-bold"
                style={{ color: th.green }}
              >
                {' \u2014 max profit'}
              </span>
            </span>
          ) : (
            <span className="font-sans text-[11px]" style={{ color: th.red }}>
              {r.callBreached && r.putBreached
                ? `Both sides breached \u2014 settled at ${r.settlement.toFixed(0)}`
                : r.callBreached
                  ? `Call breached by ${Math.abs(r.callCushion).toFixed(0)} pts \u2014 settled at ${r.settlement.toFixed(0)}`
                  : `Put breached by ${Math.abs(r.putCushion).toFixed(0)} pts \u2014 settled at ${r.settlement.toFixed(0)}`}
            </span>
          )}
        </div>
      </div>

      {/* Closest approach detail — always shown */}
      <div className="flex gap-4 px-2.5 pb-1.5 font-sans text-[9px]">
        <span className="text-muted">
          Put: SPX low {remainingLow.toFixed(0)}, strike{' '}
          {r.putStrike.toFixed(0)}
          {' \u2192 '}
          <span
            style={{
              color: r.putBreached
                ? th.red
                : Math.abs(r.putCushion) < TIGHT_PTS
                  ? '#D97706'
                  : th.textMuted,
            }}
          >
            {r.putCushion >= 0
              ? `${Math.abs(r.putCushion).toFixed(0)} pts cushion`
              : `breached by ${Math.abs(r.putCushion).toFixed(0)}`}
          </span>
        </span>
        <span className="text-muted">
          Call: SPX high {remainingHigh.toFixed(0)}, strike{' '}
          {r.callStrike.toFixed(0)}
          {' \u2192 '}
          <span
            style={{
              color: r.callBreached
                ? th.red
                : Math.abs(r.callCushion) < TIGHT_PTS
                  ? '#D97706'
                  : th.textMuted,
            }}
          >
            {r.callCushion >= 0
              ? `${Math.abs(r.callCushion).toFixed(0)} pts cushion`
              : `breached by ${Math.abs(r.callCushion).toFixed(0)}`}
          </span>
        </span>
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
            {/* Actual price range — with tooltip on hover */}
            <button
              type="button"
              className="absolute top-0 h-full cursor-pointer rounded-full"
              style={{
                left: `${barLeft}%`,
                width: `${barWidth}%`,
                backgroundColor: barColor + '50',
                border: `1px solid ${barColor}80`,
                padding: 0,
              }}
              onMouseEnter={() => setShowTooltip(true)}
              onMouseLeave={() => setShowTooltip(false)}
              onFocus={() => setShowTooltip(true)}
              onBlur={() => setShowTooltip(false)}
            >
              {showTooltip && (
                <div
                  className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2 rounded-md px-2.5 py-1.5 font-mono text-[10px] leading-snug whitespace-nowrap shadow-lg"
                  style={{
                    backgroundColor: '#1a1a2e',
                    color: '#e0e0e0',
                    border: '1px solid #444',
                  }}
                >
                  <div>
                    Low: <strong>{remainingLow.toFixed(2)}</strong>
                  </div>
                  <div>
                    High: <strong>{remainingHigh.toFixed(2)}</strong>
                  </div>
                  <div>
                    Range:{' '}
                    <strong>{(remainingHigh - remainingLow).toFixed(2)}</strong>{' '}
                    pts
                  </div>
                </div>
              )}
            </button>

            {/* Breach overflow indicators */}
            {r.putBreached && (
              <div
                className="absolute top-0 left-0 h-full rounded-l-full"
                style={{
                  width: `${Math.min(20, Math.abs((remainingLow - r.putStrike) / width) * 100)}%`,
                  backgroundColor: rowColor + '40',
                  borderLeft: `2px solid ${rowColor}`,
                }}
              />
            )}
            {r.callBreached && (
              <div
                className="absolute top-0 right-0 h-full rounded-r-full"
                style={{
                  width: `${Math.min(20, Math.abs((remainingHigh - r.callStrike) / width) * 100)}%`,
                  backgroundColor: rowColor + '40',
                  borderRight: `2px solid ${rowColor}`,
                }}
              />
            )}
          </div>

          {/* Cushion labels below the bar */}
          <div className="mt-0.5 flex justify-between font-mono text-[8px]">
            <span style={{ color: r.putBreached ? rowColor : th.textMuted }}>
              {r.putCushion > 0 ? '\u2212' : '+'}
              {Math.abs(r.putCushion).toFixed(0)}
            </span>
            <span style={{ color: r.callBreached ? rowColor : th.textMuted }}>
              {r.callCushion >= 0 ? '+' : '\u2212'}
              {Math.abs(r.callCushion).toFixed(0)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
