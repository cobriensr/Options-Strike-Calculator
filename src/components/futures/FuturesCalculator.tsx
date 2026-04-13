/**
 * FuturesCalculator — Pure frontend day-trade P&L calculator for ES and NQ.
 * Math lives in futures-calc.ts (tested separately).
 */

import { useState, useCallback, useMemo } from 'react';
import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import {
  SPECS,
  feesPerSide,
  roundTripFees,
  breakEvenPrice,
  calcTrade,
  calcTickRow,
} from './futures-calc';
import type { FuturesSymbol, Direction } from './futures-calc';

// Tick ladder steps rendered when only entry is provided
const TICK_STEPS = [1, 2, 4, 6, 8, 10, 12, 16, 20];

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtPrice(n: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtDollar(n: number, alwaysSign = false): string {
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const sign = n >= 0 ? (alwaysSign ? '+' : '') : '-';
  return `${sign}$${abs}`;
}

function pnlColor(n: number): string {
  if (n > 0) return theme.green;
  if (n < 0) return theme.red;
  return theme.textMuted;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function FieldLabel({ children }: { readonly children: React.ReactNode }) {
  return (
    <span className="text-tertiary mb-1.5 block font-sans text-[11px] font-bold tracking-[0.08em] uppercase">
      {children}
    </span>
  );
}

function PriceInput({
  id,
  label,
  value,
  onChange,
  placeholder,
}: Readonly<{
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}>) {
  return (
    <div>
      <label
        htmlFor={id}
        className="text-tertiary mb-1.5 block font-sans text-[11px] font-bold tracking-[0.08em] uppercase"
      >
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value.replaceAll(/[^0-9.]/g, ''))}
        className="bg-input border-edge-strong hover:border-edge-heavy text-primary w-full rounded-lg border-[1.5px] px-3 py-[11px] font-mono text-sm transition-[border-color] duration-150 outline-none"
      />
    </div>
  );
}

