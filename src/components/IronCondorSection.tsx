import { useState } from 'react';
import type { Theme } from '../themes';
import type { DeltaRow, IronCondorLegs, CalculationResults } from '../types';
import { buildIronCondor } from '../utils/calculator';
import { exportPnLComparison } from '../utils/exportXlsx';
import { mkTh, mkTd, fmtDollar } from '../utils/ui-utils';
import HedgeSection from './HedgeSection';

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
          exportPnLComparison({ results, contracts, effectiveRatio, skewPct })
        }
        aria-label="Export P&L comparison to Excel"
        className="border-accent bg-accent-bg text-accent mt-3 flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-[1.5px] px-4 py-2.5 font-sans text-[13px] font-semibold"
      >
        {'\u2913'} Export All Wing Widths to Excel
      </button>
    </div>
  );
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

function LegsTable({ icRows }: { th?: unknown; icRows: IronCondorLegs[] }) {
  return (
    <div className="border-edge overflow-x-auto rounded-[10px] border">
      <table
        className="w-full border-collapse font-mono text-[13px]"
        role="table"
        aria-label="Iron condor legs by delta"
      >
        <thead>
          <tr className="bg-table-header">
            <th className={mkTh('center')}>Delta</th>
            <th className={mkTh('left', 'text-danger')}>Long Put</th>
            <th className={mkTh('left', 'text-danger')}>SPY</th>
            <th className={mkTh('left', 'text-danger')}>Short Put</th>
            <th className={mkTh('left', 'text-danger')}>SPY</th>
            <th className={mkTh('left', 'text-success')}>Short Call</th>
            <th className={mkTh('left', 'text-success')}>SPY</th>
            <th className={mkTh('left', 'text-success')}>Long Call</th>
            <th className={mkTh('left', 'text-success')}>SPY</th>
          </tr>
        </thead>
        <tbody>
          {icRows.map((ic, i) => (
            <tr
              key={ic.delta}
              className={i % 2 === 1 ? 'bg-table-alt' : 'bg-surface'}
            >
              <td className={`${mkTd()} text-accent text-center font-bold`}>
                {ic.delta}
                {'\u0394'}
              </td>
              <td className={`${mkTd()} text-danger`}>{ic.longPut}</td>
              <td className={`${mkTd()} text-danger opacity-65`}>
                {ic.longPutSpy}
              </td>
              <td className={`${mkTd()} text-danger font-semibold`}>
                {ic.shortPut}
              </td>
              <td className={`${mkTd()} text-danger font-semibold opacity-65`}>
                {ic.shortPutSpy}
              </td>
              <td className={`${mkTd()} text-success font-semibold`}>
                {ic.shortCall}
              </td>
              <td className={`${mkTd()} text-success font-semibold opacity-65`}>
                {ic.shortCallSpy}
              </td>
              <td className={`${mkTd()} text-success`}>{ic.longCall}</td>
              <td className={`${mkTd()} text-success opacity-65`}>
                {ic.longCallSpy}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PnLProfileTable({
  th,
  icRows,
  contracts,
  effectiveRatio,
}: {
  th: Theme;
  icRows: IronCondorLegs[];
  contracts: number;
  effectiveRatio: number;
}) {
  return (
    <>
      <div className="text-accent mt-4 mb-2.5 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
        P&L Profile {'\u2014'} {contracts} contract{contracts === 1 ? '' : 's'}{' '}
        (theoretical)
      </div>
      <div className="border-edge overflow-x-auto rounded-[10px] border">
        <table
          className="w-full border-collapse font-mono text-[13px]"
          role="table"
          aria-label="Iron condor P&L by delta"
        >
          <thead>
            <tr className="bg-table-header">
              <th className={mkTh('center')}>Delta</th>
              <th className={mkTh('left')}>Side</th>
              <th className={mkTh('right')}>Credit</th>
              <th className={mkTh('right')}>Max Loss</th>
              <th className={mkTh('right')}>Buying Pwr</th>
              <th className={mkTh('right')}>RoR</th>
              <th className={mkTh('right')}>PoP</th>
              <th className={mkTh('right')}>SPX BE</th>
              <th className={mkTh('right')}>SPY BE</th>
            </tr>
          </thead>
          <tbody>
            {icRows.map((ic, i) => {
              const mult = 100 * contracts;
              const groupBg = i % 2 === 1 ? 'bg-table-alt' : 'bg-surface';
              const borderStyle = '2px solid var(--th-border)';

              const rows = [
                {
                  key: ic.delta + '-put',
                  side: 'Put Spread',
                  sideColor: th.red,
                  credit: ic.putSpreadCredit,
                  maxLoss: ic.putSpreadMaxLoss,
                  ror: ic.putSpreadRoR,
                  pop: ic.putSpreadPoP,
                  be: ic.putSpreadBE.toFixed(0),
                  spyBe: Math.round(ic.putSpreadBE / effectiveRatio).toString(),
                  isFirst: true,
                  isLast: false,
                },
                {
                  key: ic.delta + '-call',
                  side: 'Call Spread',
                  sideColor: th.green,
                  credit: ic.callSpreadCredit,
                  maxLoss: ic.callSpreadMaxLoss,
                  ror: ic.callSpreadRoR,
                  pop: ic.callSpreadPoP,
                  be: ic.callSpreadBE.toFixed(0),
                  spyBe: Math.round(
                    ic.callSpreadBE / effectiveRatio,
                  ).toString(),
                  isFirst: false,
                  isLast: false,
                },
                {
                  key: ic.delta + '-ic',
                  side: 'Iron Condor',
                  sideColor: th.accent,
                  credit: ic.creditReceived,
                  maxLoss: ic.maxLoss,
                  ror: ic.returnOnRisk,
                  pop: ic.probabilityOfProfit,
                  be:
                    ic.breakEvenLow.toFixed(0) +
                    '\u2013' +
                    ic.breakEvenHigh.toFixed(0),
                  spyBe:
                    Math.round(ic.breakEvenLow / effectiveRatio) +
                    '\u2013' +
                    Math.round(ic.breakEvenHigh / effectiveRatio),
                  isFirst: false,
                  isLast: true,
                },
              ];

              return rows.map((r) => (
                <tr
                  key={r.key}
                  className={groupBg}
                  style={{ borderBottom: r.isLast ? borderStyle : undefined }}
                >
                  {r.isFirst && (
                    <td
                      rowSpan={3}
                      className={`${mkTd()} text-accent text-center align-middle font-bold`}
                      style={{ borderBottom: borderStyle }}
                    >
                      {ic.delta}
                      {'\u0394'}
                    </td>
                  )}
                  <td
                    className={`${mkTd()} ${r.isLast ? 'text-[13px] font-bold' : 'text-xs font-medium'}`}
                    style={{
                      color: r.sideColor,
                      borderBottom: r.isLast
                        ? borderStyle
                        : '1px solid var(--th-border)',
                    }}
                  >
                    {r.side}
                  </td>
                  <td
                    className={`${mkTd()} text-success text-right ${r.isLast ? 'font-bold' : 'font-medium'}`}
                    style={{
                      borderBottom: r.isLast
                        ? borderStyle
                        : '1px solid var(--th-border)',
                    }}
                  >
                    {'$' + fmtDollar(r.credit * mult)}
                    <div className="text-muted text-[10px] font-normal">
                      {r.credit.toFixed(2)} pts
                    </div>
                  </td>
                  <td
                    className={`${mkTd()} text-danger text-right ${r.isLast ? 'font-bold' : 'font-medium'}`}
                    style={{
                      borderBottom: r.isLast
                        ? borderStyle
                        : '1px solid var(--th-border)',
                    }}
                  >
                    {'$' + fmtDollar(r.maxLoss * mult)}
                    <div className="text-muted text-[10px] font-normal">
                      {r.maxLoss.toFixed(2)} pts
                    </div>
                  </td>
                  <td
                    className={`${mkTd()} text-primary text-right ${r.isLast ? 'font-bold' : 'font-medium'}`}
                    style={{
                      borderBottom: r.isLast
                        ? borderStyle
                        : '1px solid var(--th-border)',
                    }}
                  >
                    {'$' + fmtDollar(r.maxLoss * mult)}
                  </td>
                  <td
                    className={`${mkTd()} text-accent text-right ${r.isLast ? 'font-bold' : 'font-semibold'}`}
                    style={{
                      borderBottom: r.isLast
                        ? borderStyle
                        : '1px solid var(--th-border)',
                    }}
                  >
                    {(r.ror * 100).toFixed(1)}%
                  </td>
                  <td
                    className={`${mkTd()} text-success text-right ${r.isLast ? 'font-bold' : 'font-semibold'}`}
                    style={{
                      borderBottom: r.isLast
                        ? borderStyle
                        : '1px solid var(--th-border)',
                    }}
                  >
                    {(r.pop * 100).toFixed(1)}%
                  </td>
                  <td
                    className={`${mkTd()} text-secondary text-right`}
                    style={{
                      borderBottom: r.isLast
                        ? borderStyle
                        : '1px solid var(--th-border)',
                    }}
                  >
                    {r.be}
                  </td>
                  <td
                    className={`${mkTd()} text-secondary text-right opacity-75`}
                    style={{
                      borderBottom: r.isLast
                        ? borderStyle
                        : '1px solid var(--th-border)',
                    }}
                  >
                    {r.spyBe}
                  </td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
