import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { Theme } from '../themes';
import { tinyLblStyle } from './ui';
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

  const tinyLbl = tinyLblStyle(th);
  const inputStyle: CSSProperties = {
    backgroundColor: th.inputBg, border: '1.5px solid ' + th.borderStrong, borderRadius: 8,
    color: th.text, padding: '11px 14px', fontSize: 16, fontFamily: "'DM Mono', monospace",
    outline: 'none', width: '100%', boxSizing: 'border-box' as const, transition: 'border-color 0.15s',
  };

  return (
    <div>
      <div style={{
        fontFamily: "'Outfit', sans-serif", fontSize: 11, fontWeight: 700,
        textTransform: 'uppercase' as const, letterSpacing: '0.14em',
        color: th.accent, marginBottom: 10,
      }}>
        Opening Range Check
      </div>

      <p style={{ fontSize: 12, color: th.textSecondary, margin: '0 0 12px', fontFamily: "'Outfit', sans-serif", lineHeight: 1.5 }}>
        Enter the SPX high and low from the first ~30 minutes (9:30{'\u2013'}10:00 ET) to see how much of the expected daily range has been consumed.
      </p>

      {/* Input row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
        <div>
          <label htmlFor="open-range-high" style={tinyLbl}>
            30-min High
          </label>
          <input
            id="open-range-high"
            type="text"
            inputMode="decimal"
            placeholder={spot ? (spot + 15).toFixed(0) : 'e.g. 6760'}
            value={openHigh}
            onChange={(e) => setOpenHigh(e.target.value)}
            style={inputStyle}
          />
        </div>
        <div>
          <label htmlFor="open-range-low" style={tinyLbl}>
            30-min Low
          </label>
          <input
            id="open-range-low"
            type="text"
            inputMode="decimal"
            placeholder={spot ? (spot - 15).toFixed(0) : 'e.g. 6720'}
            value={openLow}
            onChange={(e) => setOpenLow(e.target.value)}
            style={inputStyle}
          />
        </div>
      </div>

      {/* Analysis results */}
      {analysis && (
        <div>
          {/* Signal banner */}
          <div style={{
            padding: '12px 16px', borderRadius: 10, marginBottom: 12,
            backgroundColor: signalColor + '10',
            border: '1.5px solid ' + signalColor + '30',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <div style={{
              width: 12, height: 12, borderRadius: '50%',
              backgroundColor: signalColor,
              boxShadow: '0 0 8px ' + signalColor + '66',
              flexShrink: 0,
            }} />
            <div>
              <span style={{
                fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const,
                letterSpacing: '0.1em', color: signalColor,
                fontFamily: "'Outfit', sans-serif",
              }}>
                {analysis.label}
              </span>
              <span style={{
                fontSize: 11, color: th.textSecondary, marginLeft: 10,
                fontFamily: "'Outfit', sans-serif",
              }}>
                {analysis.advice}
              </span>
            </div>
          </div>

          {/* Stats grid */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10,
            padding: '14px 16px', borderRadius: 10,
            backgroundColor: th.surfaceAlt,
            border: '1px solid ' + th.border,
            marginBottom: 12,
          }}>
            <StatCell
              th={th}
              label="Opening Range"
              value={analysis.openingRangePct.toFixed(2) + '%'}
              sub={analysis.openingRangePts.toFixed(0) + ' pts'}
              color={signalColor}
            />
            <StatCell
              th={th}
              label="Expected Median"
              value={analysis.expectedMedHL.toFixed(2) + '%'}
              sub="50th pctile H-L"
              color={th.accent}
            />
            <StatCell
              th={th}
              label="Expected 90th"
              value={analysis.expectedP90HL.toFixed(2) + '%'}
              sub="90th pctile H-L"
              color={th.red}
            />
          </div>

          {/* Range consumption bar */}
          <div style={{
            padding: '14px 16px', borderRadius: 10,
            backgroundColor: th.surface,
            border: '1px solid ' + th.border,
          }}>
            <div style={{
              fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const,
              letterSpacing: '0.06em', color: th.textTertiary,
              fontFamily: "'Outfit', sans-serif", marginBottom: 8,
            }}>
              Range consumed vs. expected daily range
            </div>

            {/* Median bar */}
            <div style={{ marginBottom: 10 }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: 11, fontFamily: "'DM Mono', monospace", marginBottom: 4,
              }}>
                <span style={{ color: th.textSecondary }}>vs. Median H-L</span>
                <span style={{ fontWeight: 700, color: signalColor }}>
                  {(analysis.pctOfMedianUsed * 100).toFixed(0)}% consumed
                </span>
              </div>
              <div style={{
                height: 10, borderRadius: 5, backgroundColor: th.surfaceAlt,
                position: 'relative', overflow: 'hidden',
              }}>
                <div style={{
                  position: 'absolute', top: 0, left: 0,
                  height: '100%',
                  width: Math.min(analysis.pctOfMedianUsed, 1.5) / 1.5 * 100 + '%',
                  backgroundColor: signalColor,
                  borderRadius: 5,
                  transition: 'width 0.3s',
                }} />
                {/* 100% marker */}
                <div style={{
                  position: 'absolute', top: -2, left: (1 / 1.5 * 100) + '%',
                  width: 2, height: 14,
                  backgroundColor: th.text + '40',
                }} />
              </div>
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                fontSize: 8, color: th.textMuted,
                fontFamily: "'DM Mono', monospace", marginTop: 2,
              }}>
                <span>0%</span>
                <span>50%</span>
                <span style={{ fontWeight: 600 }}>100%</span>
                <span>150%</span>
              </div>
            </div>

            {/* P90 bar */}
            <div>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: 11, fontFamily: "'DM Mono', monospace", marginBottom: 4,
              }}>
                <span style={{ color: th.textSecondary }}>vs. 90th Pctile H-L</span>
                <span style={{ fontWeight: 700, color: th.textSecondary }}>
                  {(analysis.pctOfP90Used * 100).toFixed(0)}% consumed
                </span>
              </div>
              <div style={{
                height: 10, borderRadius: 5, backgroundColor: th.surfaceAlt,
                position: 'relative', overflow: 'hidden',
              }}>
                <div style={{
                  position: 'absolute', top: 0, left: 0,
                  height: '100%',
                  width: Math.min(analysis.pctOfP90Used, 1.5) / 1.5 * 100 + '%',
                  backgroundColor: th.accent + '80',
                  borderRadius: 5,
                  transition: 'width 0.3s',
                }} />
                <div style={{
                  position: 'absolute', top: -2, left: (1 / 1.5 * 100) + '%',
                  width: 2, height: 14,
                  backgroundColor: th.text + '40',
                }} />
              </div>
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                fontSize: 8, color: th.textMuted,
                fontFamily: "'DM Mono', monospace", marginTop: 2,
              }}>
                <span>0%</span>
                <span>50%</span>
                <span style={{ fontWeight: 600 }}>100%</span>
                <span>150%</span>
              </div>
            </div>
          </div>

          <p style={{ fontSize: 11, color: th.textMuted, margin: '8px 0 0', fontStyle: 'italic' }}>
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
        <p style={{ fontSize: 12, color: th.textMuted, margin: '4px 0 0', fontStyle: 'italic' }}>
          Enter a VIX value above to enable opening range analysis.
        </p>
      )}
      {hasVix && !hasRange && !invertedRange && (
        <p style={{ fontSize: 12, color: th.textMuted, margin: '4px 0 0', fontStyle: 'italic' }}>
          Enter the SPX high and low from the first 30 minutes of trading to see the analysis.
        </p>
      )}
      {invertedRange && (
        <p style={{ fontSize: 12, color: th.red, margin: '4px 0 0' }}>
          High must be greater than low.
        </p>
      )}
    </div>
  );
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

function StatCell({ th, label, value, sub, color }: {
  th: Theme; label: string; value: string; sub: string; color: string;
}) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{
        fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const,
        letterSpacing: '0.06em', color: th.textTertiary,
        fontFamily: "'Outfit', sans-serif",
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 17, fontWeight: 700, color,
        fontFamily: "'DM Mono', monospace", marginTop: 2,
      }}>
        {value}
      </div>
      <div style={{
        fontSize: 10, color: th.textMuted,
        fontFamily: "'DM Mono', monospace",
      }}>
        {sub}
      </div>
    </div>
  );
}
