import { useState } from 'react';
import type { Theme } from '../themes';
import { tinyLbl } from './ui';
import { estimateRange, getDowMultiplier } from '../data/vixRangeStats';

interface Props {
  readonly th: Theme;
  readonly vix: number | null;
  readonly spot: number | null;        // Current SPX spot from parent
  readonly selectedDate?: string;       // For DOW adjustment
}

type Signal = 'green' | 'yellow' | 'red';

interface RangeAnalysis {
  readonly openingRangePct: number;     // First 30-min H-L as % of open
  readonly openingRangePts: number;     // First 30-min H-L in points
  readonly expectedMedHL: number;       // Expected median daily H-L %
  readonly expectedP90HL: number;       // Expected 90th pctile daily H-L %
  readonly pctOfMedianUsed: number;     // Opening range / median H-L (0-1+)
  readonly pctOfP90Used: number;        // Opening range / p90 H-L (0-1+)
  readonly signal: Signal;
  readonly label: string;
  readonly advice: string;
}

function classify(pctOfMedian: number): { signal: Signal; label: string; advice: string } {
  if (pctOfMedian < 0.40) {
    return {
      signal: 'green',
      label: 'RANGE INTACT',
      advice: 'Opening range is small relative to the expected daily move. Good conditions to add positions.',
    };
  }
  if (pctOfMedian < 0.65) {
    return {
      signal: 'yellow',
      label: 'MODERATE',
      advice: 'A meaningful portion of the expected range is used. Add positions with tighter deltas or smaller size.',
    };
  }
  return {
    signal: 'red',
    label: 'RANGE EXHAUSTED',
    advice: 'The day is already running hot. Adding new positions carries elevated risk of further extension.',
  };
}

function parseDow(selectedDate?: string): number | null {
  if (selectedDate) {
    const parts = selectedDate.split('-');
    if (parts.length === 3) {
      const d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
      const jsDay = d.getUTCDay();
      if (jsDay >= 1 && jsDay <= 5) return jsDay - 1;
      return null;
    }
  }
  const jsDay = new Date().getDay();
  if (jsDay === 0 || jsDay === 6) return null;
  return jsDay - 1;
}

const inputCls = "bg-input border-[1.5px] border-edge-strong rounded-lg text-primary py-[11px] px-[14px] text-base font-mono outline-none w-full transition-[border-color] duration-150";

/**
 * Opening Range Check.
 * Compares the first ~30 minutes of trading range against the expected
 * daily range for the current VIX level. Helps decide whether to add
 * more positions later in the morning.
 */
