import { useState, useEffect, useRef } from 'react';
import type { Theme } from '../../themes';
import type { TrafficSignal } from '../../types';
import { inputCls, tinyLbl, tint } from '../../utils/ui-utils';
import { parseDow } from '../../utils/time';
import { classifyOpeningRange } from '../../utils/classifiers';
import { estimateRange, getDowMultiplier } from '../../data/vixRangeStats';
import StatCell from './StatCell';
import RangeConsumptionBar from './RangeConsumptionBar';

interface Props {
  readonly th: Theme;
  readonly vix: number | null;
  readonly spot: number | null; // Current SPX spot from parent
  readonly selectedDate?: string; // For DOW adjustment
  readonly initialRange?: {
    // Auto-fill from live data
    readonly high: number;
    readonly low: number;
  };
}

interface RangeAnalysis {
  readonly openingRangePct: number;
  readonly openingRangePts: number;
  readonly expectedMedHL: number;
  readonly expectedP90HL: number;
  readonly pctOfMedianUsed: number;
  readonly pctOfP90Used: number;
  readonly signal: TrafficSignal;
  readonly label: string;
  readonly advice: string;
}

/**
 * Opening Range Check.
 * Compares the first ~30 minutes of trading range against the expected
 * daily range for the current VIX level.
 */
