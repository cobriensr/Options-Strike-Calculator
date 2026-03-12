import type { Theme } from '../themes';
import type { CalculationResults } from '../types';
import { DEFAULTS } from '../constants';
import ParameterSummary from './ParameterSummary';
import DeltaStrikesTable from './DeltaStrikesTable';
import IronCondorSection from './IronCondorSection';

interface Props {
  th: Theme;
  results: CalculationResults | null;
  effectiveRatio: number;
  spxDirectActive: boolean;
  showIC: boolean;
  wingWidth: number;
  contracts: number;
  skewPct: number;
}

export default function ResultsSection({
  th,
  results,
  effectiveRatio,
  spxDirectActive,
  showIC,
  wingWidth,
  contracts,
  skewPct,
}: Props) {
  return (
    <div id="results" tabIndex={-1} className="mt-1">
      {results ? (
        <section
          aria-label="Strike results for all deltas"
          className="bg-surface border-edge-heavy rounded-[14px] border-2 p-[24px_20px] shadow-[0_2px_8px_rgba(0,0,0,0.05),0_8px_24px_rgba(0,0,0,0.04)]"
        >
          <div className="text-accent mb-[18px] font-sans text-xs font-bold tracking-[0.16em] uppercase">
            All Delta Strikes
          </div>

          <ParameterSummary
            th={th}
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
            th={th}
            allDeltas={results.allDeltas}
            spot={results.spot}
          />

          {showIC && (
            <IronCondorSection
              th={th}
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
        <div className="border-edge-strong bg-surface rounded-[14px] border-2 border-dashed p-10 text-center">
          <p className="text-muted m-0 text-[15px]">
            Enter SPY spot price, time, and IV to see all delta strikes
          </p>
        </div>
      )}
    </div>
  );
}
