/**
 * FuturesCalculator — Pure frontend day-trade P&L calculator for ES and NQ.
 *
 * Orchestrator only: owns the symbol/direction/collapsed state and wires
 * the two core hooks (`useAccountSettings`, `useFuturesCalc`) through to
 * the presentational subcomponents. Math lives in futures-calc.ts
 * (tested separately).
 *
 * See sibling files for the moving parts:
 *   - formatters.ts / ui-primitives.tsx — display helpers
 *   - useAccountSettings.ts   — balance + risk % (localStorage-backed)
 *   - useFuturesCalc.ts       — trade inputs + derived P&L memos
 *   - CalcHeader.tsx          — title + symbol chips + clear
 *   - SpecBar.tsx             — contract spec ribbon
 *   - ScenarioInputs.tsx      — account + direction + entry/exit/contracts
 *   - ExcursionPanels.tsx     — MAE + MFE panels
 *   - PositionSizingPanel.tsx — risk-budget-based sizing
 *   - TradeResults.tsx        — full P&L results block
 *   - TickLadderTable.tsx     — entry-only tick ladder
 */

import { useCallback, useState } from 'react';
import { CalcHeader } from './CalcHeader';
import { ExcursionPanels } from './ExcursionPanels';
import { PositionSizingPanel } from './PositionSizingPanel';
import { ScenarioInputs } from './ScenarioInputs';
import { SpecBar } from './SpecBar';
import { TickLadderTable } from './TickLadderTable';
import { TradeResults } from './TradeResults';
import { SPECS, type Direction, type FuturesSymbol } from './futures-calc';
import { useAccountSettings } from './useAccountSettings';
import { useFuturesCalc } from './useFuturesCalc';

export default function FuturesCalculator() {
  const [symbol, setSymbol] = useState<FuturesSymbol>('ES');
  const [direction, setDirection] = useState<Direction>('long');
  const [collapsed, setCollapsed] = useState(false);

  const spec = SPECS[symbol];
  const account = useAccountSettings();
  const calc = useFuturesCalc(spec, direction, account.derivedMaxRisk);

  const maxContractsByMargin = account.accountValid
    ? Math.floor(account.account / spec.dayMargin)
    : null;

  const pctOfAccount = useCallback(
    (dollars: number): string | null => {
      if (!account.accountValid) return null;
      const pct = (dollars / account.account) * 100;
      return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% of account`;
    },
    [account.accountValid, account.account],
  );

  // Clamp contracts when account balance changes so the user can't exceed
  // what day margin allows. Runs on every account edit and on symbol swap.
  const clampContractsFor = useCallback(
    (forSymbol: FuturesSymbol, accountBalance: number) => {
      const newMax = Math.floor(accountBalance / SPECS[forSymbol].dayMargin);
      calc.setContracts((c) => Math.min(c, Math.max(1, newMax)));
    },
    [calc],
  );

  const handleAccountChange = useCallback(
    (v: string) => {
      account.setAccountInput(v);
      const newAccount = Number.parseFloat(v);
      if (Number.isFinite(newAccount) && newAccount > 0) {
        clampContractsFor(symbol, newAccount);
      }
    },
    [account, clampContractsFor, symbol],
  );

  const handleSymbolChange = useCallback(
    (sym: FuturesSymbol) => {
      setSymbol(sym);
      calc.clearPrices();
      if (account.accountValid) clampContractsFor(sym, account.account);
    },
    [calc, account.accountValid, account.account, clampContractsFor],
  );

  const handleDirectionChange = useCallback(
    (d: Direction) => {
      setDirection(d);
      calc.clearPrices();
    },
    [calc],
  );

  const handleContractsInc = useCallback(
    () =>
      calc.setContracts((n) =>
        maxContractsByMargin !== null
          ? Math.min(maxContractsByMargin, n + 1)
          : n + 1,
      ),
    [calc, maxContractsByMargin],
  );
  const handleContractsDec = useCallback(
    () => calc.setContracts((n) => Math.max(1, n - 1)),
    [calc],
  );

  const feePerSide =
    spec.exchangeFee + spec.nfaFee + spec.clearingFee + spec.brokerCommission;

  return (
    <section
      aria-label="Futures day-trade P&L calculator"
      className="animate-fade-in-up bg-surface border-edge border-t-accent mt-3 flex flex-col rounded-[14px] border-[1.5px] border-t-[3px] p-[18px] pb-4 shadow-[0_1px_4px_rgba(0,0,0,0.03)]"
    >
      <CalcHeader
        symbol={symbol}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
        onSymbolChange={handleSymbolChange}
        onClear={calc.handleClear}
      />

      {!collapsed && (
        <div className="space-y-4">
          <SpecBar spec={spec} feePerSide={feePerSide} />

          <ScenarioInputs
            spec={spec}
            direction={direction}
            onDirectionChange={handleDirectionChange}
            accountInput={account.accountInput}
            riskPctInput={account.riskPctInput}
            accountValid={account.accountValid}
            riskPctValid={account.riskPctValid}
            derivedMaxRisk={account.derivedMaxRisk}
            onAccountChange={handleAccountChange}
            onRiskPctChange={account.setRiskPctInput}
            entryInput={calc.entryInput}
            exitInput={calc.exitInput}
            adverseInput={calc.adverseInput}
            favorableInput={calc.favorableInput}
            entryValid={calc.entryValid}
            contracts={calc.contracts}
            maxContractsByMargin={maxContractsByMargin}
            onEntryChange={calc.setEntryInput}
            onExitChange={calc.setExitInput}
            onAdverseChange={calc.setAdverseInput}
            onFavorableChange={calc.setFavorableInput}
            onContractsDec={handleContractsDec}
            onContractsInc={handleContractsInc}
          />

          <ExcursionPanels
            adverseCalc={calc.adverseCalc}
            favorableCalc={calc.favorableCalc}
            contracts={calc.contracts}
            pctOfAccount={pctOfAccount}
          />

          {calc.positionSize && (
            <PositionSizingPanel
              positionSize={calc.positionSize}
              account={account.account}
              riskPct={account.riskPct}
            />
          )}

          {calc.calc && (
            <TradeResults
              calc={calc.calc}
              spec={spec}
              contracts={calc.contracts}
              feePerSide={feePerSide}
              rrRatio={calc.rrRatio}
              pctOfAccount={pctOfAccount}
            />
          )}

          {calc.entryValid &&
            !calc.exitValid &&
            calc.tickLadder &&
            calc.bePrice !== null && (
              <TickLadderTable
                tickLadder={calc.tickLadder}
                bePrice={calc.bePrice}
                spec={spec}
                contracts={calc.contracts}
                feePerSide={feePerSide}
              />
            )}

          {!calc.entryValid && (
            <div className="text-muted py-4 text-center font-sans text-[12px] italic">
              Enter an entry price to see the tick ladder, or entry + exit for
              full P&amp;L.
            </div>
          )}
        </div>
      )}
    </section>
  );
}
