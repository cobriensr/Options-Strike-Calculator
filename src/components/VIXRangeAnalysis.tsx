import { useState } from 'react';
import type { Theme } from '../themes';
import { mkTh, mkTd, Chip } from './ui';
import {
  VIX_BUCKETS,
  SURVIVAL_DATA,
  FINE_VIX_STATS,
  TOTAL_MATCHED_DAYS,
  findBucket,
  type VIXBucket,
} from '../data/vixRangeStats';

interface Props {
  readonly th: Theme;
  readonly vix: number | null; // current VIX, null if not entered yet
  readonly spot: number | null; // SPX spot for points calculation
}

type SurvivalMode = 'settle' | 'intraday';

/**
 * Full Market Regime Analysis section.
 * Shows the survival heatmap, VIX-to-range breakdown, and fine-grained
 * range escalation bars. Highlights the active VIX bucket when a VIX
 * value is available from the calculator inputs.
 */
export default function VIXRangeAnalysis({ th, vix, spot }: Props) {
  const [survMode, setSurvMode] = useState<SurvivalMode>('settle');
  const [showFine, setShowFine] = useState(false);

  const activeBucket = vix == null ? null : findBucket(vix);
  const activeBucketIdx = activeBucket ? VIX_BUCKETS.indexOf(activeBucket) : -1;

  return (
    <div>
      {/* VIX Range Breakdown Table */}
      <div className="font-sans text-[11px] font-bold uppercase tracking-[0.14em] text-accent mb-2.5">
        Historical SPX Range by VIX Level
      </div>

      <div className="overflow-x-auto rounded-[10px] border border-edge">
        <table className="w-full border-collapse font-mono text-[13px]" role="table" aria-label="SPX daily range statistics by VIX level">
          <thead>
            <tr className="bg-table-header">
              <th className={mkTh('left')}>VIX</th>
              <th className={mkTh('right')}>Days</th>
              <th className={mkTh('right')}>Med H-L</th>
              <th className={mkTh('right')}>90th H-L</th>
              <th className={mkTh('right')}>Med O{'\u2192'}C</th>
              <th className={mkTh('right')}>&gt;1% H-L</th>
              <th className={mkTh('right')}>&gt;2% H-L</th>
            </tr>
          </thead>
          <tbody>
            {VIX_BUCKETS.map((b, i) => {
              const isActive = i === activeBucketIdx;
              const zoneColor = zoneToColor(b.zone, th);
              return (
                <tr
                  key={b.label}
                  className={isActive ? 'border-l-[3px]' : `border-l-[3px] border-transparent ${i % 2 === 1 ? 'bg-table-alt' : 'bg-surface'}`}
                  style={isActive ? {
                    backgroundColor: zoneColor + '14',
                    borderLeftColor: zoneColor,
                  } : undefined}
                >
                  <td className={`${mkTd()} font-semibold`} style={{ color: zoneColor }}>
                    {b.label}
                    {isActive && (
                      <span
                        className="ml-1.5 inline-block rounded-full px-1.5 py-px font-sans text-[9px] font-bold uppercase tracking-[0.06em]"
                        style={{
                          backgroundColor: zoneColor + '22',
                          color: zoneColor,
                        }}
                      >
                        current
                      </span>
                    )}
                  </td>
                  <td className={`${mkTd()} text-right text-muted`}>{b.count.toLocaleString()}</td>
                  <td className={`${mkTd()} text-right font-semibold`}>
                    {b.medHL.toFixed(2)}%
                    {spot != null && (
                      <span className="ml-1 text-[10px] text-muted">
                        ({Math.round(b.medHL / 100 * spot)})
                      </span>
                    )}
                  </td>
                  <td className={`${mkTd()} text-right font-medium text-danger`}>
                    {b.p90HL.toFixed(2)}%
                  </td>
                  <td className={`${mkTd()} text-right font-medium text-success`}>
                    {b.medOC.toFixed(2)}%
                  </td>
                  <td className={`${mkTd()} text-right`}>{b.over1HL}%</td>
                  <td
                    className={`${mkTd()} text-right`}
                    style={{
                      color: b.over2HL > 15 ? th.red : th.textSecondary,
                      fontWeight: b.over2HL > 15 ? 600 : 400,
                    }}
                  >
                    {b.over2HL}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-1.5 mb-4 text-[11px] italic text-muted">
        Based on {TOTAL_MATCHED_DAYS.toLocaleString()} trading days (1990{'\u2013'}2026). VIX open matched to same-day SPX OHLC. O{'\u2192'}C = settlement-relevant move.
      </p>

      {/* Survival Heatmap */}
      <div className="font-sans text-[11px] font-bold uppercase tracking-[0.14em] text-accent mb-2.5">
        Iron Condor Survival Rate
      </div>

      <div className="flex gap-1.5 mb-3">
        <Chip th={th} active={survMode === 'settle'} onClick={() => setSurvMode('settle')} label={'Settlement (O\u2192C)'} />
        <Chip th={th} active={survMode === 'intraday'} onClick={() => setSurvMode('intraday')} label="Intraday (H-L)" />
      </div>

      <div className="overflow-x-auto rounded-[10px] border border-edge">
        <table className="w-full border-collapse font-mono text-[12px]" role="table" aria-label={'Iron condor survival rates (' + survMode + ')'}>
          <thead>
            <tr className="bg-table-header">
              <th className={mkTh('left')}>VIX Level</th>
              {SURVIVAL_DATA.map((s) => (
                <th key={s.wing} className={`${mkTh('center')} min-w-14`}>{s.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {VIX_BUCKETS.map((b, bi) => {
              const isActive = bi === activeBucketIdx;
              const zoneColor = zoneToColor(b.zone, th);
              return (
                <tr
                  key={b.label}
                  className="border-l-[3px]"
                  style={{
                    borderLeftColor: isActive ? zoneColor : 'transparent',
                  }}
                >
                  <td className={`${mkTd()} whitespace-nowrap font-semibold`} style={{ color: zoneColor }}>
                    {b.label}
                  </td>
                  {SURVIVAL_DATA.map((s) => {
                    const val = survMode === 'settle' ? s.settle[bi] : s.intraday[bi];
                    if (val === undefined) return <td key={s.wing} className={mkTd()} />;
                    return (
                      <td
                        key={s.wing}
                        className={`${mkTd()} text-center`}
                        style={{
                          fontWeight: val >= 90 ? 600 : 400,
                          color: heatColor(val, th),
                          backgroundColor: heatBg(val),
                        }}
                      >
                        {val.toFixed(1)}%
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-1.5 text-[11px] italic text-muted">
        {survMode === 'settle'
          ? 'Settlement: % of days the closing price stayed within \u00B1X% of the open. Determines if your short strikes finish ITM.'
          : 'Intraday: % of days the full H-L range stayed within \u00B1X% of the open. Use for intraday defense triggers.'}
      </p>

      {/* Fine-grained toggle */}
      <button
        onClick={() => setShowFine(!showFine)}
        className="mt-3.5 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-edge bg-input px-3.5 py-2 font-sans text-[12px] font-semibold text-secondary"
      >
        {showFine ? '\u25B2' : '\u25BC'} {showFine ? 'Hide' : 'Show'} Point-by-Point VIX Breakdown (10{'\u2013'}30)
      </button>

      {showFine && (
        <div className="mt-3">
          <FineGrainedBars th={th} vix={vix} spot={spot} />
        </div>
      )}
    </div>
  );
}

// ============================================================
// FINE-GRAINED BAR CHART (pure CSS)
// ============================================================

function FineGrainedBars({ th, vix, spot }: { th: Theme; vix: number | null; spot: number | null }) {
  const activeVix = vix == null ? -1 : Math.floor(vix);
  const maxP90 = Math.max(...FINE_VIX_STATS.map((s) => s.p90HL));

  return (
    <div className="overflow-x-auto rounded-[10px] border border-edge">
      <table className="w-full border-collapse font-mono text-[12px]" role="table" aria-label="Fine-grained VIX range breakdown">
        <thead>
          <tr className="bg-table-header">
            <th className={`${mkTh('center')} w-12`}>VIX</th>
            <th className={`${mkTh('right')} w-12.5`}>Days</th>
            <th className={mkTh('left')}>Median H-L Range</th>
            <th className={`${mkTh('right')} w-15`}>90th</th>
            <th className={`${mkTh('right')} w-12.5`}>{'>'}2%</th>
          </tr>
        </thead>
        <tbody>
          {FINE_VIX_STATS.map((s, i) => {
            const isActive = s.vix === activeVix;
            const barWidth = (s.medHL / maxP90) * 100;
            const p90BarWidth = (s.p90HL / maxP90) * 100;
            const barColor = s.vix < 18 ? th.accent : s.vix < 25 ? '#E8A317' : th.red;
            return (
              <tr
                key={s.vix}
                className={isActive ? 'border-l-[3px]' : `border-l-[3px] border-transparent ${i % 2 === 1 ? 'bg-table-alt' : 'bg-surface'}`}
                style={isActive ? {
                  backgroundColor: barColor + '10',
                  borderLeftColor: barColor,
                } : undefined}
              >
                <td
                  className={`${mkTd()} text-center`}
                  style={{
                    fontWeight: isActive ? 700 : 500,
                    color: isActive ? barColor : th.text,
                  }}
                >
                  {s.vix}
                </td>
                <td className={`${mkTd()} text-right text-[11px] text-muted`}>
                  {s.count}
                </td>
                <td className={`${mkTd()} px-3 py-2`}>
                  <div className="flex items-center gap-2">
                    <div className="relative h-4 flex-1 overflow-hidden rounded bg-surface-alt">
                      {/* 90th percentile ghost bar */}
                      <div
                        className="absolute inset-y-0 left-0 rounded"
                        style={{
                          width: p90BarWidth + '%',
                          backgroundColor: barColor + '15',
                        }}
                      />
                      {/* Median bar */}
                      <div
                        className="absolute left-0 top-0.5 h-3 rounded-[3px] transition-[width] duration-200"
                        style={{
                          width: barWidth + '%',
                          backgroundColor: barColor,
                        }}
                      />
                    </div>
                    <span className="min-w-10.5 text-right text-[12px] font-semibold text-primary">
                      {s.medHL.toFixed(2)}%
                    </span>
                  </div>
                  {spot != null && (
                    <div className="mt-0.5 text-[10px] text-muted">
                      {'\u2248'}{Math.round(s.medHL / 100 * spot)} pts median, {Math.round(s.p90HL / 100 * spot)} pts 90th
                    </div>
                  )}
                </td>
                <td className={`${mkTd()} text-right text-[11px] text-danger`}>
                  {s.p90HL.toFixed(2)}%
                </td>
                <td
                  className={`${mkTd()} text-right text-[11px]`}
                  style={{
                    color: s.over2 > 15 ? th.red : th.textSecondary,
                    fontWeight: s.over2 > 15 ? 600 : 400,
                  }}
                >
                  {s.over2}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================
// HELPERS
// ============================================================

function zoneToColor(zone: VIXBucket['zone'], th: Theme): string {
  switch (zone) {
    case 'go': return th.green;
    case 'caution': return '#E8A317';
    case 'stop': return th.red;
    case 'danger': return th.red;
  }
}

function heatColor(val: number, th: Theme): string {
  if (val >= 95) return th.green;
  if (val >= 85) return th.green;
  if (val >= 70) return th.accent;
  if (val >= 50) return '#E8A317';
  return th.red;
}

function heatBg(val: number): string {
  if (val >= 95) return 'rgba(21,128,61,0.10)';
  if (val >= 85) return 'rgba(21,128,61,0.06)';
  if (val >= 70) return 'rgba(29,78,216,0.05)';
  if (val >= 50) return 'rgba(232,163,23,0.06)';
  return 'rgba(185,28,28,0.08)';
}
