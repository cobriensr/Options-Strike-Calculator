/**
 * All trade-input controls: account balance + risk %, direction toggle,
 * entry/exit/contracts row, and the conditional MAE/MFE row shown when
 * entry is valid.
 *
 * Kept as one component because the four groups share a single visual
 * rhythm (stacked panels) and most props originate from the same hook
 * pair (`useAccountSettings` + `useFuturesCalc`). Splitting further would
 * just smear parent prop threading.
 */

import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import { FieldLabel, PriceInput } from './ui-primitives';
import { fmtDollar } from './formatters';
import type { Direction, ContractSpec } from './futures-calc';

interface Props {
  spec: ContractSpec;
  direction: Direction;
  onDirectionChange: (d: Direction) => void;

  // Account settings
  accountInput: string;
  riskPctInput: string;
  accountValid: boolean;
  riskPctValid: boolean;
  derivedMaxRisk: number | null;
  onAccountChange: (v: string) => void;
  onRiskPctChange: (v: string) => void;

  // Trade inputs
  entryInput: string;
  exitInput: string;
  adverseInput: string;
  favorableInput: string;
  entryValid: boolean;
  contracts: number;
  maxContractsByMargin: number | null;
  onEntryChange: (v: string) => void;
  onExitChange: (v: string) => void;
  onAdverseChange: (v: string) => void;
  onFavorableChange: (v: string) => void;
  onContractsDec: () => void;
  onContractsInc: () => void;
}

export function ScenarioInputs({
  spec,
  direction,
  onDirectionChange,
  accountInput,
  riskPctInput,
  accountValid,
  riskPctValid,
  derivedMaxRisk,
  onAccountChange,
  onRiskPctChange,
  entryInput,
  exitInput,
  adverseInput,
  favorableInput,
  entryValid,
  contracts,
  maxContractsByMargin,
  onEntryChange,
  onExitChange,
  onAdverseChange,
  onFavorableChange,
  onContractsDec,
  onContractsInc,
}: Readonly<Props>) {
  return (
    <>
      {/* Account settings */}
      <div className="grid grid-cols-2 gap-3">
        <PriceInput
          id="fc-account"
          label="Account Balance"
          value={accountInput}
          onChange={onAccountChange}
          placeholder="50000.00"
        />
        <div>
          <label
            htmlFor="fc-riskpct"
            className="text-tertiary mb-1.5 block font-sans text-[11px] font-bold tracking-[0.08em] uppercase"
          >
            Risk % per Trade
          </label>
          <div className="relative">
            <input
              id="fc-riskpct"
              type="text"
              inputMode="decimal"
              placeholder="1.00"
              value={riskPctInput}
              onChange={(e) =>
                onRiskPctChange(e.target.value.replaceAll(/[^0-9.]/g, ''))
              }
              className="bg-input border-edge-strong hover:border-edge-heavy text-primary w-full rounded-lg border-[1.5px] px-3 py-[11px] pr-8 font-mono text-sm transition-[border-color] duration-150 outline-none"
            />
            <span
              className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono text-sm"
              style={{ color: theme.textMuted }}
            >
              %
            </span>
          </div>
          {accountValid && riskPctValid && derivedMaxRisk !== null && (
            <p
              className="mt-1 font-sans text-[10px]"
              style={{ color: theme.textMuted }}
            >
              Max risk:{' '}
              <span className="font-semibold" style={{ color: theme.text }}>
                $
                {derivedMaxRisk.toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
            </p>
          )}
        </div>
      </div>

      {/* Direction toggle */}
      <div>
        <FieldLabel>Direction</FieldLabel>
        <div className="flex gap-1.5">
          {(['long', 'short'] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => onDirectionChange(d)}
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

      {/* Entry | Exit | Contracts */}
      <div className="grid grid-cols-3 gap-3">
        <PriceInput
          id="fc-entry"
          label="Entry Price"
          value={entryInput}
          onChange={onEntryChange}
          placeholder="5500.00"
        />
        <PriceInput
          id="fc-exit"
          label="Exit Price"
          value={exitInput}
          onChange={onExitChange}
          placeholder="5510.00"
        />
        <div>
          <span
            id="fc-contracts-label"
            className="text-tertiary mb-1.5 block font-sans text-[11px] font-bold tracking-[0.08em] uppercase"
          >
            Contracts
          </span>
          <div
            aria-labelledby="fc-contracts-label"
            aria-label="Contracts"
            className="bg-input border-edge-strong flex h-[43px] items-center rounded-lg border-[1.5px]"
          >
            <button
              type="button"
              aria-label="Decrease contracts"
              onClick={onContractsDec}
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
              disabled={
                maxContractsByMargin !== null &&
                contracts >= maxContractsByMargin
              }
              onClick={onContractsInc}
              className="text-secondary hover:text-primary flex h-full w-9 flex-shrink-0 items-center justify-center rounded-r-lg font-mono text-lg leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-30"
            >
              +
            </button>
          </div>
          {maxContractsByMargin !== null &&
            (maxContractsByMargin < 1 ? (
              <p
                className="mt-1 font-sans text-[10px]"
                style={{ color: theme.red }}
              >
                Insufficient margin (need {fmtDollar(spec.dayMargin)})
              </p>
            ) : (
              <p
                className="mt-1 font-sans text-[10px]"
                style={{ color: theme.textMuted }}
              >
                Max{' '}
                <span style={{ color: theme.text }}>
                  {maxContractsByMargin}
                </span>{' '}
                by margin
              </p>
            ))}
        </div>
      </div>

      {/* Adverse (MAE) | Favorable (MFE) — shown only when entry is valid */}
      {entryValid && (
        <div className="grid grid-cols-2 gap-3">
          <PriceInput
            id="fc-adverse"
            label={
              direction === 'long'
                ? 'Adverse / Stop (Low)'
                : 'Adverse / Stop (High)'
            }
            value={adverseInput}
            onChange={onAdverseChange}
            placeholder={direction === 'long' ? '5490.00' : '5510.00'}
          />
          <PriceInput
            id="fc-favorable"
            label={
              direction === 'long'
                ? 'Favorable / Target (High)'
                : 'Favorable / Target (Low)'
            }
            value={favorableInput}
            onChange={onFavorableChange}
            placeholder={direction === 'long' ? '5520.00' : '5480.00'}
          />
        </div>
      )}
    </>
  );
}
