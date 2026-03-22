/**
 * SettlementCheck — Shows whether an iron condor would have survived
 * from entry time to settlement, using actual historical SPX candles.
 *
 * Only renders in backtest mode (when historySnapshot is available).
 */

import { useMemo } from 'react';
import type { Theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import type { HistoryCandle } from '../../types/api';
import type { HistorySnapshot } from '../../hooks/useHistoryData';
import { SETTLEMENT_DELTAS } from '../../constants';
import { computeSettlement } from '../../utils/settlement';
import type { SettlementResult } from './types';
import DeltaRow from './DeltaRow';

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
    for (const target of SETTLEMENT_DELTAS) {
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
    verdictBg = tint(th.red, '0C');
    verdictBorder = tint(th.red, '25');
  } else if (
    !results.every((r) => r.survived) ||
    minCushionOverall < WARN_PTS
  ) {
    verdictColor = th.caution;
    verdictBg = tint(th.caution, '0C');
    verdictBorder = tint(th.caution, '25');
  } else {
    verdictColor = th.green;
    verdictBg = tint(th.green, '0C');
    verdictBorder = tint(th.green, '25');
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
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 font-sans text-[10px]">
        <span className="text-muted flex items-center gap-1">
          <span
            className="inline-block h-1.5 w-3 rounded-full"
            style={{ backgroundColor: tint(th.green, '70') }}
          />
          Comfortable ({'\u2265'}50 pts)
        </span>
        <span className="text-muted flex items-center gap-1">
          <span
            className="inline-block h-1.5 w-3 rounded-full"
            style={{ backgroundColor: tint(th.caution, '70') }}
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
