import { useState } from 'react';
import { theme } from '../../themes';
import type {
  IronCondorLegs,
  CalculationResults,
  HedgeDelta,
} from '../../types';
import { calcHedge } from '../../utils/calculator';
import { HEDGE_DELTA_OPTIONS, DEFAULTS } from '../../constants';
import { fmtDollar } from '../../utils/ui-utils';
import StatBox from './StatBox';
import ScenarioTable from './ScenarioTable';

interface Props {
  results: CalculationResults;
  ic: IronCondorLegs;
  contracts: number;
  skew: number;
  icRows?: IronCondorLegs[];
  hedgeDeltaIdx?: number;
  onHedgeDeltaChange?: (idx: number) => void;
}

export default function HedgeSection({
  results,
  ic,
  contracts,
  skew,
  icRows,
  hedgeDeltaIdx,
  onHedgeDeltaChange,
}: Readonly<Props>) {
  const [hedgeDelta, setHedgeDelta] = useState<HedgeDelta>(2);
  const [hedgeDte, setHedgeDte] = useState<number>(DEFAULTS.HEDGE_DTE);
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
    hedgeDte,
  });

  const crashScenarios = hedge.scenarios.filter((s) => s.direction === 'crash');
  const rallyScenarios = hedge.scenarios.filter((s) => s.direction === 'rally');

  return (
    <div className="mt-4.5">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-accent font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
          Hedge Calculator (Reinsurance)
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {icRows && icRows.length > 1 && onHedgeDeltaChange && (
            <div className="flex items-center gap-1">
              <span className="text-tertiary mr-1 font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
                IC {'\u0394'}
              </span>
              {icRows.map((row, idx) => (
                <button
                  key={row.delta}
                  onClick={() => onHedgeDeltaChange(idx)}
                  role="radio"
                  aria-checked={hedgeDeltaIdx === idx}
                  className={
                    'cursor-pointer rounded-full border-[1.5px] px-2.5 py-0.5 font-mono text-xs font-medium transition-all duration-100 ' +
                    (hedgeDeltaIdx === idx
                      ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text'
                      : 'border-chip-border bg-chip-bg text-chip-text')
                  }
                >
                  {row.delta}
                  {'\u0394'}
                </button>
              ))}
            </div>
          )}
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
          <div className="flex items-center gap-1">
            <span className="text-tertiary mr-1 font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
              DTE
            </span>
            {[1, 7, 14, 21].map((d) => (
              <button
                key={d}
                onClick={() => setHedgeDte(d)}
                role="radio"
                aria-checked={hedgeDte === d}
                className={
                  'cursor-pointer rounded-full border-[1.5px] px-2.5 py-0.5 font-mono text-xs font-medium transition-all duration-100 ' +
                  (hedgeDte === d
                    ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text'
                    : 'border-chip-border bg-chip-bg text-chip-text')
                }
              >
                {d}d
              </button>
            ))}
          </div>
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
                accent={theme.red}
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
                accent={theme.green}
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
            label={hedgeDte > 1 ? 'Net Daily Cost' : 'Daily Hedge Cost'}
            value={'$' + fmtDollar(hedge.dailyCostDollars)}
            accent={theme.red}
          />
          <StatBox
            label="IC Credit"
            value={'$' + fmtDollar(ic.creditReceived * 100 * contracts)}
            accent={theme.green}
          />
          <StatBox
            label="Net Credit After Hedge"
            value={'$' + fmtDollar(hedge.netCreditAfterHedge)}
            accent={hedge.netCreditAfterHedge > 0 ? theme.green : theme.red}
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
        {/* EOD recovery breakdown for longer-dated hedges */}
        {hedgeDte > 1 && (
          <div className="text-muted mt-2 font-mono text-[10px] leading-relaxed">
            {hedgeDte}DTE hedge: buy for{' '}
            <span className="text-danger font-semibold">
              $
              {fmtDollar(
                Math.round(
                  (hedge.putPremium * hedge.recommendedPuts +
                    hedge.callPremium * hedge.recommendedCalls) *
                    100,
                ),
              )}
            </span>{' '}
            {'\u2192'} sell to close at EOD for est.{' '}
            <span className="text-success font-semibold">
              $
              {fmtDollar(
                Math.round(
                  (hedge.putRecovery * hedge.recommendedPuts +
                    hedge.callRecovery * hedge.recommendedCalls) *
                    100,
                ),
              )}
            </span>{' '}
            if OTM {'\u2192'} net cost{' '}
            <span className="font-semibold">
              ${fmtDollar(hedge.dailyCostDollars)}
            </span>
          </div>
        )}
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
            scenarios={crashScenarios}
            spot={results.spot}
            direction="crash"
          />

          {/* Rally Scenarios */}
          <div className="text-success mt-3.5 mb-1.5 font-sans text-[10px] font-bold tracking-widest uppercase">
            Rally Scenarios (SPX rises)
          </div>
          <ScenarioTable
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
        at {hedgeDelta}
        {'\u0394'} ({hedgeDte}DTE).
        {hedgeDte > 1
          ? ` Scenario P&L values hedge at ${hedgeDte - 1}DTE remaining (sell to close at EOD).`
          : ''}{' '}
        All values theoretical (Black-Scholes, r=0). Actual fill prices may
        differ.
      </p>
    </div>
  );
}
