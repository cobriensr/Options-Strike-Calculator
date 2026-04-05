import type React from 'react';
import { Chip } from '../ui';
import DollarField from '../DollarField';
import { WING_OPTIONS } from '../../constants';

/* Compact chip classes — intentionally smaller than the shared Chip component */
const chipCompact =
  'cursor-pointer rounded-full border-[1.5px] px-2.5 py-1 font-mono text-[12px] font-medium transition-all duration-100';
const chipColorActive =
  'border-chip-active-border bg-chip-active-bg text-chip-active-text';
const chipColorInactive =
  'border-chip-border bg-chip-bg text-chip-text hover:border-edge-heavy hover:bg-surface-alt';

type Mode = 'sell' | 'buy';

interface RiskInputsProps {
  mode: Mode;
  balance: string;
  wing: number;
  contracts: number;
  creditInput: string;
  premiumInput: string;
  targetExitInput: string;
  deltaInput: string;
  popInput: string;
  stopMultiple: number | null;
  buyStopPct: number | null;
  portfolioCap: number;
  setMode: React.Dispatch<React.SetStateAction<Mode>>;
  setBalance: React.Dispatch<React.SetStateAction<string>>;
  setWing: React.Dispatch<React.SetStateAction<number>>;
  setContracts: React.Dispatch<React.SetStateAction<number>>;
  setCreditInput: React.Dispatch<React.SetStateAction<string>>;
  setPremiumInput: React.Dispatch<React.SetStateAction<string>>;
  setTargetExitInput: React.Dispatch<React.SetStateAction<string>>;
  setDeltaInput: React.Dispatch<React.SetStateAction<string>>;
  setPopInput: React.Dispatch<React.SetStateAction<string>>;
  setStopMultiple: React.Dispatch<React.SetStateAction<number | null>>;
  setBuyStopPct: React.Dispatch<React.SetStateAction<number | null>>;
  setPortfolioCap: React.Dispatch<React.SetStateAction<number>>;
  // Derived values needed for inline display
  credit: number;
  premium: number;
  delta: number;
  hasDelta: boolean;
  hasCredit: boolean;
  hasStop: boolean;
  hasTarget: boolean;
  hasBuyStop: boolean;
  creditPct: number;
  buyProfitPerContract: number;
  rrRatio: number;
}

export default function RiskInputs({
  mode,
  balance,
  wing,
  contracts,
  creditInput,
  premiumInput,
  targetExitInput,
  deltaInput,
  popInput,
  stopMultiple,
  buyStopPct,
  portfolioCap,
  setMode,
  setBalance,
  setWing,
  setContracts,
  setCreditInput,
  setPremiumInput,
  setTargetExitInput,
  setDeltaInput,
  setPopInput,
  setStopMultiple,
  setBuyStopPct,
  setPortfolioCap,
  credit,
  premium,
  delta,
  hasDelta,
  hasCredit,
  hasStop,
  hasTarget,
  hasBuyStop,
  creditPct,
  buyProfitPerContract,
  rrRatio,
}: Readonly<RiskInputsProps>) {
  return (
    <>
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
            role="group"
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

        {/* Contracts — always on this row */}
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
              role="group"
              aria-label="Wing width"
            >
              {WING_OPTIONS.filter((w) => w !== 50).map((w) => (
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
                {hasStop && stopMultiple !== null && (
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
                {hasBuyStop && buyStopPct !== null && (
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
    </>
  );
}
