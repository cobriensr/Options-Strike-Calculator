import { useState } from 'react';
import { SectionBox, ScrollHint, Chip } from './ui';
import { mkTh, mkTd } from '../utils/ui-utils';

type Mode = 'sell' | 'buy';

const RISK_TIERS = [1, 2, 3, 5, 10];
const WING_OPTIONS = [5, 10, 15, 20, 25, 30, 50];

function riskColor(pct: number): string {
  if (pct > 5) return 'var(--color-danger)';
  if (pct > 3) return 'var(--color-caution)';
  return 'var(--color-success)';
}

/* Compact chip classes — intentionally smaller than the shared Chip component */
const chipCompact =
  'cursor-pointer rounded-full border-[1.5px] px-2.5 py-1 font-mono text-[12px] font-medium transition-all duration-100';
const chipColorActive =
  'border-chip-active-border bg-chip-active-bg text-chip-active-text';
const chipColorInactive =
  'border-chip-border bg-chip-bg text-chip-text hover:border-edge-heavy hover:bg-surface-alt';

function DollarField({
  id,
  label,
  value,
  onChange,
  placeholder,
  wide,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  wide?: boolean;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="text-tertiary mb-1.5 block font-sans text-[11px] font-bold tracking-[0.08em] uppercase"
      >
        {label}
      </label>
      <div className={`relative ${wide ? 'w-36' : 'w-24'}`}>
        <span className="text-muted pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-sm">
          $
        </span>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            onChange(e.target.value.replaceAll(/[^0-9.]/g, ''));
          }}
          className="bg-input border-edge-strong hover:border-edge-heavy text-primary w-full rounded-lg border-[1.5px] py-[11px] pr-3 pl-7 font-mono text-sm transition-[border-color] duration-150 outline-none"
        />
      </div>
    </div>
  );
}

