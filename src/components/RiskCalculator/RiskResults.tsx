import type React from 'react';
import { ScrollHint } from '../ui';
import { mkTh, mkTd, riskColor } from '../../utils/ui-utils';
import { RISK_TIERS } from '../../constants';

type Mode = 'sell' | 'buy';

interface RiskResultsProps {
  mode: Mode;
  contracts: number;
  setContracts: React.Dispatch<React.SetStateAction<number>>;
  portfolioCap: number;
  bal: number;
  hasCredit: boolean;
  grossLossPerContract: number;
  netLossPerContract: number;
  premiumPerContract: number;
  hasTarget: boolean;
  buyProfitPerContract: number;
  totalLoss: number;
  lossPct: number;
  totalBp: number;
  rrRatio: number;
  maxPositions: number;
  hasPop: boolean;
  evPerContract: number;
  maxProfit: number;
  lossPerContract: number;
}

export default function RiskResults({
  mode,
  contracts,
  setContracts,
  portfolioCap,
  bal,
  hasCredit,
  grossLossPerContract,
  netLossPerContract,
  premiumPerContract,
  hasTarget,
  buyProfitPerContract,
  totalLoss,
  lossPct,
  totalBp,
  rrRatio,
  maxPositions,
  hasPop,
  evPerContract,
  maxProfit,
  lossPerContract,
}: Readonly<RiskResultsProps>) {
  return (
    <>
      {/* Row 1: per-contract + loss + % */}
      <div className="border-edge mt-3 grid grid-cols-2 gap-2 border-t pt-3 sm:grid-cols-4">
        {mode === 'sell' && (
          <div className="bg-surface-alt rounded-lg px-3 py-2 text-center">
            <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.06em] uppercase">
              {hasCredit ? 'Gross / Contract' : 'Max Loss / Contract'}
            </div>
            <div className="text-primary mt-1 font-mono text-[16px] font-semibold">
              ${grossLossPerContract.toLocaleString()}
            </div>
          </div>
        )}
        {mode === 'sell' && hasCredit && (
          <div className="bg-surface-alt rounded-lg px-3 py-2 text-center">
            <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.06em] uppercase">
              Net / Contract
            </div>
            <div className="text-accent mt-1 font-mono text-[16px] font-semibold">
              ${netLossPerContract.toLocaleString()}
            </div>
          </div>
        )}
        {mode === 'buy' && (
          <div className="bg-surface-alt rounded-lg px-3 py-2 text-center">
            <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.06em] uppercase">
              Cost / Contract
            </div>
            <div className="text-primary mt-1 font-mono text-[16px] font-semibold">
              ${premiumPerContract.toLocaleString()}
            </div>
          </div>
        )}
        {mode === 'buy' && hasTarget && (
          <div className="bg-surface-alt rounded-lg px-3 py-2 text-center">
            <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.06em] uppercase">
              Profit at Target
            </div>
            <div
              className="mt-1 font-mono text-[16px] font-semibold"
              style={{ color: 'var(--color-success)' }}
            >
              ${(buyProfitPerContract * contracts).toLocaleString()}
            </div>
          </div>
        )}
        <div className="bg-surface-alt rounded-lg px-3 py-2 text-center">
          <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.06em] uppercase">
            Total Max Loss
          </div>
          <div
            className="mt-1 font-mono text-[16px] font-semibold"
            style={{ color: riskColor(lossPct) }}
          >
            ${totalLoss.toLocaleString()}
          </div>
        </div>
        <div className="bg-surface-alt rounded-lg px-3 py-2 text-center">
          <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.06em] uppercase">
            % of Account
          </div>
          <div
            className="mt-1 font-mono text-[16px] font-semibold"
            style={{ color: riskColor(lossPct) }}
          >
            {lossPct.toFixed(1)}%
          </div>
        </div>
      </div>
      {/* Row 2: BP, R/R, max positions, EV */}
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="bg-surface-alt rounded-lg px-3 py-2 text-center">
          <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.06em] uppercase">
            BP Required
          </div>
          <div className="text-primary mt-1 font-mono text-[16px] font-semibold">
            ${totalBp.toLocaleString()}
          </div>
        </div>
        <div className="bg-surface-alt rounded-lg px-3 py-2 text-center">
          <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.06em] uppercase">
            Risk / Reward
          </div>
          <div className="text-primary mt-1 font-mono text-[16px] font-semibold">
            {rrRatio > 0 ? `1:${rrRatio.toFixed(1)}` : '\u2014'}
          </div>
        </div>
        <div className="bg-surface-alt rounded-lg px-3 py-2 text-center">
          <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.06em] uppercase">
            Max Positions (at {portfolioCap}%)
          </div>
          <div className="text-primary mt-1 font-mono text-[16px] font-semibold">
            {maxPositions > 0 ? maxPositions : '\u2014'}
          </div>
        </div>
        <div className="bg-surface-alt rounded-lg px-3 py-2 text-center">
          <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.06em] uppercase">
            Expected Value
          </div>
          <div
            className="mt-1 font-mono text-[16px] font-semibold"
            style={{
              color: !hasPop
                ? 'var(--color-primary)'
                : evPerContract > 0
                  ? 'var(--color-success)'
                  : evPerContract < 0
                    ? 'var(--color-danger)'
                    : 'var(--color-primary)',
            }}
          >
            {hasPop && maxProfit > 0
              ? (evPerContract >= 0 ? '+' : '') +
                '$' +
                Math.abs(evPerContract * contracts).toLocaleString(undefined, {
                  maximumFractionDigits: 0,
                })
              : '\u2014'}
          </div>
          {hasPop && maxProfit > 0 && (
            <div className="text-muted mt-0.5 font-sans text-[9px]">
              ${evPerContract >= 0 ? '+' : ''}
              {evPerContract.toFixed(0)}/ct
            </div>
          )}
        </div>
      </div>

      {/* Tier table */}
      <div className="mt-3">
        <ScrollHint>
          <section
            className="border-edge rounded-[10px] border"
            aria-label="Risk tiers"
          >
            <table
              className="w-full border-collapse font-mono text-[13px]"
              role="table"
              aria-label="Position sizing by risk percentage"
            >
              <thead>
                <tr className="bg-table-header">
                  <th scope="col" className={mkTh('center')}>
                    Risk %
                  </th>
                  <th scope="col" className={mkTh('right')}>
                    Budget
                  </th>
                  <th scope="col" className={mkTh('center')}>
                    Max Contracts
                  </th>
                  <th scope="col" className={mkTh('right')}>
                    Max Loss
                  </th>
                  <th scope="col" className={mkTh('center')}>
                    Actual %
                  </th>
                </tr>
              </thead>
              <tbody>
                {RISK_TIERS.map((pct, i) => {
                  const budget = bal * (pct / 100);
                  const maxContracts = Math.floor(budget / lossPerContract);
                  const actualLoss = maxContracts * lossPerContract;
                  const actualPct = bal > 0 ? (actualLoss / bal) * 100 : 0;

                  return (
                    <tr
                      key={pct}
                      className={
                        (i % 2 === 1 ? 'bg-table-alt' : 'bg-surface') +
                        (contracts === maxContracts && maxContracts > 0
                          ? ' ring-accent/30 ring-1 ring-inset'
                          : '')
                      }
                    >
                      <td
                        className={`${mkTd()} text-accent text-center font-bold`}
                      >
                        {pct}%
                      </td>
                      <td className={`${mkTd()} text-right`}>
                        $
                        {budget.toLocaleString(undefined, {
                          maximumFractionDigits: 0,
                        })}
                      </td>
                      <td className={`${mkTd()} text-center font-semibold`}>
                        {maxContracts === 0 ? (
                          <span className="text-danger">{'\u2014'}</span>
                        ) : (
                          <button
                            onClick={() => setContracts(maxContracts)}
                            className="text-accent cursor-pointer border-none bg-transparent font-mono text-[13px] font-semibold underline decoration-dotted underline-offset-2"
                            title={`Set contracts to ${maxContracts}`}
                          >
                            {maxContracts}
                          </button>
                        )}
                      </td>
                      <td className={`${mkTd()} text-right`}>
                        {maxContracts === 0
                          ? '\u2014'
                          : '$' +
                            actualLoss.toLocaleString(undefined, {
                              maximumFractionDigits: 0,
                            })}
                      </td>
                      <td className={`${mkTd()} text-center`}>
                        {maxContracts === 0
                          ? '\u2014'
                          : actualPct.toFixed(1) + '%'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </ScrollHint>
        {(mode === 'buy' || !hasCredit) && (
          <p className="text-muted mt-2 text-[11px] italic">
            {mode === 'buy'
              ? 'Max loss = premium \u00D7 $100 \u00D7 contracts.'
              : 'Max loss = wing width \u00D7 $100 \u00D7 contracts. Conservative \u2014 does not subtract credit received.'}
          </p>
        )}
      </div>
    </>
  );
}
