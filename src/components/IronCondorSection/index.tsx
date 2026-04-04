import { useState } from 'react';
import type { DeltaRow, CalculationResults } from '../../types';
import { buildIronCondor } from '../../utils/calculator';
import HedgeSection from '../HedgeSection';
import LegsTable from './LegsTable';
import PnLProfileTable from './PnLProfileTable';

interface Props {
  results: CalculationResults;
  wingWidth: number;
  contracts: number;
  effectiveRatio: number;
  skewPct: number;
}

export default function IronCondorSection({
  results,
  wingWidth,
  contracts,
  effectiveRatio,
  skewPct,
}: Readonly<Props>) {
  const [hedgeDeltaIdx, setHedgeDeltaIdx] = useState(0);

  const icRows = results.allDeltas
    .filter((row): row is DeltaRow => !('error' in row))
    .map((r) =>
      buildIronCondor(
        r,
        wingWidth,
        results.spot,
        results.T,
        effectiveRatio,
        results.vix,
      ),
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

      {/* Hedge Section — always visible */}
      {hedgeIc && (
        <HedgeSection
          results={results}
          ic={hedgeIc}
          contracts={contracts}
          skew={skewPct / 100}
          icRows={icRows}
          hedgeDeltaIdx={hedgeDeltaIdx}
          onHedgeDeltaChange={setHedgeDeltaIdx}
        />
      )}

      {/* Export Button */}
      <button
        onClick={() =>
          import('../../utils/export')
            .then(({ exportPnLComparison }) =>
              exportPnLComparison({
                results,
                contracts,
                effectiveRatio,
                skewPct,
              }),
            )
            .catch(() => {
              if (
                confirm(
                  'A new version is available. Reload to use the export feature?',
                )
              ) {
                globalThis.location.reload();
              }
            })
        }
        aria-label="Export All Wing Widths to Excel"
        className="border-accent bg-accent-bg text-accent mt-3 flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-[1.5px] px-4 py-2.5 font-sans text-[13px] font-semibold"
      >
        {'\u2913'} Export All Wing Widths to Excel
      </button>
    </div>
  );
}