export default function OpeningRangeCheck({ th, vix, spot, selectedDate }: Props) {
  const [openHigh, setOpenHigh] = useState('');
  const [openLow, setOpenLow] = useState('');

  const hasVix = vix != null && vix > 0;

  const highVal = Number.parseFloat(openHigh);
  const lowVal = Number.parseFloat(openLow);
  const bothFilled = !Number.isNaN(highVal) && !Number.isNaN(lowVal) && highVal > 0 && lowVal > 0;
  const hasRange = bothFilled && highVal > lowVal;
  const invertedRange = bothFilled && highVal <= lowVal;

  // Compute analysis
  const analysis: RangeAnalysis | null = (() => {
    if (!hasVix || !hasRange || !vix) return null;

    const openPrice = spot ?? ((highVal + lowVal) / 2); // use spot if available, else midpoint
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

    const { signal, label, advice } = classify(pctOfMedianUsed);

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

  const signalColor = analysis?.signal === 'green' ? th.green
    : analysis?.signal === 'yellow' ? '#E8A317'
    : analysis?.signal === 'red' ? th.red
    : th.textMuted;

  return (
    <div>
      <div className="font-sans text-[11px] font-bold uppercase tracking-[0.14em] text-accent mb-2.5">
        Opening Range Check
      </div>

      <p className="text-xs text-secondary m-0 mb-3 font-sans leading-normal">
        Enter the SPX high and low from the first ~30 minutes (9:30{'\u2013'}10:00 ET) to see how much of the expected daily range has been consumed.
      </p>

      {/* Input row */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 mb-3.5">
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
            onChange={(e) => setOpenHigh(e.target.value)}
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
            onChange={(e) => setOpenLow(e.target.value)}
            className={inputCls}
          />
        </div>
      </div>

      {/* Analysis results */}
      {analysis && (
        <div>
          {/* Signal banner */}
          <div
            className="flex items-start sm:items-center gap-3 rounded-[10px] p-3 sm:p-4 mb-3"
            style={{ backgroundColor: signalColor + '10', border: '1.5px solid ' + signalColor + '30' }}
          >
            <div
              className="w-3 h-3 rounded-full shrink-0"
              style={{ backgroundColor: signalColor, boxShadow: '0 0 8px ' + signalColor + '66' }}
            />
            <div>
              <span
                className="text-[10px] font-bold uppercase tracking-widest font-sans"
                style={{ color: signalColor }}
              >
                {analysis.label}
              </span>
              <span className="text-[11px] text-secondary ml-2.5 font-sans">
                {analysis.advice}
              </span>
            </div>
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3 py-3.5 px-4 rounded-[10px] bg-surface-alt border border-edge mb-3">
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
          <div className="py-3.5 px-4 rounded-[10px] bg-surface border border-edge">
            <div className="text-[10px] font-bold uppercase tracking-[0.06em] text-tertiary font-sans mb-2">
              Range consumed vs. expected daily range
            </div>

            {/* Median bar */}
            <div className="mb-2.5">
              <div className="flex justify-between items-center text-[11px] font-mono mb-1">
                <span className="text-secondary">vs. Median H-L</span>
                <span className="font-bold" style={{ color: signalColor }}>
                  {(analysis.pctOfMedianUsed * 100).toFixed(0)}% consumed
                </span>
              </div>
              <div className="h-2.5 rounded-[5px] bg-surface-alt relative overflow-hidden">
                <div
                  className="absolute top-0 left-0 h-full rounded-[5px] transition-[width] duration-300"
                  style={{
                    width: Math.min(analysis.pctOfMedianUsed, 1.5) / 1.5 * 100 + '%',
                    backgroundColor: signalColor,
                  }}
                />
                {/* 100% marker */}
                <div
                  className="absolute -top-0.5 w-0.5 h-3.5"
                  style={{
                    left: (1 / 1.5 * 100) + '%',
                    backgroundColor: th.text + '40',
                  }}
                />
              </div>
              <div className="flex justify-between text-[8px] text-muted font-mono mt-0.5">
                <span>0%</span>
                <span>50%</span>
                <span className="font-semibold">100%</span>
                <span>150%</span>
              </div>
            </div>

            {/* P90 bar */}
            <div>
              <div className="flex justify-between items-center text-[11px] font-mono mb-1">
                <span className="text-secondary">vs. 90th Pctile H-L</span>
                <span className="font-bold text-secondary">
                  {(analysis.pctOfP90Used * 100).toFixed(0)}% consumed
                </span>
              </div>
              <div className="h-2.5 rounded-[5px] bg-surface-alt relative overflow-hidden">
                <div
                  className="absolute top-0 left-0 h-full rounded-[5px] transition-[width] duration-300"
                  style={{
                    width: Math.min(analysis.pctOfP90Used, 1.5) / 1.5 * 100 + '%',
                    backgroundColor: th.accent + '80',
                  }}
                />
                <div
                  className="absolute -top-0.5 w-0.5 h-3.5"
                  style={{
                    left: (1 / 1.5 * 100) + '%',
                    backgroundColor: th.text + '40',
                  }}
                />
              </div>
              <div className="flex justify-between text-[8px] text-muted font-mono mt-0.5">
                <span>0%</span>
                <span>50%</span>
                <span className="font-semibold">100%</span>
                <span>150%</span>
              </div>
            </div>
          </div>

          <p className="text-[11px] text-muted mt-2 italic">
            {analysis.pctOfMedianUsed < 0.40
              ? 'The first 30 minutes consumed less than 40% of the expected daily range. Historically this signals a quieter day \u2014 good for adding IC positions.'
              : analysis.pctOfMedianUsed < 0.65
                ? 'The first 30 minutes consumed 40\u201365% of the expected daily range. The day is moving but not extreme. Use tighter deltas for any additions.'
                : 'The first 30 minutes already exceeded 65% of the expected median range. On days like this, the full range often extends further. Avoid adding new positions unless significantly wider.'}
          </p>
        </div>
      )}

      {/* Empty states */}
      {!hasVix && (
        <p className="text-xs text-muted mt-1 italic">
          Enter a VIX value above to enable opening range analysis.
        </p>
      )}
      {hasVix && !hasRange && !invertedRange && (
        <p className="text-xs text-muted mt-1 italic">
          Enter the SPX high and low from the first 30 minutes of trading to see the analysis.
        </p>
      )}
      {invertedRange && (
        <p className="text-xs text-danger mt-1">
          High must be greater than low.
        </p>
      )}
    </div>
  );
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

function StatCell({ label, value, sub, color }: {
  label: string; value: string; sub: string; color: string;
}) {
  return (
    <div className="text-center">
      <div className="text-[9px] font-bold uppercase tracking-[0.06em] text-tertiary font-sans">{label}</div>
      <div className="text-[17px] font-bold font-mono mt-0.5" style={{ color }}>{value}</div>
      <div className="text-[10px] text-muted font-mono">{sub}</div>
    </div>
  );
}
