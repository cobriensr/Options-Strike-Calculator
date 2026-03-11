import { useState } from 'react';
import type { Theme } from '../themes';
import type { DeltaRow, IronCondorLegs, CalculationResults } from '../types';
import { buildIronCondor } from '../utils/calculator';
import { exportPnLComparison } from '../utils/exportXlsx';
import { mkTh, mkTd, fmtDollar } from './ui';
import HedgeSection from './HedgeSection';

interface Props {
  th: Theme;
  results: CalculationResults;
  wingWidth: number;
  contracts: number;
  effectiveRatio: number;
  skewPct: number;
}

export default function IronCondorSection({ th, results, wingWidth, contracts, effectiveRatio, skewPct }: Props) {
  const [showHedge, setShowHedge] = useState(false);
  const [hedgeDeltaIdx, setHedgeDeltaIdx] = useState(0);

  const icRows = results.allDeltas
    .filter((row): row is DeltaRow => !('error' in row))
    .map((r) => buildIronCondor(r, wingWidth, results.spot, results.T, effectiveRatio));

  // For hedge: use the selected IC row (default to first / lowest delta = most conservative)
  const hedgeIc = icRows[hedgeDeltaIdx] ?? icRows[0];

  return (
    <div className="mt-4.5">
      <div className="font-sans text-[11px] font-bold uppercase tracking-[0.14em] text-accent mb-2.5">
        Iron Condor ({wingWidth}-pt wings)
      </div>

      {/* Legs Table */}
      <LegsTable icRows={icRows} />

      {/* P&L Profile Table */}
      <PnLProfileTable th={th} icRows={icRows} contracts={contracts} effectiveRatio={effectiveRatio} />

      <p className="text-[11px] text-muted mt-2 italic">
        All dollar values: SPX $100 multiplier {'\u00D7'} {contracts} contract{contracts === 1 ? '' : 's'}. Put spread = sell short put / buy long put. Call spread = sell short call / buy long call. Iron Condor = both spreads combined. Individual spread PoP is single-tail (higher than IC). IC PoP = P(price between both BEs), not the product of spread PoPs. Premiums theoretical (r=0).
      </p>

      {/* Hedge Toggle */}
      <div className="mt-3.5 flex flex-wrap items-center gap-3">
        <button
          onClick={() => setShowHedge(!showHedge)}
          aria-pressed={showHedge}
          className={
            'py-2 px-4.5 rounded-lg border-[1.5px] cursor-pointer text-xs font-semibold font-sans ' +
            (showHedge
              ? 'border-accent bg-accent-bg text-accent'
              : 'border-edge-strong bg-chip-bg text-secondary')
          }
        >
          {showHedge ? '\u2713' : '\u26A1'} Hedge Calculator
        </button>

        {showHedge && icRows.length > 1 && (
          <div className="flex flex-wrap gap-1 items-center">
            <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-tertiary font-sans">
              IC Delta
            </span>
            {icRows.map((ic, idx) => (
              <button
                key={ic.delta}
                onClick={() => setHedgeDeltaIdx(idx)}
                role="radio"
                aria-checked={hedgeDeltaIdx === idx}
                className={
                  'px-2.5 py-0.5 rounded-full text-xs font-medium cursor-pointer border-[1.5px] font-mono transition-all duration-100 ' +
                  (hedgeDeltaIdx === idx
                    ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text'
                    : 'border-chip-border bg-chip-bg text-chip-text')
                }
              >
                {ic.delta}{'\u0394'}
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
        onClick={() => exportPnLComparison({ results, contracts, effectiveRatio, skewPct })}
        aria-label="Export P&L comparison to Excel"
        className="mt-3 w-full py-2.5 px-4 rounded-lg border-[1.5px] border-accent bg-accent-bg text-accent cursor-pointer text-[13px] font-semibold font-sans flex items-center justify-center gap-2"
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
    <div className="overflow-x-auto rounded-[10px] border border-edge">
      <table className="w-full border-collapse font-mono text-[13px]" role="table" aria-label="Iron condor legs by delta">
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
            <tr key={ic.delta} className={i % 2 === 1 ? 'bg-table-alt' : 'bg-surface'}>
              <td className={`${mkTd()} text-center font-bold text-accent`}>{ic.delta}{'\u0394'}</td>
              <td className={`${mkTd()} text-danger`}>{ic.longPut}</td>
              <td className={`${mkTd()} text-danger opacity-65`}>{ic.longPutSpy}</td>
              <td className={`${mkTd()} text-danger font-semibold`}>{ic.shortPut}</td>
              <td className={`${mkTd()} text-danger font-semibold opacity-65`}>{ic.shortPutSpy}</td>
              <td className={`${mkTd()} text-success font-semibold`}>{ic.shortCall}</td>
              <td className={`${mkTd()} text-success font-semibold opacity-65`}>{ic.shortCallSpy}</td>
              <td className={`${mkTd()} text-success`}>{ic.longCall}</td>
              <td className={`${mkTd()} text-success opacity-65`}>{ic.longCallSpy}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PnLProfileTable({ th, icRows, contracts, effectiveRatio }: {
  th: Theme; icRows: IronCondorLegs[]; contracts: number; effectiveRatio: number;
}) {
  return (
    <>
      <div className="font-sans text-[11px] font-bold uppercase tracking-[0.14em] text-accent mt-4 mb-2.5">
        P&L Profile {'\u2014'} {contracts} contract{contracts === 1 ? '' : 's'} (theoretical)
      </div>
      <div className="overflow-x-auto rounded-[10px] border border-edge">
        <table className="w-full border-collapse font-mono text-[13px]" role="table" aria-label="Iron condor P&L by delta">
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
                  spyBe: Math.round(ic.callSpreadBE / effectiveRatio).toString(),
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
                  be: ic.breakEvenLow.toFixed(0) + '\u2013' + ic.breakEvenHigh.toFixed(0),
                  spyBe: Math.round(ic.breakEvenLow / effectiveRatio) + '\u2013' + Math.round(ic.breakEvenHigh / effectiveRatio),
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
                      className={`${mkTd()} text-center font-bold text-accent align-middle`}
                      style={{ borderBottom: borderStyle }}
                    >
                      {ic.delta}{'\u0394'}
                    </td>
                  )}
                  <td
                    className={`${mkTd()} ${r.isLast ? 'font-bold text-[13px]' : 'font-medium text-xs'}`}
                    style={{
                      color: r.sideColor,
                      borderBottom: r.isLast ? borderStyle : '1px solid var(--th-border)',
                    }}
                  >
                    {r.side}
                  </td>
                  <td
                    className={`${mkTd()} text-right text-success ${r.isLast ? 'font-bold' : 'font-medium'}`}
                    style={{ borderBottom: r.isLast ? borderStyle : '1px solid var(--th-border)' }}
                  >
                    {'$' + fmtDollar(r.credit * mult)}
                    <div className="text-[10px] text-muted font-normal">{r.credit.toFixed(2)} pts</div>
                  </td>
                  <td
                    className={`${mkTd()} text-right text-danger ${r.isLast ? 'font-bold' : 'font-medium'}`}
                    style={{ borderBottom: r.isLast ? borderStyle : '1px solid var(--th-border)' }}
                  >
                    {'$' + fmtDollar(r.maxLoss * mult)}
                    <div className="text-[10px] text-muted font-normal">{r.maxLoss.toFixed(2)} pts</div>
                  </td>
                  <td
                    className={`${mkTd()} text-right text-primary ${r.isLast ? 'font-bold' : 'font-medium'}`}
                    style={{ borderBottom: r.isLast ? borderStyle : '1px solid var(--th-border)' }}
                  >
                    {'$' + fmtDollar(r.maxLoss * mult)}
                  </td>
                  <td
                    className={`${mkTd()} text-right text-accent ${r.isLast ? 'font-bold' : 'font-semibold'}`}
                    style={{ borderBottom: r.isLast ? borderStyle : '1px solid var(--th-border)' }}
                  >
                    {(r.ror * 100).toFixed(1)}%
                  </td>
                  <td
                    className={`${mkTd()} text-right text-success ${r.isLast ? 'font-bold' : 'font-semibold'}`}
                    style={{ borderBottom: r.isLast ? borderStyle : '1px solid var(--th-border)' }}
                  >
                    {(r.pop * 100).toFixed(1)}%
                  </td>
                  <td
                    className={`${mkTd()} text-right text-secondary`}
                    style={{ borderBottom: r.isLast ? borderStyle : '1px solid var(--th-border)' }}
                  >
                    {r.be}
                  </td>
                  <td
                    className={`${mkTd()} text-right text-secondary opacity-75`}
                    style={{ borderBottom: r.isLast ? borderStyle : '1px solid var(--th-border)' }}
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
