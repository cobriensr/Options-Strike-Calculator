import { useState } from 'react';
import type { Theme } from '../themes';
import type { IronCondorLegs, CalculationResults, HedgeDelta, HedgeScenario } from '../types';
import { calcHedge } from '../utils/calculator';
import { HEDGE_DELTA_OPTIONS } from '../constants';
import { mkTh, mkTd, fmtDollar } from './ui';

interface Props {
  th: Theme;
  results: CalculationResults;
  ic: IronCondorLegs;
  contracts: number;
  skew: number;
}

export default function HedgeSection({ th, results, ic, contracts, skew }: Props) {
  const [hedgeDelta, setHedgeDelta] = useState<HedgeDelta>(2);
  const [showScenarios, setShowScenarios] = useState(false);

  const hedge = calcHedge({
    spot: results.spot,
    sigma: results.sigma,
    T: results.T,
    skew,
    icContracts: contracts,
    icCreditPts: ic.creditReceived,
    icMaxLossPts: ic.maxLoss,
    icShortPut: ic.shortPut,
    icLongPut: ic.longPut,
    icShortCall: ic.shortCall,
    icLongCall: ic.longCall,
    hedgeDelta,
  });

  const crashScenarios = hedge.scenarios.filter((s) => s.direction === 'crash');
  const rallyScenarios = hedge.scenarios.filter((s) => s.direction === 'rally');

  return (
    <div className="mt-4.5">
      <div className="flex items-center justify-between mb-3">
        <div className="font-sans text-[11px] font-bold uppercase tracking-[0.14em] text-accent">
          Hedge Calculator (Reinsurance)
        </div>
        <div className="flex gap-1 items-center">
          <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-tertiary font-sans mr-1">
            Hedge {'\u0394'}
          </span>
          {HEDGE_DELTA_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setHedgeDelta(d)}
              role="radio"
              aria-checked={hedgeDelta === d}
              className={
                'px-2.5 py-0.5 rounded-full text-xs font-medium cursor-pointer border-[1.5px] font-mono transition-all duration-100 ' +
                (hedgeDelta === d
                  ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text'
                  : 'border-chip-border bg-chip-bg text-chip-text')
              }
            >
              {d}{'\u0394'}
            </button>
          ))}
        </div>
      </div>

      {/* Recommendation Summary */}
      <div className="bg-surface-alt rounded-[10px] p-4 border border-edge mb-3">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* Put Hedge */}
          <div className="md:border-r md:border-edge md:pr-4">
            <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-danger font-sans mb-2">
              Put Hedge (Crash Protection)
            </div>
            <div className="grid grid-cols-2 gap-2">
              <StatBox label="Buy Puts" value={String(hedge.recommendedPuts)} accent={th.red} large />
              <StatBox label="Strike" value={String(hedge.putStrikeSnapped)} />
              <StatBox label="Premium" value={hedge.putPremium.toFixed(2) + ' pts'} />
              <StatBox label="Cost" value={'$' + fmtDollar(hedge.putPremium * 100 * hedge.recommendedPuts)} />
            </div>
            <div className="text-[10px] text-muted mt-1.5 font-mono">
              Breakeven at {'\u2193'}{hedge.breakEvenCrashPts} pts ({(hedge.breakEvenCrashPts / results.spot * 100).toFixed(1)}%)
            </div>
          </div>

          {/* Call Hedge */}
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-success font-sans mb-2">
              Call Hedge (Rally Protection)
            </div>
            <div className="grid grid-cols-2 gap-2">
              <StatBox label="Buy Calls" value={String(hedge.recommendedCalls)} accent={th.green} large />
              <StatBox label="Strike" value={String(hedge.callStrikeSnapped)} />
              <StatBox label="Premium" value={hedge.callPremium.toFixed(2) + ' pts'} />
              <StatBox label="Cost" value={'$' + fmtDollar(hedge.callPremium * 100 * hedge.recommendedCalls)} />
            </div>
            <div className="text-[10px] text-muted mt-1.5 font-mono">
              Breakeven at {'\u2191'}{hedge.breakEvenRallyPts} pts ({(hedge.breakEvenRallyPts / results.spot * 100).toFixed(1)}%)
            </div>
          </div>
        </div>

        {/* Total Summary */}
        <div className="mt-3 pt-3 border-t border-edge grid grid-cols-2 gap-2 md:grid-cols-4">
          <StatBox label="Daily Hedge Cost" value={'$' + fmtDollar(hedge.dailyCostDollars)} accent={th.red} />
          <StatBox label="IC Credit" value={'$' + fmtDollar(ic.creditReceived * 100 * contracts)} accent={th.green} />
          <StatBox label="Net Credit After Hedge" value={'$' + fmtDollar(hedge.netCreditAfterHedge)} accent={hedge.netCreditAfterHedge > 0 ? th.green : th.red} />
          <StatBox label="Hedge % of Credit" value={(hedge.dailyCostDollars / (ic.creditReceived * 100 * contracts) * 100).toFixed(1) + '%'} />
        </div>
      </div>

      {/* Scenario Toggle */}
      <button
        onClick={() => setShowScenarios(!showScenarios)}
        className="w-full py-2 px-3.5 rounded-lg border border-edge bg-chip-bg text-secondary cursor-pointer text-xs font-semibold font-sans flex items-center justify-center gap-1.5"
      >
        {showScenarios ? '\u25B2' : '\u25BC'} {showScenarios ? 'Hide' : 'Show'} P&L Scenario Table
      </button>

      {/* Scenario Table */}
      {showScenarios && (
        <div className="mt-3">
          {/* Crash Scenarios */}
          <div className="text-[10px] font-bold uppercase tracking-widest text-danger font-sans mb-1.5">
            Crash Scenarios (SPX drops)
          </div>
          <ScenarioTable th={th} scenarios={crashScenarios} spot={results.spot} direction="crash" />

          {/* Rally Scenarios */}
          <div className="text-[10px] font-bold uppercase tracking-widest text-success font-sans mt-3.5 mb-1.5">
            Rally Scenarios (SPX rises)
          </div>
          <ScenarioTable th={th} scenarios={rallyScenarios} spot={results.spot} direction="rally" />
        </div>
      )}

      <p className="text-[11px] text-muted mt-2 italic">
        Hedge sized for breakeven at 1.5{'\u00D7'} distance to hedge strike. Buy {hedge.recommendedPuts} put{hedge.recommendedPuts === 1 ? '' : 's'} + {hedge.recommendedCalls} call{hedge.recommendedCalls === 1 ? '' : 's'} as a 0DTE strangle at {hedgeDelta}{'\u0394'}. All values theoretical (Black-Scholes, r=0). Actual fill prices may differ.
      </p>
    </div>
  );
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

