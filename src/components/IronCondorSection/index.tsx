import { useState } from 'react';
import type { Theme } from '../../themes';
import type { DeltaRow, CalculationResults } from '../../types';
import { buildIronCondor } from '../../utils/calculator';
import HedgeSection from '../HedgeSection';
import LegsTable from './LegsTable';
import PnLProfileTable from './PnLProfileTable';

interface Props {
  th: Theme;
  results: CalculationResults;
  wingWidth: number;
  contracts: number;
  effectiveRatio: number;
  skewPct: number;
}

export default function IronCondorSection({
  th,
  results,
  wingWidth,
  contracts,
  effectiveRatio,
  skewPct,
}: Props) {
  const [showHedge, setShowHedge] = useState(false);
  const [hedgeDeltaIdx, setHedgeDeltaIdx] = useState(0);

  const icRows = results.allDeltas
    .filter((row): row is DeltaRow => !('error' in row))
    .map((r) =>
      buildIronCondor(r, wingWidth, results.spot, results.T, effectiveRatio),
    );

  // For hedge: use the selected IC row (default to first / lowest delta = most conservative)
  const hedgeIc = icRows[hedgeDeltaIdx] ?? icRows[0];

  return (
    <div className="mt-4.5">
      <div className="text-accent mb-2.5 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
        Iron Condor ({wingWidth}-pt wings)
      </div>

      {/* Legs Table */}
      <LegsTable icRows={icRows} />

      {/* P&L Profile Table */}
      <PnLProfileTable
        th={th}
        icRows={icRows}
        contracts={contracts}
        effectiveRatio={effectiveRatio}
      />

      <p className="text-muted mt-2 text-[11px] italic">
        All dollar values: SPX $100 multiplier {'\u00D7'} {contracts} contract
        {contracts === 1 ? '' : 's'}. Put spread = sell short put / buy long
        put. Call spread = sell short call / buy long call. Iron Condor = both
        spreads combined. Individual spread PoP is single-tail (higher than IC).
        IC PoP = P(price between both BEs), not the product of spread PoPs.
        Premiums theoretical (r=0).
      </p>

      {/* Hedge Toggle */}
      <div className="mt-3.5 flex flex-wrap items-center gap-3">
        <button
          onClick={() => setShowHedge(!showHedge)}
          aria-pressed={showHedge}
          className={
            'cursor-pointer rounded-lg border-[1.5px] px-4.5 py-2 font-sans text-xs font-semibold ' +
            (showHedge
              ? 'border-accent bg-accent-bg text-accent'
              : 'border-edge-strong bg-chip-bg text-secondary')
          }
        >
          {showHedge ? '\u2713' : '\u26A1'} Hedge Calculator
        </button>

        {showHedge && icRows.length > 1 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
              IC Delta
            </span>
            {icRows.map((ic, idx) => (
              <button
                key={ic.delta}
                onClick={() => setHedgeDeltaIdx(idx)}
                role="radio"
                aria-checked={hedgeDeltaIdx === idx}
                className={
                  'cursor-pointer rounded-full border-[1.5px] px-2.5 py-0.5 font-mono text-xs font-medium transition-all duration-100 ' +
                  (hedgeDeltaIdx === idx
                    ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text'
                    : 'border-chip-border bg-chip-bg text-chip-text')
                }
              >
                {ic.delta}
                {'\u0394'}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Hedge Section */}
      {showHedge && hedgeIc && (
        <HedgeSection
          th={th}
          results={results}
          ic={hedgeIc}
          contracts={contracts}
          skew={skewPct / 100}
        />
      )}

      {/* Export Button */}
      <button
        onClick={() =>
          import('../../utils/exportXlsx').then(({ exportPnLComparison }) =>
            exportPnLComparison({
              results,
              contracts,
              effectiveRatio,
              skewPct,
            }),
          )
        }
        aria-label="Export P&L comparison to Excel"
        className="border-accent bg-accent-bg text-accent mt-3 flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-[1.5px] px-4 py-2.5 font-sans text-[13px] font-semibold"
      >
        {'\u2913'} Export All Wing Widths to Excel
      </button>
    </div>
  );
}
