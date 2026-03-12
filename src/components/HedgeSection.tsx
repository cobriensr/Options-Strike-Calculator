import { useState } from 'react';
import type { Theme } from '../themes';
import type {
  IronCondorLegs,
  CalculationResults,
  HedgeDelta,
  HedgeScenario,
} from '../types';
import { calcHedge } from '../utils/calculator';
import { HEDGE_DELTA_OPTIONS } from '../constants';
import { mkTh, mkTd, fmtDollar } from './ui-utils';

interface Props {
  th: Theme;
  results: CalculationResults;
  ic: IronCondorLegs;
  contracts: number;
  skew: number;
}

export default function HedgeSection({
  th,
  results,
  ic,
  contracts,
  skew,
}: Props) {
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
      <div className="mb-3 flex items-center justify-between">
        <div className="text-accent font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
          Hedge Calculator (Reinsurance)
        </div>
        <div className="flex items-center gap-1">
          <span className="text-tertiary mr-1 font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
            Hedge {'\u0394'}
          </span>
          {HEDGE_DELTA_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setHedgeDelta(d)}
              role="radio"
              aria-checked={hedgeDelta === d}
              className={
                'cursor-pointer rounded-full border-[1.5px] px-2.5 py-0.5 font-mono text-xs font-medium transition-all duration-100 ' +
                (hedgeDelta === d
                  ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text'
                  : 'border-chip-border bg-chip-bg text-chip-text')
              }
            >
              {d}
              {'\u0394'}
            </button>
          ))}
        </div>
      </div>

      {/* Recommendation Summary */}
      <div className="bg-surface-alt border-edge mb-3 rounded-[10px] border p-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* Put Hedge */}
          <div className="md:border-edge md:border-r md:pr-4">
            <div className="text-danger mb-2 font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
              Put Hedge (Crash Protection)
            </div>
            <div className="grid grid-cols-2 gap-2">
              <StatBox
                label="Buy Puts"
                value={String(hedge.recommendedPuts)}
                accent={th.red}
                large
              />
              <StatBox label="Strike" value={String(hedge.putStrikeSnapped)} />
              <StatBox
                label="Premium"
                value={hedge.putPremium.toFixed(2) + ' pts'}
              />
              <StatBox
                label="Cost"
                value={
                  '$' +
                  fmtDollar(hedge.putPremium * 100 * hedge.recommendedPuts)
                }
              />
            </div>
            <div className="text-muted mt-1.5 font-mono text-[10px]">
              Breakeven at {'\u2193'}
              {hedge.breakEvenCrashPts} pts (
              {((hedge.breakEvenCrashPts / results.spot) * 100).toFixed(1)}%)
            </div>
          </div>

          {/* Call Hedge */}
          <div>
            <div className="text-success mb-2 font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
              Call Hedge (Rally Protection)
            </div>
            <div className="grid grid-cols-2 gap-2">
              <StatBox
                label="Buy Calls"
                value={String(hedge.recommendedCalls)}
                accent={th.green}
                large
              />
              <StatBox label="Strike" value={String(hedge.callStrikeSnapped)} />
              <StatBox
                label="Premium"
                value={hedge.callPremium.toFixed(2) + ' pts'}
              />
              <StatBox
                label="Cost"
                value={
                  '$' +
                  fmtDollar(hedge.callPremium * 100 * hedge.recommendedCalls)
                }
              />
            </div>
            <div className="text-muted mt-1.5 font-mono text-[10px]">
              Breakeven at {'\u2191'}
              {hedge.breakEvenRallyPts} pts (
              {((hedge.breakEvenRallyPts / results.spot) * 100).toFixed(1)}%)
            </div>
          </div>
        </div>

        {/* Total Summary */}
        <div className="border-edge mt-3 grid grid-cols-2 gap-2 border-t pt-3 md:grid-cols-4">
          <StatBox
            label="Daily Hedge Cost"
            value={'$' + fmtDollar(hedge.dailyCostDollars)}
            accent={th.red}
          />
          <StatBox
            label="IC Credit"
            value={'$' + fmtDollar(ic.creditReceived * 100 * contracts)}
            accent={th.green}
          />
          <StatBox
            label="Net Credit After Hedge"
            value={'$' + fmtDollar(hedge.netCreditAfterHedge)}
            accent={hedge.netCreditAfterHedge > 0 ? th.green : th.red}
          />
          <StatBox
            label="Hedge % of Credit"
            value={
              (
                (hedge.dailyCostDollars /
                  (ic.creditReceived * 100 * contracts)) *
                100
              ).toFixed(1) + '%'
            }
          />
        </div>
      </div>

      {/* Scenario Toggle */}
      <button
        onClick={() => setShowScenarios(!showScenarios)}
        className="border-edge bg-chip-bg text-secondary flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-3.5 py-2 font-sans text-xs font-semibold"
      >
        {showScenarios ? '\u25B2' : '\u25BC'} {showScenarios ? 'Hide' : 'Show'}{' '}
        P&L Scenario Table
      </button>

      {/* Scenario Table */}
      {showScenarios && (
        <div className="mt-3">
          {/* Crash Scenarios */}
          <div className="text-danger mb-1.5 font-sans text-[10px] font-bold tracking-widest uppercase">
            Crash Scenarios (SPX drops)
          </div>
          <ScenarioTable
            th={th}
            scenarios={crashScenarios}
            spot={results.spot}
            direction="crash"
          />

          {/* Rally Scenarios */}
          <div className="text-success mt-3.5 mb-1.5 font-sans text-[10px] font-bold tracking-widest uppercase">
            Rally Scenarios (SPX rises)
          </div>
          <ScenarioTable
            th={th}
            scenarios={rallyScenarios}
            spot={results.spot}
            direction="rally"
          />
        </div>
      )}

      <p className="text-muted mt-2 text-[11px] italic">
        Hedge sized for breakeven at 1.5{'\u00D7'} distance to hedge strike. Buy{' '}
        {hedge.recommendedPuts} put{hedge.recommendedPuts === 1 ? '' : 's'} +{' '}
        {hedge.recommendedCalls} call{hedge.recommendedCalls === 1 ? '' : 's'}{' '}
        as a 0DTE strangle at {hedgeDelta}
        {'\u0394'}. All values theoretical (Black-Scholes, r=0). Actual fill
        prices may differ.
      </p>
    </div>
  );
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

