import { useState, useCallback } from 'react';
import type { DeltaRow, CalculationResults } from '../../types';
import { buildPutBWB, buildCallBWB } from '../../utils/calculator';
import BWBLegsTable from './BWBLegsTable';
import BWBPnLProfileTable from './BWBPnLProfileTable';

interface Props {
  results: CalculationResults;
  narrowWidth: number;
  wideMultiplier: number;
  contracts: number;
  effectiveRatio: number;
}

export default function BWBSection({
  results,
  narrowWidth,
  wideMultiplier,
  contracts,
  effectiveRatio,
}: Readonly<Props>) {
  const wideWidth = narrowWidth * wideMultiplier;

  const validRows = results.allDeltas.filter(
    (row): row is DeltaRow => !('error' in row),
  );

  const putRows = validRows.map((r) =>
    buildPutBWB(
      r,
      narrowWidth,
      wideWidth,
      results.spot,
      results.T,
      effectiveRatio,
      results.vix,
    ),
  );

  const callRows = validRows.map((r) =>
    buildCallBWB(
      r,
      narrowWidth,
      wideWidth,
      results.spot,
      results.T,
      effectiveRatio,
      results.vix,
    ),
  );

  const [collapsed, setCollapsed] = useState(false);
  const toggleCollapse = useCallback(() => setCollapsed((v) => !v), []);

  return (
    <div className="mt-4.5">
      <div
        className={
          (collapsed ? '' : 'mb-2.5 ') +
          'text-accent flex cursor-pointer items-center gap-2 font-sans text-[11px] font-bold tracking-[0.14em] uppercase select-none'
        }
        onClick={toggleCollapse}
        role="button"
        tabIndex={0}
        aria-label={`Toggle Broken Wing Butterfly (${narrowWidth}/${wideWidth}-pt wings)`}
        aria-expanded={!collapsed}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleCollapse();
          }
        }}
      >
        <span
          className="text-muted text-[12px] transition-transform duration-200"
          style={{
            transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
          }}
          aria-hidden="true"
        >
          &#x25BE;
        </span>
        Broken Wing Butterfly ({narrowWidth}/{wideWidth}-pt wings)
      </div>

      {!collapsed && (
        <>
          {/* Legs Table */}
          <BWBLegsTable putRows={putRows} callRows={callRows} />

          {/* P&L Profile Table */}
          <BWBPnLProfileTable
            putRows={putRows}
            callRows={callRows}
            contracts={contracts}
            effectiveRatio={effectiveRatio}
          />

          <p className="text-muted mt-2 text-[11px] italic">
            All dollar values: SPX $100 multiplier {'\u00D7'} {contracts}{' '}
            contract
            {contracts === 1 ? '' : 's'}. Put BWB = sell 2{'\u00D7'} short put,
            buy long near put + long far put. Call BWB = sell 2{'\u00D7'} short
            call, buy long near call + long far call. Sweet spot = max profit at
            the short strike. Premiums theoretical (r=0).
          </p>

          {/* Export Button */}
          <button
            onClick={() =>
              import('../../utils/export')
                .then(({ exportBWBComparison }) =>
                  exportBWBComparison({
                    results,
                    contracts,
                    effectiveRatio,
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
            aria-label="Export All BWB Widths to Excel"
            className="border-accent bg-accent-bg text-accent mt-3 flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-[1.5px] px-4 py-2.5 font-sans text-[13px] font-semibold"
          >
            {'\u2913'} Export All BWB Widths to Excel
          </button>
        </>
      )}
    </div>
  );
}