function StatBox({ label, value, accent, large }: {
  th?: unknown; label: string; value: string; accent?: string; large?: boolean;
}) {
  return (
    <div>
      <div className="text-[9px] font-bold uppercase tracking-[0.06em] text-tertiary font-sans">
        {label}
      </div>
      <div
        className={`font-mono mt-0.5 ${large ? 'text-[22px] font-extrabold' : 'text-sm font-semibold'}`}
        style={{ color: accent ?? 'var(--th-accent)' }}
      >
        {value}
      </div>
    </div>
  );
}

function ScenarioTable({ th, scenarios, spot, direction }: {
  th: Theme; scenarios: readonly HedgeScenario[]; spot: number; direction: 'crash' | 'rally';
}) {
  return (
    <div className="overflow-x-auto rounded-[10px] border border-edge">
      <table className="w-full border-collapse font-mono text-xs" role="table" aria-label={'Hedge P&L ' + direction + ' scenarios'}>
        <thead>
          <tr className="bg-table-header">
            <th className={mkTh('right')}>Move</th>
            <th className={mkTh('right')}>SPX</th>
            <th className={mkTh('right')}>IC P&L</th>
            <th className={mkTh('right', direction === 'crash' ? 'text-danger' : 'text-success')}>
              {direction === 'crash' ? 'Put' : 'Call'} Hedge
            </th>
            <th className={mkTh('right')}>Hedge Cost</th>
            <th className={mkTh('right')}>Net P&L</th>
          </tr>
        </thead>
        <tbody>
          {scenarios.map((s, i) => {
            const spxLevel = direction === 'crash' ? spot - s.movePoints : spot + s.movePoints;
            const hedgePayout = direction === 'crash' ? s.hedgePutPnL : s.hedgeCallPnL;
            return (
              <tr key={s.movePoints} className={i % 2 === 1 ? 'bg-table-alt' : 'bg-surface'}>
                <td className={`${mkTd()} text-right font-semibold`}>
                  {direction === 'crash' ? '\u2193' : '\u2191'}{s.movePoints} <span className="text-[10px] text-muted">({s.movePct}%)</span>
                </td>
                <td className={`${mkTd()} text-right text-secondary`}>
                  {Math.round(spxLevel)}
                </td>
                <td
                  className={`${mkTd()} text-right font-semibold`}
                  style={{ color: s.icPnL >= 0 ? th.green : th.red }}
                >
                  {s.icPnL >= 0 ? '+' : ''}{fmtDollar(s.icPnL)}
                </td>
                <td
                  className={`${mkTd()} text-right`}
                  style={{ color: hedgePayout > 0 ? th.green : th.textMuted }}
                >
                  {hedgePayout > 0 ? '+$' + fmtDollar(hedgePayout) : '$0'}
                </td>
                <td className={`${mkTd()} text-right text-danger text-[11px]`}>
                  {fmtDollar(s.hedgeCost)}
                </td>
                <td
                  className={`${mkTd()} text-right font-bold text-[13px]`}
                  style={{ color: s.netPnL >= 0 ? th.green : th.red }}
                >
                  {s.netPnL >= 0 ? '+' : ''}${fmtDollar(s.netPnL)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