export default function RiskCalculator() {
  const [mode, setMode] = useState<Mode>('sell');
  const [balance, setBalance] = useState('');
  const [wing, setWing] = useState(10);
  const [contracts, setContracts] = useState(1);
  const [creditInput, setCreditInput] = useState('');
  const [premiumInput, setPremiumInput] = useState('');
  const [targetExitInput, setTargetExitInput] = useState('');
  const [deltaInput, setDeltaInput] = useState('');
  const [popInput, setPopInput] = useState('');
  const [stopMultiple, setStopMultiple] = useState<number | null>(null);
  const [buyStopPct, setBuyStopPct] = useState<number | null>(null);
  const [portfolioCap, setPortfolioCap] = useState(100);

  const bal = Number.parseFloat(balance) || 0;
  const delta = Number.parseFloat(deltaInput) || 0;
  const hasDelta = delta > 0;

  // Sell-side calculations
  const credit = Number.parseFloat(creditInput) || 0;
  const creditPerContract = credit * 100;
  const grossLossPerContract = wing * 100;
  const netLossPerContract = Math.max(
    0,
    grossLossPerContract - creditPerContract,
  );
  const hasCredit = credit > 0;

  // Stop loss: if set, max loss = (stopMultiple × credit - credit) × 100
  // i.e. you buy back at stopMultiple × credit, losing the difference
  const hasStop = mode === 'sell' && hasCredit && stopMultiple !== null;
  const stopLossPerContract = hasStop
    ? (stopMultiple - 1) * creditPerContract
    : 0;

  // Buy-side calculations
  const premium = Number.parseFloat(premiumInput) || 0;
  const premiumPerContract = premium * 100;
  const hasBuyStop = mode === 'buy' && premium > 0 && buyStopPct !== null;
  const buyStopLossPerContract = hasBuyStop
    ? premiumPerContract * (buyStopPct / 100)
    : premiumPerContract;

  // Unified loss figure based on mode
  const lossPerContract =
    mode === 'buy'
      ? buyStopLossPerContract
      : hasStop
        ? Math.min(stopLossPerContract, netLossPerContract)
        : hasCredit
          ? netLossPerContract
          : grossLossPerContract;

  const totalLoss = lossPerContract * contracts;
  const lossPct = bal > 0 ? (totalLoss / bal) * 100 : 0;

  // Buying power required (always based on spread width, not stop)
  const bpPerContract =
    mode === 'buy' ? premiumPerContract : netLossPerContract;
  const totalBp = bpPerContract * contracts;

  // Buy-side target exit
  const targetExit = Number.parseFloat(targetExitInput) || 0;
  const hasTarget = mode === 'buy' && targetExit > premium && premium > 0;
  const buyProfitPerContract = hasTarget ? (targetExit - premium) * 100 : 0;

  // Risk/reward — sell: credit vs net loss; buy: premium vs target profit
  const maxProfit =
    mode === 'sell' && hasCredit
      ? creditPerContract
      : hasTarget
        ? buyProfitPerContract
        : 0;
  const rrRatio =
    maxProfit > 0 && lossPerContract > 0 ? lossPerContract / maxProfit : 0;

  // Max concurrent positions
  const maxPositions = lossPct > 0 ? Math.floor(portfolioCap / lossPct) : 0;

  // Probability of profit & expected value
  const pop = Number.parseFloat(popInput) || 0;
  const hasPop = pop > 0 && pop < 100;
  const evPerContract =
    hasPop && maxProfit > 0
      ? (pop / 100) * maxProfit - ((100 - pop) / 100) * lossPerContract
      : 0;

  const creditPct = wing > 0 ? credit / wing : 0;

  return (
    <SectionBox label="Risk Calculator">
      {/* ── ROW 1: mode + inputs ── */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label
            htmlFor="rc-mode"
            className="text-tertiary mb-1.5 block font-sans text-[11px] font-bold tracking-[0.08em] uppercase"
          >
            Mode
          </label>
          <div
            id="rc-mode"
            className="flex gap-1"
            role="radiogroup"
            aria-label="Trade mode"
          >
            {(['sell', 'buy'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={
                  'cursor-pointer rounded-lg border-[1.5px] px-3 py-[10px] font-sans text-[11px] font-bold tracking-wide uppercase transition-all duration-100 ' +
                  (mode === m ? chipColorActive : chipColorInactive)
                }
              >
                {m === 'sell' ? 'Sell' : 'Buy'}
              </button>
            ))}
          </div>
        </div>
        <DollarField
          id="rc-balance"
          label="Account Balance"
          value={balance}
          onChange={setBalance}
          placeholder="25,000"
          wide
        />
        {mode === 'sell' ? (
          <DollarField
            id="rc-credit"
            label="Credit Received"
            value={creditInput}
            onChange={setCreditInput}
            placeholder="1.50"
          />
        ) : (
          <>
            <DollarField
              id="rc-premium"
              label="Premium Paid"
              value={premiumInput}
              onChange={setPremiumInput}
              placeholder="3.50"
            />
            <DollarField
              id="rc-target"
              label="Target Exit"
              value={targetExitInput}
              onChange={setTargetExitInput}
              placeholder="7.00"
            />
          </>
        )}
        <div>
          <label
            htmlFor="rc-delta"
            className="text-tertiary mb-1.5 block font-sans text-[11px] font-bold tracking-[0.08em] uppercase"
          >
            Delta
          </label>
          <div className="relative w-20">
            <span className="text-muted pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-sm">
              {'\u0394'}
            </span>
            <input
              id="rc-delta"
              type="text"
              inputMode="decimal"
              placeholder=".08"
              value={deltaInput}
              onChange={(e) => {
                setDeltaInput(e.target.value.replaceAll(/[^0-9.]/g, ''));
              }}
              className="bg-input border-edge-strong hover:border-edge-heavy text-primary w-full rounded-lg border-[1.5px] py-[11px] pr-3 pl-7 font-mono text-sm transition-[border-color] duration-150 outline-none"
            />
          </div>
        </div>
        <div>
          <label
            htmlFor="rc-pop"
            className="text-tertiary mb-1.5 block font-sans text-[11px] font-bold tracking-[0.08em] uppercase"
          >
            PoP %
          </label>
          <div className="relative w-20">
            <input
              id="rc-pop"
              type="text"
              inputMode="decimal"
              placeholder="85"
              value={popInput}
              onChange={(e) => {
                setPopInput(e.target.value.replaceAll(/[^0-9.]/g, ''));
              }}
              className="bg-input border-edge-strong hover:border-edge-heavy text-primary w-full rounded-lg border-[1.5px] px-3 py-[11px] font-mono text-sm transition-[border-color] duration-150 outline-none"
            />
            <span className="text-muted pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono text-sm">
              %
            </span>
          </div>
        </div>

        {mode === 'sell' && (
          <div>
            <label
              htmlFor="rc-wing"
              className="text-tertiary mb-1.5 block font-sans text-[11px] font-bold tracking-[0.08em] uppercase"
            >
              Wing Width (pts)
            </label>
            <div
              id="rc-wing"
              className="flex flex-wrap gap-1.5"
              role="radiogroup"
              aria-label="Wing width"
            >
              {WING_OPTIONS.map((w) => (
                <Chip
                  key={w}
                  onClick={() => setWing(w)}
                  active={wing === w}
                  label={String(w)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Contracts */}
        <div>
          <label
            htmlFor="rc-contracts"
            className="text-tertiary mb-1.5 block font-sans text-[11px] font-bold tracking-[0.08em] uppercase"
          >
            Contracts
          </label>
          <div className="flex items-center">
            <button
              onClick={() => setContracts(Math.max(1, contracts - 1))}
              aria-label="Decrease contracts"
              className="border-edge-strong bg-chip-bg text-primary flex h-[42px] w-8 cursor-pointer items-center justify-center rounded-l-lg border-[1.5px] border-r-0 font-mono text-base font-bold"
            >
              {'\u2212'}
            </button>
            <input
              type="text"
              inputMode="numeric"
              value={contracts}
              onChange={(e) => {
                const v = Number.parseInt(e.target.value);
                if (!Number.isNaN(v) && v >= 1 && v <= 999) setContracts(v);
                else if (e.target.value === '') setContracts(1);
              }}
              id="rc-contracts"
              className="border-edge-strong bg-input text-primary h-[42px] w-[52px] border-[1.5px] text-center font-mono text-sm font-semibold outline-none"
            />
            <button
              onClick={() => setContracts(Math.min(999, contracts + 1))}
              aria-label="Increase contracts"
              className="border-edge-strong bg-chip-bg text-primary flex h-[42px] w-8 cursor-pointer items-center justify-center rounded-r-lg border-[1.5px] border-l-0 font-mono text-base font-bold"
            >
              +
            </button>
          </div>
        </div>
      </div>

      {/* ── ROW 2: settings ── */}
      <div className="border-edge mt-3 flex flex-wrap items-start gap-3 border-t pt-3">
        {/* Left group: text + stop + cap */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {/* Target / status text */}
          <div className="text-[11px]">
            {/* Sell: Target guidance */}
            {mode === 'sell' && (
              <span className="text-muted font-sans">
                Target:{' '}
                <span className="text-primary font-mono font-semibold">
                  ${(wing * 0.1).toFixed(2)}
                </span>
                {' – '}
                <span className="text-primary font-mono font-semibold">
                  ${(wing * 0.15).toFixed(2)}
                </span>
                {hasCredit &&
                  (() => {
                    const deltaSuffix = hasDelta
                      ? ' at ' + delta + '\u0394'
                      : '';
                    let verdict: string;
                    if (creditPct >= 0.15) verdict = ' Excellent' + deltaSuffix;
                    else if (creditPct >= 0.1) verdict = ' OK' + deltaSuffix;
                    else
                      verdict =
                        ' ' +
                        (creditPct * 100).toFixed(1) +
                        '%' +
                        deltaSuffix +
                        ' — pass';
                    return (
                      <span
                        className="ml-1 font-semibold"
                        style={{
                          color:
                            creditPct >= 0.1
                              ? 'var(--color-success)'
                              : 'var(--color-danger)',
                        }}
                      >
                        {verdict}
                      </span>
                    );
                  })()}
                {hasDelta && delta < 0.08 && (
                  <span
                    className="ml-1 font-semibold"
                    style={{ color: 'var(--color-danger)' }}
                  >
                    {'\u0394'}&lt;0.08
                  </span>
                )}
              </span>
            )}

            {/* Buy: profit target & R:R summary */}
            {mode === 'buy' && (
              <span className="text-muted font-sans">
                {hasTarget ? (
                  <>
                    Profit at target:{' '}
                    <span
                      className="font-mono font-semibold"
                      style={{ color: 'var(--color-success)' }}
                    >
                      ${buyProfitPerContract.toLocaleString()}/ct
                    </span>
                    <span className="mx-1.5">{'\u00B7'}</span>
                    R:R{' '}
                    <span className="text-primary font-mono font-semibold">
                      1:{rrRatio > 0 ? rrRatio.toFixed(1) : '\u2014'}
                    </span>
                    {hasDelta && (
                      <>
                        <span className="mx-1.5">{'\u00B7'}</span>
                        <span className="text-primary font-mono font-semibold">
                          {delta}
                          {'\u0394'}
                        </span>
                      </>
                    )}
                  </>
                ) : premium > 0 ? (
                  'Enter a target exit price to see profit & R:R'
                ) : (
                  'Enter premium paid and target exit to see analysis'
                )}
              </span>
            )}
          </div>

          {/* Stop loss */}
          <div className="flex items-center gap-1.5">
            <span className="text-tertiary font-sans text-[10px] font-bold tracking-[0.06em] uppercase">
              Stop
            </span>
            {mode === 'sell' ? (
              <>
                {[null, 2, 3, 4, 5].map((m) => (
                  <button
                    key={m ?? 'none'}
                    onClick={() => setStopMultiple(m)}
                    className={`${chipCompact} ${stopMultiple === m ? chipColorActive : chipColorInactive}`}
                  >
                    {m === null ? '\u2014' : `${m}\u00D7`}
                  </button>
                ))}
                {hasStop && (
                  <span className="text-muted text-[10px]">
                    ${(credit * stopMultiple).toFixed(2)}
                  </span>
                )}
              </>
            ) : (
              <>
                {[null, 25, 50, 75].map((pct) => (
                  <button
                    key={pct ?? 'none'}
                    onClick={() => setBuyStopPct(pct)}
                    className={`${chipCompact} ${buyStopPct === pct ? chipColorActive : chipColorInactive}`}
                  >
                    {pct === null ? '\u2014' : `${pct}%`}
                  </button>
                ))}
                {hasBuyStop && (
                  <span className="text-muted text-[10px]">
                    exit ${(premium * (1 - buyStopPct / 100)).toFixed(2)}
                  </span>
                )}
              </>
            )}
          </div>

          {/* Cap */}
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="text-tertiary font-sans text-[10px] font-bold tracking-[0.06em] uppercase">
              Cap
            </span>
            {[25, 50, 75, 100].map((cap) => (
              <button
                key={cap}
                onClick={() => setPortfolioCap(cap)}
                className={`${chipCompact} ${portfolioCap === cap ? chipColorActive : chipColorInactive}`}
              >
                {cap}%
              </button>
            ))}
          </div>
        </div>
        {/* end left group */}

        {/* Conviction 2×2 */}
        <div className="grid grid-cols-2 gap-1">
          {[
            {
              label: 'High',
              range: '8\u201310%',
              color: 'var(--color-success)',
            },
            {
              label: 'Medium',
              range: '5\u20137%',
              color: 'var(--color-caution)',
            },
            { label: 'Low', range: '3\u20134%', color: 'var(--color-danger)' },
            { label: 'Sit Out', range: '0%', color: 'var(--color-muted)' },
          ].map((tier) => (
            <div
              key={tier.label}
              className="bg-surface-alt flex min-w-[88px] items-center gap-1.5 rounded px-2.5 py-1"
            >
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: tier.color }}
              />
              <span className="text-primary font-sans text-[10px] font-semibold">
                {tier.label}
              </span>
              <span
                className="ml-auto font-mono text-[10px] font-semibold whitespace-nowrap"
                style={{ color: tier.color }}
              >
                {tier.range}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── 6. RESULTS ── */}
      {bal > 0 && lossPerContract > 0 && (
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
                    Math.abs(evPerContract * contracts).toLocaleString(
                      undefined,
                      { maximumFractionDigits: 0 },
                    )
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
                      <th className={mkTh('center')}>Risk %</th>
                      <th className={mkTh('right')}>Budget</th>
                      <th className={mkTh('center')}>Max Contracts</th>
                      <th className={mkTh('right')}>Max Loss</th>
                      <th className={mkTh('center')}>Actual %</th>
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
      )}
    </SectionBox>
  );
}