function ResultRow({
  label,
  value,
  color,
  bold = false,
}: Readonly<{
  label: string;
  value: string;
  color?: string;
  bold?: boolean;
}>) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span
        className="font-sans text-[11px]"
        style={{ color: theme.textMuted }}
      >
        {label}
      </span>
      <span
        className={`font-mono text-[13px] ${bold ? 'font-bold' : 'font-medium'}`}
        style={{ color: color ?? theme.text }}
      >
        {value}
      </span>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function FuturesCalculator() {
  const [symbol, setSymbol] = useState<FuturesSymbol>('ES');
  const [direction, setDirection] = useState<Direction>('long');
  const [entryInput, setEntryInput] = useState('');
  const [exitInput, setExitInput] = useState('');
  const [adverseInput, setAdverseInput] = useState('');
  const [contracts, setContracts] = useState(1);
  const [collapsed, setCollapsed] = useState(false);

  const spec = SPECS[symbol];

  const entry = Number.parseFloat(entryInput);
  const exit = Number.parseFloat(exitInput);
  const entryValid = Number.isFinite(entry) && entry > 0;
  const exitValid = Number.isFinite(exit) && exit > 0;
  const contractsValid = Number.isFinite(contracts) && contracts >= 1;

  const clearPrices = useCallback(() => {
    setEntryInput('');
    setExitInput('');
    setAdverseInput('');
  }, []);

  const handleClear = useCallback(() => {
    setEntryInput('');
    setExitInput('');
    setAdverseInput('');
    setContracts(1);
  }, []);


  // Full P&L (both entry and exit)
  const calc = useMemo(
    () =>
      entryValid && exitValid && contractsValid
        ? calcTrade(spec, entry, exit, direction, contracts)
        : null,
    [
      entryValid,
      exitValid,
      contractsValid,
      spec,
      entry,
      exit,
      direction,
      contracts,
    ],
  );

  // Break-even (entry only)
  const bePrice = useMemo(
    () =>
      entryValid && contractsValid
        ? breakEvenPrice(spec, entry, direction, contracts)
        : null,
    [entryValid, contractsValid, spec, entry, direction, contracts],
  );

  // Tick ladder (entry only)
  const tickLadder = useMemo(
    () =>
      entryValid && contractsValid
        ? TICK_STEPS.map((t) =>
            calcTickRow(spec, entry, direction, contracts, t),
          )
        : null,
    [entryValid, contractsValid, spec, entry, direction, contracts],
  );

  // Adverse excursion (optional — lowest price for long, highest for short)
  const adverse = Number.parseFloat(adverseInput);
  const adverseValid = Number.isFinite(adverse) && adverse > 0;
  const adverseCalc = useMemo(
    () =>
      entryValid && adverseValid && contractsValid
        ? calcTrade(spec, entry, adverse, direction, contracts)
        : null,
    [
      entryValid,
      adverseValid,
      contractsValid,
      spec,
      entry,
      adverse,
      direction,
      contracts,
    ],
  );

  const chipClass = (active: boolean) =>
    'cursor-pointer rounded-md border-[1.5px] px-2.5 py-1 font-sans text-[10px] font-bold tracking-[0.08em] uppercase transition-colors duration-100 ' +
    (active
      ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text'
      : 'border-chip-border bg-chip-bg text-chip-text hover:border-edge-heavy hover:bg-surface-alt');

  const feePerSide =
    spec.exchangeFee + spec.nfaFee + spec.clearingFee + spec.brokerCommission;

  return (
    <section
      aria-label="Futures day-trade P&L calculator"
      className="animate-fade-in-up bg-surface border-edge border-t-accent mt-3 flex flex-col rounded-[14px] border-[1.5px] border-t-[3px] p-[18px] pb-4 shadow-[0_1px_4px_rgba(0,0,0,0.03)]"
    >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div
        className={
          (collapsed ? '' : 'mb-3.5 ') +
          'flex cursor-pointer flex-col gap-2 select-none'
        }
        onClick={() => setCollapsed((v) => !v)}
        role="button"
        tabIndex={0}
        aria-label="Toggle Futures P&L Calculator"
        aria-expanded={!collapsed}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setCollapsed((v) => !v);
          }
        }}
      >
        {/* Row 1: title + clear */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span
              className="text-muted text-[12px] transition-transform duration-200"
              style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
              aria-hidden="true"
            >
              &#x25BE;
            </span>
            <h2 className="text-tertiary font-sans text-[13px] font-bold tracking-[0.12em] uppercase">
              Futures P&amp;L Calculator
            </h2>
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleClear(); }}
            className="border-edge-strong bg-chip-bg text-secondary cursor-pointer rounded-md border-[1.5px] px-3 py-1.5 font-sans text-xs font-semibold hover:border-red-400 hover:text-red-400"
          >
            Clear
          </button>
        </div>

        {/* Row 2: symbol chips inline */}
        <div className="flex gap-1">
          {(['ES', 'MES', 'NQ', 'MNQ'] as const).map((sym) => (
            <button
              key={sym}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setSymbol(sym);
                clearPrices();
              }}
              className={chipClass(symbol === sym)}
            >
              {sym}
            </button>
          ))}
        </div>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      {!collapsed && (
        <div className="space-y-4">
          {/* Spec bar */}
          <div
            className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg px-3 py-2 font-sans text-[10px]"
            style={{
              backgroundColor: tint(theme.accent, '10'),
              color: theme.textMuted,
            }}
          >
            <span className="font-bold" style={{ color: theme.accent }}>
              {spec.label} · {spec.name}
            </span>
            <span>
              <span className="font-semibold" style={{ color: theme.text }}>
                ${spec.pointValue}
              </span>{' '}
              / pt
            </span>
            <span>
              <span className="font-semibold" style={{ color: theme.text }}>
                ${spec.tickValue}
              </span>{' '}
              / tick
            </span>
            <span>
              Fees{' '}
              <span className="font-semibold" style={{ color: theme.text }}>
                ${feePerSide.toFixed(2)}
              </span>{' '}
              / side
            </span>
            <span>
              Day margin{' '}
              <span className="font-semibold" style={{ color: theme.text }}>
                ${spec.dayMargin.toLocaleString()}
              </span>{' '}
              / contract
            </span>
          </div>

          {/* Direction toggle */}
          <div>
            <FieldLabel>Direction</FieldLabel>
            <div className="flex gap-1.5">
              {(['long', 'short'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => {
                    setDirection(d);
                    clearPrices();
                  }}
                  className={
                    'cursor-pointer rounded-md border-[1.5px] px-4 py-1.5 font-sans text-[11px] font-bold tracking-[0.06em] uppercase transition-colors duration-100 ' +
                    (direction === d
                      ? d === 'long'
                        ? 'border-green-500/40 text-green-400'
                        : 'border-red-500/40 text-red-400'
                      : 'border-chip-border bg-chip-bg text-chip-text hover:border-edge-heavy')
                  }
                  style={
                    direction === d
                      ? {
                          backgroundColor: tint(
                            d === 'long' ? theme.green : theme.red,
                            '15',
                          ),
                        }
                      : {}
                  }
                >
                  {d === 'long' ? 'Long (Buy)' : 'Short (Sell)'}
                </button>
              ))}
            </div>
          </div>

          {/* Price + contracts + adverse inputs — all on one row */}
          <div
            className={`grid gap-3 ${entryValid ? 'grid-cols-4' : 'grid-cols-3'}`}
          >
            <PriceInput
              id="fc-entry"
              label="Entry Price"
              value={entryInput}
              onChange={setEntryInput}
              placeholder="5500.00"
            />
            <PriceInput
              id="fc-exit"
              label="Exit Price"
              value={exitInput}
              onChange={setExitInput}
              placeholder="5510.00"
            />
            <div>
              <label
                id="fc-contracts-label"
                className="text-tertiary mb-1.5 block font-sans text-[11px] font-bold tracking-[0.08em] uppercase"
              >
                Contracts
              </label>
              <div
                aria-labelledby="fc-contracts-label"
                aria-label="Contracts"
                className="bg-input border-edge-strong flex h-[43px] items-center rounded-lg border-[1.5px]"
              >
                <button
                  type="button"
                  aria-label="Decrease contracts"
                  onClick={() => setContracts((n) => Math.max(1, n - 1))}
                  className="text-secondary hover:text-primary flex h-full w-9 flex-shrink-0 items-center justify-center rounded-l-lg font-mono text-lg leading-none transition-colors"
                >
                  −
                </button>
                <span
                  data-testid="fc-contracts-display"
                  className="text-primary flex-1 text-center font-mono text-sm font-medium tabular-nums"
                >
                  {contracts}
                </span>
                <button
                  type="button"
                  aria-label="Increase contracts"
                  onClick={() => setContracts((n) => n + 1)}
                  className="text-secondary hover:text-primary flex h-full w-9 flex-shrink-0 items-center justify-center rounded-r-lg font-mono text-lg leading-none transition-colors"
                >
                  +
                </button>
              </div>
            </div>
            {entryValid && (
              <PriceInput
                id="fc-adverse"
                label={
                  direction === 'long'
                    ? 'Lowest Price Reached'
                    : 'Highest Price Reached'
                }
                value={adverseInput}
                onChange={setAdverseInput}
                placeholder={direction === 'long' ? '5490.00' : '5510.00'}
              />
            )}
          </div>

          {/* ── MAE results panel ── */}
          {adverseCalc && (
            <div
              className="rounded-xl border p-4"
              style={{
                backgroundColor: tint(theme.red, '08'),
                borderColor: tint(theme.red, '20'),
              }}
            >
              <div
                className="mb-2 font-sans text-[10px] font-bold tracking-[0.10em] uppercase"
                style={{ color: theme.red }}
              >
                Max Adverse Excursion · {contracts} contract
                {contracts !== 1 ? 's' : ''}
              </div>
              <div className="divide-edge divide-y">
                <ResultRow
                  label="Adverse move"
                  value={`${adverseCalc.points >= 0 ? '+' : ''}${fmtPrice(adverseCalc.points)} pts / ${adverseCalc.ticks >= 0 ? '+' : ''}${adverseCalc.ticks.toFixed(0)} ticks`}
                  color={pnlColor(adverseCalc.points)}
                />
                <ResultRow
                  label="Gross exposure"
                  value={fmtDollar(adverseCalc.gross, true)}
                  color={pnlColor(adverseCalc.gross)}
                />
                <ResultRow
                  label="Net exposure (after fees)"
                  value={fmtDollar(adverseCalc.net, true)}
                  color={pnlColor(adverseCalc.net)}
                  bold
                />
              </div>
            </div>
          )}

          {/* ── Full P&L results ── */}
          {calc && (
            <div
              className="border-edge rounded-xl border p-4"
              style={{ backgroundColor: tint(theme.surfaceAlt, '80') }}
            >
              <div className="text-tertiary mb-2 font-sans text-[10px] font-bold tracking-[0.10em] uppercase">
                Trade Results · {contracts} contract{contracts !== 1 ? 's' : ''}
              </div>
              <div className="divide-edge divide-y">
                <ResultRow
                  label="Points moved"
                  value={`${calc.points >= 0 ? '+' : ''}${fmtPrice(calc.points)} pts`}
                  color={pnlColor(calc.points)}
                />
                <ResultRow
                  label="Ticks moved"
                  value={`${calc.ticks >= 0 ? '+' : ''}${calc.ticks.toFixed(0)} ticks`}
                  color={pnlColor(calc.ticks)}
                />
                <ResultRow
                  label="Gross P&L"
                  value={fmtDollar(calc.gross, true)}
                  color={pnlColor(calc.gross)}
                />
                <ResultRow
                  label={`Buy-side fees (${contracts}× $${feePerSide.toFixed(2)})`}
                  value={fmtDollar(-feesPerSide(spec, contracts))}
                  color={theme.red}
                />
                <ResultRow
                  label={`Sell-side fees (${contracts}× $${feePerSide.toFixed(2)})`}
                  value={fmtDollar(-feesPerSide(spec, contracts))}
                  color={theme.red}
                />
                <ResultRow
                  label="Total round-trip fees"
                  value={fmtDollar(-calc.fees)}
                  color={theme.red}
                />
              </div>

              {/* Net P&L highlight */}
              <div
                className="mt-3 flex items-center justify-between rounded-lg px-4 py-3"
                style={{
                  backgroundColor: tint(pnlColor(calc.net), '12'),
                  border: `1px solid ${tint(pnlColor(calc.net), '30')}`,
                }}
              >
                <span
                  className="font-sans text-[12px] font-bold tracking-wide uppercase"
                  style={{ color: pnlColor(calc.net) }}
                >
                  Net P&amp;L
                </span>
                <span
                  className="font-mono text-[18px] font-bold"
                  style={{ color: pnlColor(calc.net) }}
                >
                  {fmtDollar(calc.net, true)}
                </span>
              </div>

              {/* Margin & ROM */}
              <div
                className="mt-2 divide-y"
                style={{ borderColor: theme.border }}
              >
                <ResultRow
                  label="Day margin required"
                  value={fmtDollar(calc.marginRequired)}
                />
                <ResultRow
                  label="Return on margin"
                  value={`${calc.returnOnMarginPct >= 0 ? '+' : ''}${calc.returnOnMarginPct.toFixed(2)}%`}
                  color={pnlColor(calc.returnOnMarginPct)}
                  bold
                />
              </div>
            </div>
          )}

          {/* ── Tick ladder (entry only, no exit) ── */}
          {entryValid && !exitValid && tickLadder && bePrice !== null && (
            <div
              className="border-edge rounded-xl border p-4"
              style={{ backgroundColor: tint(theme.surfaceAlt, '80') }}
            >
              <div className="mb-2 flex items-center justify-between">
                <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.10em] uppercase">
                  Tick ladder · {contracts} contract{contracts !== 1 ? 's' : ''}
                </div>
                <div
                  className="font-sans text-[10px]"
                  style={{ color: theme.textMuted }}
                >
                  Break-even:{' '}
                  <span
                    className="font-mono font-semibold"
                    style={{ color: theme.caution }}
                  >
                    {fmtPrice(bePrice)}
                  </span>
                </div>
              </div>

              {/* Table header */}
              <div
                className="mb-1 grid grid-cols-4 gap-2 pb-1 font-sans text-[9px] font-bold tracking-[0.08em] uppercase"
                style={{
                  color: theme.textMuted,
                  borderBottom: `1px solid ${tint(theme.border, '80')}`,
                }}
              >
                <span>Ticks</span>
                <span>Exit</span>
                <span>Gross</span>
                <span>Net (after fees)</span>
              </div>

              {/* Rows */}
              <div className="space-y-0.5">
                {tickLadder.map((row) => (
                  <div
                    key={row.ticks}
                    className="grid grid-cols-4 gap-2 py-0.5"
                  >
                    <span
                      className="font-mono text-[11px]"
                      style={{ color: theme.textMuted }}
                    >
                      +{row.ticks}
                    </span>
                    <span
                      className="font-mono text-[11px]"
                      style={{ color: theme.text }}
                    >
                      {fmtPrice(row.exitPx)}
                    </span>
                    <span
                      className="font-mono text-[11px]"
                      style={{ color: pnlColor(row.gross) }}
                    >
                      {fmtDollar(row.gross, true)}
                    </span>
                    <span
                      className="font-mono text-[11px] font-semibold"
                      style={{ color: pnlColor(row.net) }}
                    >
                      {fmtDollar(row.net, true)}
                    </span>
                  </div>
                ))}
              </div>

              {/* Fee footnote */}
              <div
                className="mt-3 rounded px-2 py-1.5 font-sans text-[9px]"
                style={{
                  backgroundColor: tint(theme.surfaceAlt, '60'),
                  color: theme.textMuted,
                }}
              >
                Round-trip fees deducted:{' '}
                <span
                  className="font-mono font-semibold"
                  style={{ color: theme.red }}
                >
                  {fmtDollar(-roundTripFees(spec, contracts))}
                </span>{' '}
                ({contracts}× ${feePerSide.toFixed(2)} buy + {contracts}× $
                {feePerSide.toFixed(2)} sell)
              </div>
            </div>
          )}

          {/* Empty state */}
          {!entryValid && (
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