function StatBox({
  label,
  value,
  accent,
  large,
}: {
  th?: unknown;
  label: string;
  value: string;
  accent?: string;
  large?: boolean;
}) {
  return (
    <div>
      <div className="text-tertiary font-sans text-[9px] font-bold tracking-[0.06em] uppercase">
        {label}
      </div>
      <div
        className={`mt-0.5 font-mono ${large ? 'text-[22px] font-extrabold' : 'text-sm font-semibold'}`}
        style={{ color: accent ?? 'var(--th-accent)' }}
      >
        {value}
      </div>
    </div>
  );
}

function ScenarioTable({
  th,
  scenarios,
  spot,
  direction,
}: {
  th: Theme;
  scenarios: readonly HedgeScenario[];
  spot: number;
  direction: 'crash' | 'rally';
}) {
  return (
    <div className="border-edge overflow-x-auto rounded-[10px] border">
      <table
        className="w-full border-collapse font-mono text-xs"
        role="table"
        aria-label={'Hedge P&L ' + direction + ' scenarios'}
      >
        <thead>
          <tr className="bg-table-header">
            <th className={mkTh('right')}>Move</th>
            <th className={mkTh('right')}>SPX</th>
            <th className={mkTh('right')}>IC P&L</th>
            <th
              className={mkTh(
                'right',
                direction === 'crash' ? 'text-danger' : 'text-success',
              )}
            >
              {direction === 'crash' ? 'Put' : 'Call'} Hedge
            </th>
            <th className={mkTh('right')}>Hedge Cost</th>
            <th className={mkTh('right')}>Net P&L</th>
          </tr>
        </thead>
        <tbody>
          {scenarios.map((s, i) => {
            const spxLevel =
              direction === 'crash' ? spot - s.movePoints : spot + s.movePoints;
            const hedgePayout =
              direction === 'crash' ? s.hedgePutPnL : s.hedgeCallPnL;
            return (
              <tr
                key={s.movePoints}
                className={i % 2 === 1 ? 'bg-table-alt' : 'bg-surface'}
              >
                <td className={`${mkTd()} text-right font-semibold`}>
                  {direction === 'crash' ? '\u2193' : '\u2191'}
                  {s.movePoints}{' '}
                  <span className="text-muted text-[10px]">({s.movePct}%)</span>
                </td>
                <td className={`${mkTd()} text-secondary text-right`}>
                  {Math.round(spxLevel)}
                </td>
                <td
                  className={`${mkTd()} text-right font-semibold`}
                  style={{ color: s.icPnL >= 0 ? th.green : th.red }}
                >
                  {s.icPnL >= 0 ? '+' : ''}
                  {fmtDollar(s.icPnL)}
                </td>
                <td
                  className={`${mkTd()} text-right`}
                  style={{ color: hedgePayout > 0 ? th.green : th.textMuted }}
                >
                  {hedgePayout > 0 ? '+$' + fmtDollar(hedgePayout) : '$0'}
                </td>
                <td className={`${mkTd()} text-danger text-right text-[11px]`}>
                  {fmtDollar(s.hedgeCost)}
                </td>
                <td
                  className={`${mkTd()} text-right text-[13px] font-bold`}
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
