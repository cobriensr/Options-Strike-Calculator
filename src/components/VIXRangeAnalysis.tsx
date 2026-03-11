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
      <div style={{
        fontFamily: "'Outfit', sans-serif", fontSize: 11, fontWeight: 700,
        textTransform: 'uppercase' as const, letterSpacing: '0.14em',
        color: th.accent, marginBottom: 10,
      }}>
        Historical SPX Range by VIX Level
      </div>

      <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid ' + th.border }}>
        <table style={{
          width: '100%', borderCollapse: 'collapse',
          fontFamily: "'DM Mono', monospace", fontSize: 13,
        }} role="table" aria-label="SPX daily range statistics by VIX level">
          <thead>
            <tr style={{ backgroundColor: th.tableHeader }}>
              <th style={mkTh(th, 'left')}>VIX</th>
              <th style={mkTh(th, 'right')}>Days</th>
              <th style={mkTh(th, 'right')}>Med H-L</th>
              <th style={mkTh(th, 'right')}>90th H-L</th>
              <th style={mkTh(th, 'right')}>Med O{'\u2192'}C</th>
              <th style={mkTh(th, 'right')}>&gt;1% H-L</th>
              <th style={mkTh(th, 'right')}>&gt;2% H-L</th>
            </tr>
          </thead>
          <tbody>
            {VIX_BUCKETS.map((b, i) => {
              const isActive = i === activeBucketIdx;
              const zoneColor = zoneToColor(b.zone, th);
              return (
                <tr key={b.label} style={{
                  backgroundColor: isActive
                    ? (zoneColor + '14')
                    : (i % 2 === 1 ? th.tableRowAlt : th.surface),
                  borderLeft: isActive ? ('3px solid ' + zoneColor) : '3px solid transparent',
                }}>
                  <td style={{ ...mkTd(th), fontWeight: 600, color: zoneColor }}>
                    {b.label}
                    {isActive && (
                      <span style={{
                        marginLeft: 6, fontSize: 9, fontWeight: 700,
                        backgroundColor: zoneColor + '22', color: zoneColor,
                        padding: '1px 6px', borderRadius: 99,
                        fontFamily: "'Outfit', sans-serif",
                        textTransform: 'uppercase' as const, letterSpacing: '0.06em',
                      }}>
                        current
                      </span>
                    )}
                  </td>
                  <td style={{ ...mkTd(th), textAlign: 'right', color: th.textMuted }}>{b.count.toLocaleString()}</td>
                  <td style={{ ...mkTd(th), textAlign: 'right', fontWeight: 600 }}>
                    {b.medHL.toFixed(2)}%
                    {spot != null && (
                      <span style={{ fontSize: 10, color: th.textMuted, marginLeft: 4 }}>
                        ({Math.round(b.medHL / 100 * spot)})
                      </span>
                    )}
                  </td>
                  <td style={{ ...mkTd(th), textAlign: 'right', color: th.red, fontWeight: 500 }}>
                    {b.p90HL.toFixed(2)}%
                  </td>
                  <td style={{ ...mkTd(th), textAlign: 'right', color: th.green, fontWeight: 500 }}>
                    {b.medOC.toFixed(2)}%
                  </td>
                  <td style={{ ...mkTd(th), textAlign: 'right' }}>{b.over1HL}%</td>
                  <td style={{ ...mkTd(th), textAlign: 'right', color: b.over2HL > 15 ? th.red : th.textSecondary, fontWeight: b.over2HL > 15 ? 600 : 400 }}>
                    {b.over2HL}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: th.textMuted, margin: '6px 0 16px', fontStyle: 'italic' }}>
        Based on {TOTAL_MATCHED_DAYS.toLocaleString()} trading days (1990{'\u2013'}2026). VIX open matched to same-day SPX OHLC. O{'\u2192'}C = settlement-relevant move.
      </p>

      {/* Survival Heatmap */}
      <div style={{
        fontFamily: "'Outfit', sans-serif", fontSize: 11, fontWeight: 700,
        textTransform: 'uppercase' as const, letterSpacing: '0.14em',
        color: th.accent, marginBottom: 10,
      }}>
        Iron Condor Survival Rate
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <Chip th={th} active={survMode === 'settle'} onClick={() => setSurvMode('settle')} label={'Settlement (O\u2192C)'} />
        <Chip th={th} active={survMode === 'intraday'} onClick={() => setSurvMode('intraday')} label="Intraday (H-L)" />
      </div>

      <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid ' + th.border }}>
        <table style={{
          width: '100%', borderCollapse: 'collapse',
          fontFamily: "'DM Mono', monospace", fontSize: 12,
        }} role="table" aria-label={'Iron condor survival rates (' + survMode + ')'}>
          <thead>
            <tr style={{ backgroundColor: th.tableHeader }}>
              <th style={mkTh(th, 'left')}>VIX Level</th>
              {SURVIVAL_DATA.map((s) => (
                <th key={s.wing} style={{ ...mkTh(th, 'center'), minWidth: 56 }}>{s.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {VIX_BUCKETS.map((b, bi) => {
              const isActive = bi === activeBucketIdx;
              const zoneColor = zoneToColor(b.zone, th);
              return (
                <tr key={b.label} style={{
                  borderLeft: isActive ? ('3px solid ' + zoneColor) : '3px solid transparent',
                }}>
                  <td style={{ ...mkTd(th), fontWeight: 600, color: zoneColor, whiteSpace: 'nowrap' as const }}>
                    {b.label}
                  </td>
                  {SURVIVAL_DATA.map((s) => {
                    const val = survMode === 'settle' ? s.settle[bi] : s.intraday[bi];
                    if (val === undefined) return <td key={s.wing} style={mkTd(th)} />;
                    return (
                      <td key={s.wing} style={{
                        ...mkTd(th),
                        textAlign: 'center',
                        fontWeight: val >= 90 ? 600 : 400,
                        color: heatColor(val, th),
                        backgroundColor: heatBg(val),
                      }}>
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

      <p style={{ fontSize: 11, color: th.textMuted, margin: '6px 0 0', fontStyle: 'italic' }}>
        {survMode === 'settle'
          ? 'Settlement: % of days the closing price stayed within \u00B1X% of the open. Determines if your short strikes finish ITM.'
          : 'Intraday: % of days the full H-L range stayed within \u00B1X% of the open. Use for intraday defense triggers.'}
      </p>

      {/* Fine-grained toggle */}
      <button
        onClick={() => setShowFine(!showFine)}
        style={{
          marginTop: 14, width: '100%', padding: '8px 14px', borderRadius: 8,
          border: '1px solid ' + th.border,
          backgroundColor: th.chipBg, color: th.textSecondary,
          cursor: 'pointer', fontSize: 12, fontWeight: 600,
          fontFamily: "'Outfit', sans-serif",
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}
      >
        {showFine ? '\u25B2' : '\u25BC'} {showFine ? 'Hide' : 'Show'} Point-by-Point VIX Breakdown (10{'\u2013'}30)
      </button>

      {showFine && (
        <div style={{ marginTop: 12 }}>
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
    <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid ' + th.border }}>
      <table style={{
        width: '100%', borderCollapse: 'collapse',
        fontFamily: "'DM Mono', monospace", fontSize: 12,
      }} role="table" aria-label="Fine-grained VIX range breakdown">
        <thead>
          <tr style={{ backgroundColor: th.tableHeader }}>
            <th style={{ ...mkTh(th, 'center'), width: 48 }}>VIX</th>
            <th style={{ ...mkTh(th, 'right'), width: 50 }}>Days</th>
            <th style={mkTh(th, 'left')}>Median H-L Range</th>
            <th style={{ ...mkTh(th, 'right'), width: 60 }}>90th</th>
            <th style={{ ...mkTh(th, 'right'), width: 50 }}>{'>'}2%</th>
          </tr>
        </thead>
        <tbody>
          {FINE_VIX_STATS.map((s, i) => {
            const isActive = s.vix === activeVix;
            const barWidth = (s.medHL / maxP90) * 100;
            const p90BarWidth = (s.p90HL / maxP90) * 100;
            const barColor = s.vix < 18 ? th.accent : s.vix < 25 ? '#E8A317' : th.red;
            return (
              <tr key={s.vix} style={{
                backgroundColor: isActive
                  ? (barColor + '10')
                  : (i % 2 === 1 ? th.tableRowAlt : th.surface),
                borderLeft: isActive ? ('3px solid ' + barColor) : '3px solid transparent',
              }}>
                <td style={{ ...mkTd(th), textAlign: 'center', fontWeight: isActive ? 700 : 500, color: isActive ? barColor : th.text }}>
                  {s.vix}
                </td>
                <td style={{ ...mkTd(th), textAlign: 'right', color: th.textMuted, fontSize: 11 }}>
                  {s.count}
                </td>
                <td style={{ ...mkTd(th), padding: '8px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ flex: 1, position: 'relative', height: 16, backgroundColor: th.surfaceAlt, borderRadius: 4, overflow: 'hidden' }}>
                      {/* 90th percentile ghost bar */}
                      <div style={{
                        position: 'absolute', top: 0, left: 0,
                        height: '100%', width: p90BarWidth + '%',
                        backgroundColor: barColor + '15', borderRadius: 4,
                      }} />
                      {/* Median bar */}
                      <div style={{
                        position: 'absolute', top: 2, left: 0,
                        height: 12, width: barWidth + '%',
                        backgroundColor: barColor,
                        borderRadius: 3,
                        transition: 'width 0.2s',
                      }} />
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600, minWidth: 42, textAlign: 'right', color: th.text }}>
                      {s.medHL.toFixed(2)}%
                    </span>
                  </div>
                  {spot != null && (
                    <div style={{ fontSize: 10, color: th.textMuted, marginTop: 2 }}>
                      {'\u2248'}{Math.round(s.medHL / 100 * spot)} pts median, {Math.round(s.p90HL / 100 * spot)} pts 90th
                    </div>
                  )}
                </td>
                <td style={{ ...mkTd(th), textAlign: 'right', color: th.red, fontSize: 11 }}>
                  {s.p90HL.toFixed(2)}%
                </td>
                <td style={{ ...mkTd(th), textAlign: 'right', color: s.over2 > 15 ? th.red : th.textSecondary, fontWeight: s.over2 > 15 ? 600 : 400, fontSize: 11 }}>
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