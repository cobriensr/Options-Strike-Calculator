import { useState } from 'react';
import type { Theme } from '../../themes';
import { Chip } from '../ui';
import { mkTh, mkTd, tint } from '../../utils/ui-utils';
import {
  VIX_BUCKETS,
  SURVIVAL_DATA,
  TOTAL_MATCHED_DAYS,
  findBucket,
} from '../../data/vixRangeStats';
import { zoneToColor, heatColor, heatBg } from './helpers';
import FineGrainedBars from './FineGrainedBars';

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
      <div className="text-accent mb-2.5 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
        Historical SPX Range by VIX Level
      </div>

      <section
        className="border-edge overflow-x-auto rounded-[10px] border"
        aria-label="SPX range by VIX level"
      >
        <table
          className="w-full border-collapse font-mono text-[13px]"
          role="table"
          aria-label="SPX daily range statistics by VIX level"
        >
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
                  className={
                    isActive
                      ? 'border-l-[3px]'
                      : `border-l-[3px] border-transparent ${i % 2 === 1 ? 'bg-table-alt' : 'bg-surface'}`
                  }
                  style={
                    isActive
                      ? {
                          backgroundColor: tint(zoneColor, '14'),
                          borderLeftColor: zoneColor,
                        }
                      : undefined
                  }
                >
                  <td
                    className={`${mkTd()} font-semibold`}
                    style={{ color: zoneColor }}
                  >
                    {b.label}
                    {isActive && (
                      <span
                        className="ml-1.5 inline-block rounded-full px-1.5 py-px font-sans text-[10px] font-bold tracking-[0.06em] uppercase"
                        style={{
                          backgroundColor: tint(zoneColor, '22'),
                          color: zoneColor,
                        }}
                      >
                        current
                      </span>
                    )}
                  </td>
                  <td className={`${mkTd()} text-muted text-right`}>
                    {b.count.toLocaleString()}
                  </td>
                  <td className={`${mkTd()} text-right font-semibold`}>
                    {b.medHL.toFixed(2)}%
                    {spot != null && (
                      <span className="text-muted ml-1 text-[10px]">
                        ({Math.round((b.medHL / 100) * spot)})
                      </span>
                    )}
                  </td>
                  <td
                    className={`${mkTd()} text-danger text-right font-medium`}
                  >
                    {b.p90HL.toFixed(2)}%
                  </td>
                  <td
                    className={`${mkTd()} text-success text-right font-medium`}
                  >
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
      </section>

      <p className="text-muted mt-1.5 mb-4 text-[11px] italic">
        Based on {TOTAL_MATCHED_DAYS.toLocaleString()} trading days (1990
        {'\u2013'}2026). VIX open matched to same-day SPX OHLC. O{'\u2192'}C =
        settlement-relevant move.
      </p>

      {/* Survival Heatmap */}
      <div className="text-accent mb-2.5 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
        Iron Condor Survival Rate
      </div>

      <div
        className="mb-3 flex gap-1.5"
        role="radiogroup"
        aria-label="Survival mode"
      >
        <Chip
          active={survMode === 'settle'}
          onClick={() => setSurvMode('settle')}
          label={'Settlement (O\u2192C)'}
        />
        <Chip
          active={survMode === 'intraday'}
          onClick={() => setSurvMode('intraday')}
          label="Intraday (H-L)"
        />
      </div>

      <section
        className="border-edge overflow-x-auto rounded-[10px] border"
        aria-label="Iron condor survival rates"
      >
        <table
          className="w-full border-collapse font-mono text-[12px]"
          role="table"
          aria-label={'Iron condor survival rates (' + survMode + ')'}
        >
          <thead>
            <tr className="bg-table-header">
              <th className={mkTh('left')}>VIX Level</th>
              {SURVIVAL_DATA.map((s) => (
                <th key={s.wing} className={`${mkTh('center')} min-w-14`}>
                  {s.label}
                </th>
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
                  <td
                    className={`${mkTd()} font-semibold whitespace-nowrap`}
                    style={{ color: zoneColor }}
                  >
                    {b.label}
                  </td>
                  {SURVIVAL_DATA.map((s) => {
                    const val =
                      survMode === 'settle' ? s.settle[bi] : s.intraday[bi];
                    if (val === undefined)
                      return <td key={s.wing} className={mkTd()} />;
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
      </section>

      <p className="text-muted mt-1.5 text-[11px] italic">
        {survMode === 'settle'
          ? 'Settlement: % of days the closing price stayed within \u00B1X% of the open. Determines if your short strikes finish ITM.'
          : 'Intraday: % of days the full H-L range stayed within \u00B1X% of the open. Use for intraday defense triggers.'}
      </p>

      {/* Fine-grained toggle */}
      <button
        onClick={() => setShowFine(!showFine)}
        className="border-edge bg-input text-secondary mt-3.5 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-3.5 py-2 font-sans text-[12px] font-semibold"
      >
        {showFine ? '\u25B2' : '\u25BC'} {showFine ? 'Hide' : 'Show'}{' '}
        Point-by-Point VIX Breakdown (10{'\u2013'}30)
      </button>

      {showFine && (
        <div className="mt-3">
          <FineGrainedBars th={th} vix={vix} spot={spot} />
        </div>
      )}
    </div>
  );
}