export default function OpeningRangeCheck({
  th,
  vix,
  spot,
  selectedDate,
  initialRange,
}: Props) {
  const [openHigh, setOpenHigh] = useState('5735');
  const [openLow, setOpenLow] = useState('5705');
  const userEdited = useRef(false);

  // Auto-fill from live data (overwrites defaults but respects user edits)
  useEffect(() => {
    if (initialRange && !userEdited.current) {
      setOpenHigh(initialRange.high.toFixed(2));
      setOpenLow(initialRange.low.toFixed(2));
    }
  }, [initialRange]);

  const hasVix = vix != null && vix > 0;

  const highVal = Number.parseFloat(openHigh);
  const lowVal = Number.parseFloat(openLow);
  const bothFilled =
    !Number.isNaN(highVal) &&
    !Number.isNaN(lowVal) &&
    highVal > 0 &&
    lowVal > 0;
  const hasRange = bothFilled && highVal > lowVal;
  const invertedRange = bothFilled && highVal <= lowVal;

  // Compute analysis
  const analysis: RangeAnalysis | null = (() => {
    if (!hasVix || !hasRange || !vix) return null;

    const openPrice = spot ?? (highVal + lowVal) / 2;
    const openingRangePts = highVal - lowVal;
    const openingRangePct = (openingRangePts / openPrice) * 100;

    const range = estimateRange(vix);
    const dow = parseDow(selectedDate);
    const dowMult = dow == null ? null : getDowMultiplier(vix, dow);
    const hlAdj = dowMult?.multHL ?? 1;

    const expectedMedHL = range.medHL * hlAdj;
    const expectedP90HL = range.p90HL * hlAdj;

    const pctOfMedianUsed = openingRangePct / expectedMedHL;
    const pctOfP90Used = openingRangePct / expectedP90HL;

    const { signal, label, advice } = classifyOpeningRange(pctOfMedianUsed);

    return {
      openingRangePct,
      openingRangePts,
      expectedMedHL,
      expectedP90HL,
      pctOfMedianUsed,
      pctOfP90Used,
      signal,
      label,
      advice,
    };
  })();

  const signalColor =
    analysis?.signal === 'green'
      ? th.green
      : analysis?.signal === 'yellow'
        ? th.caution
        : analysis?.signal === 'red'
          ? th.red
          : th.textMuted;

  return (
    <div>
      <div className="text-accent mb-2.5 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
        Opening Range Check
      </div>

      <p className="text-secondary m-0 mb-3 font-sans text-xs leading-normal">
        Enter the SPX high and low from the first ~30 minutes (9:30{'\u2013'}
        10:00 ET) to see how much of the expected daily range has been consumed.
      </p>

      {/* Input row */}
      <div className="mb-3.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <div>
          <label htmlFor="open-range-high" className={tinyLbl}>
            30-min High
          </label>
          <input
            id="open-range-high"
            type="text"
            inputMode="decimal"
            placeholder={spot ? (spot + 15).toFixed(0) : 'e.g. 6760'}
            value={openHigh}
            onChange={(e) => {
              setOpenHigh(e.target.value);
              userEdited.current = true;
            }}
            className={inputCls}
          />
        </div>
        <div>
          <label htmlFor="open-range-low" className={tinyLbl}>
            30-min Low
          </label>
          <input
            id="open-range-low"
            type="text"
            inputMode="decimal"
            placeholder={spot ? (spot - 15).toFixed(0) : 'e.g. 6720'}
            value={openLow}
            onChange={(e) => {
              setOpenLow(e.target.value);
              userEdited.current = true;
            }}
            className={inputCls}
          />
        </div>
      </div>

      {/* Analysis results */}
      {analysis && (
        <div>
          {/* Signal banner */}
          <div
            className="mb-3 flex items-start gap-3 rounded-[10px] p-3 sm:items-center sm:p-4"
            style={{
              backgroundColor: tint(signalColor, '10'),
              border: '1.5px solid ' + tint(signalColor, '30'),
            }}
          >
            <div
              className="h-3 w-3 shrink-0 rounded-full"
              style={{
                backgroundColor: signalColor,
                boxShadow: '0 0 8px ' + tint(signalColor, '66'),
              }}
            />
            <div>
              <span
                className="font-sans text-[10px] font-bold tracking-widest uppercase"
                style={{ color: signalColor }}
              >
                {analysis.label}
              </span>
              <span className="text-secondary ml-2.5 font-sans text-[11px]">
                {analysis.advice}
              </span>
            </div>
          </div>

          {/* Stats grid */}
          <div className="bg-surface-alt border-edge mb-3 grid grid-cols-1 gap-2.5 rounded-[10px] border px-4 py-3.5 sm:grid-cols-3">
            <StatCell
              label="Opening Range"
              value={analysis.openingRangePct.toFixed(2) + '%'}
              sub={analysis.openingRangePts.toFixed(0) + ' pts'}
              color={signalColor}
            />
            <StatCell
              label="Expected Median"
              value={analysis.expectedMedHL.toFixed(2) + '%'}
              sub="50th pctile H-L"
              color={th.accent}
            />
            <StatCell
              label="Expected 90th"
              value={analysis.expectedP90HL.toFixed(2) + '%'}
              sub="90th pctile H-L"
              color={th.red}
            />
          </div>

          {/* Range consumption bar */}
          <RangeConsumptionBar
            th={th}
            pctOfMedianUsed={analysis.pctOfMedianUsed}
            pctOfP90Used={analysis.pctOfP90Used}
            signalColor={signalColor}
          />

          <p className="text-muted mt-2 text-[11px] italic">
            {analysis.pctOfMedianUsed < 0.4
              ? 'The first 30 minutes consumed less than 40% of the expected daily range. Historically this signals a quieter day \u2014 good for adding IC positions.'
              : analysis.pctOfMedianUsed < 0.65
                ? 'The first 30 minutes consumed 40\u201365% of the expected daily range. The day is moving but not extreme. Use tighter deltas for any additions.'
                : 'The first 30 minutes already exceeded 65% of the expected median range. On days like this, the full range often extends further. Avoid adding new positions unless significantly wider.'}
          </p>
        </div>
      )}

      {/* Empty states */}
      {!hasVix && (
        <p className="text-muted mt-1 text-xs italic">
          Enter a VIX value above to enable opening range analysis.
        </p>
      )}
      {hasVix && !hasRange && !invertedRange && (
        <p className="text-muted mt-1 text-xs italic">
          Enter the SPX high and low from the first 30 minutes of trading to see
          the analysis.
        </p>
      )}
      {invertedRange && (
        <p className="text-danger mt-1 text-xs">
          High must be greater than low.
        </p>
      )}
    </div>
  );
}
