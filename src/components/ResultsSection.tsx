import type { CalculationResults } from '../types';
import { DEFAULTS } from '../constants';
import ParameterSummary from './ParameterSummary';
import DeltaStrikesTable from './DeltaStrikesTable';
import IronCondorSection from './IronCondorSection';

interface Props {
  results: CalculationResults | null;
  effectiveRatio: number;
  spxDirectActive: boolean;
  showIC: boolean;
  wingWidth: number;
  contracts: number;
  skewPct: number;
}

export default function ResultsSection({
  results,
  effectiveRatio,
  spxDirectActive,
  showIC,
  wingWidth,
  contracts,
  skewPct,
}: Props) {
  return (
    <div id="results" tabIndex={-1} className="mt-6">
      {results ? (
        <section
          aria-label="Strike results for all deltas"
          className="animate-fade-in-up bg-surface border-edge-heavy border-t-accent rounded-[14px] border-2 border-t-[3px] p-[24px_20px] shadow-[0_4px_12px_rgba(0,0,0,0.08),0_12px_32px_rgba(0,0,0,0.06)]"
        >
          <div className="text-accent mb-[18px] font-sans text-[13px] font-bold tracking-[0.12em] uppercase">
            All Delta Strikes
          </div>

          <ParameterSummary
            spySpot={(results.spot / effectiveRatio).toFixed(2)}
            spxLabel={
              'SPX (\u00D7' +
              effectiveRatio.toFixed(spxDirectActive ? 4 : 2) +
              ')'
            }
            spxValue={results.spot.toFixed(0)}
            sigma={(results.sigma * 100).toFixed(2) + '%'}
            T={results.T.toFixed(6)}
            hoursLeft={results.hoursRemaining.toFixed(2) + 'h'}
          />

          <DeltaStrikesTable
            allDeltas={results.allDeltas}
            spot={results.spot}
          />

          {showIC && (
            <IronCondorSection
              results={results}
              wingWidth={wingWidth}
              contracts={contracts}
              effectiveRatio={effectiveRatio}
              skewPct={skewPct}
            />
          )}

          <p className="text-tertiary mt-3.5 text-xs leading-[1.7]">
            {skewPct > 0
              ? 'Put skew: +' +
                skewPct +
                '% IV on puts, \u2212' +
                skewPct +
                '% on calls. '
              : ''}
            Accuracy {'\u00B1'}5{'\u2013'}15 SPX points. Snapped: SPX nearest{' '}
            {DEFAULTS.STRIKE_INCREMENT}-pt, SPY nearest $1. Ratio:{' '}
            {effectiveRatio.toFixed(spxDirectActive ? 4 : 2)}
            {spxDirectActive ? ' (derived)' : ''}.
          </p>
        </section>
      ) : (
        <div className="animate-fade-in-up border-edge-strong bg-surface rounded-[14px] border-2 border-dashed px-8 py-12 text-center">
          <div className="text-muted mb-2 text-[28px]">{'\u2193'}</div>
          <div className="text-accent mb-2 font-sans text-[13px] font-bold tracking-[0.12em] uppercase">
            Strike Results
          </div>
          <p className="text-secondary m-0 mb-6 text-[15px]">
            Fill in the inputs above to calculate strike placement
          </p>
          <div className="text-secondary mx-auto inline-flex flex-col gap-3 text-left font-sans text-[13px]">
            <div className="flex items-center gap-3">
              <span className="bg-accent-bg text-accent flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-[12px] font-bold">
                1
              </span>
              <span>Select date</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="bg-accent-bg text-accent flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-[12px] font-bold">
                2
              </span>
              <span>Enter SPY spot price</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="bg-accent-bg text-accent flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-[12px] font-bold">
                3
              </span>
              <span>
                Enter SPX spot price{' '}
                <span className="text-muted">(optional)</span> or set SPX/SPY
                ratio
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="bg-accent-bg text-accent flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-[12px] font-bold">
                4
              </span>
              <span>Set entry time</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="bg-accent-bg text-accent flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-[12px] font-bold">
                5
              </span>
              <span>Set VIX or direct IV</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="bg-accent-bg text-accent flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-[12px] font-bold">
                6
              </span>
              <span>Enter VIX1D and VIX9D</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
