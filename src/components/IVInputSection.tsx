import { useState, useEffect, useRef } from 'react';
import type { Theme } from '../themes';
import type { IVMode, CalculationResults } from '../types';
import { DEFAULTS, IV_MODES } from '../constants';
import { SectionBox, Chip, ErrorMsg } from './ui';
import { tinyLbl } from '../utils/ui-utils';
import VIXRegimeCard from './VIXRegimeCard';
import VIXTermStructure from './VIXTermStructure';
import type { MarketDataState } from '../hooks/useMarketData';

interface Props {
  th: Theme;
  inputCls: string;
  ivMode: IVMode;
  onIvModeChange: (mode: IVMode) => void;
  vixInput: string;
  onVixChange: (v: string) => void;
  multiplier: string;
  onMultiplierChange: (v: string) => void;
  directIVInput: string;
  onDirectIVChange: (v: string) => void;
  dVix: string;
  results: CalculationResults | null;
  errors: Record<string, string>;
  market: MarketDataState;
  onUseVix1dAsSigma: (sigma: number) => void;
}

export default function IVInputSection({
  th,
  inputCls,
  ivMode,
  onIvModeChange,
  vixInput,
  onVixChange,
  multiplier,
  onMultiplierChange,
  directIVInput,
  onDirectIVChange,
  dVix,
  results,
  errors,
  market,
  onUseVix1dAsSigma,
}: Props) {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Tooltip close on outside click + Escape
  useEffect(() => {
    if (!tooltipOpen) return;
    const onMouse = (e: MouseEvent) => {
      if (tooltipRef.current && !tooltipRef.current.contains(e.target as Node))
        setTooltipOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTooltipOpen(false);
    };
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouse);
      document.removeEventListener('keydown', onKey);
    };
  }, [tooltipOpen]);

  return (
    <SectionBox
      th={th}
      label="Implied Volatility"
      headerRight={
        <fieldset className="m-0 border-none p-0">
          <legend className="sr-only">IV input mode</legend>
          <div className="flex gap-1" role="radiogroup">
            {(
              [
                { key: IV_MODES.VIX, label: 'VIX' },
                { key: IV_MODES.DIRECT, label: 'Direct IV' },
              ] as const
            ).map(({ key, label }) => (
              <Chip
                key={key}
                th={th}
                active={ivMode === key}
                onClick={() => onIvModeChange(key)}
                label={label}
              />
            ))}
          </div>
        </fieldset>
      }
    >
      {ivMode === IV_MODES.VIX ? (
        <div className="grid grid-cols-[1fr_140px] items-end gap-2.5">
          <div>
            <label htmlFor="vix-val" className={tinyLbl}>
              VIX Value
            </label>
            <input
              id="vix-val"
              type="text"
              inputMode="decimal"
              placeholder="e.g. 19"
              value={vixInput}
              onChange={(e) => onVixChange(e.target.value)}
              aria-invalid={!!errors['vix']}
              className={inputCls}
            />
          </div>
          <div className="relative" ref={tooltipRef}>
            <div className="mb-1 flex items-center gap-1.5">
              <label htmlFor="mult-val" className={tinyLbl + ' !mb-0'}>
                0DTE Adj.
              </label>
              <button
                onClick={() => setTooltipOpen(!tooltipOpen)}
                aria-expanded={tooltipOpen}
                aria-label="What is the 0DTE adjustment?"
                className="border-edge-strong bg-surface-alt text-tertiary inline-flex h-[18px] w-[18px] cursor-pointer items-center justify-center rounded-full border-[1.5px] p-0 font-sans text-[11px] leading-none font-bold"
              >
                ?
              </button>
            </div>
            <input
              id="mult-val"
              type="text"
              inputMode="decimal"
              placeholder="1.15"
              value={multiplier}
              onChange={(e) => onMultiplierChange(e.target.value)}
              aria-invalid={!!errors['multiplier']}
              aria-describedby="adj-tooltip-content"
              className={inputCls}
            />
            {tooltipOpen && (
              <div
                id="adj-tooltip-content"
                role="tooltip"
                className="bg-tooltip-bg text-tooltip-text absolute -right-5 bottom-[calc(100%+10px)] z-50 w-[340px] rounded-xl p-[18px_20px] font-sans text-[13px] leading-[1.7] font-normal shadow-[0_4px_24px_rgba(0,0,0,0.25)]"
              >
                <div className="mb-2.5 text-[15px] font-bold">
                  0DTE IV Adjustment
                </div>
                <p className="m-0 mb-3">
                  VIX measures <strong>30-day</strong> implied volatility, but
                  same-day (0DTE) options typically trade at{' '}
                  <strong>10{'\u2013'}20% higher IV</strong> than what VIX
                  indicates.
                </p>
                <p className="m-0 mb-3">
                  This multiplier scales VIX upward to approximate actual 0DTE
                  IV. For example, with VIX at 20:
                </p>
                <div className="bg-tooltip-code-bg text-tooltip-code-text mb-3 rounded-lg p-[10px_12px] font-mono text-xs leading-[1.8]">
                  <div>
                    {'\u00D7'} 1.00 {'\u2192'} {'\u03C3'} = 0.200 (raw VIX, no
                    adj.)
                  </div>
                  <div>
                    {'\u00D7'} 1.15 {'\u2192'} {'\u03C3'} = 0.230 (default)
                  </div>
                  <div>
                    {'\u00D7'} 1.20 {'\u2192'} {'\u03C3'} = 0.240 (high-vol)
                  </div>
                </div>
                <p className="m-0 text-xs opacity-85">
                  Range: {DEFAULTS.IV_PREMIUM_MIN}
                  {'\u2013'}
                  {DEFAULTS.IV_PREMIUM_MAX}. This is the largest source of
                  estimation error. Tune based on observed 0DTE straddle
                  pricing.
                </p>
                <div className="bg-tooltip-bg absolute right-8 -bottom-1.5 h-3 w-3 rotate-45" />
              </div>
            )}
          </div>
        </div>
      ) : (
        <div>
          <label htmlFor="direct-iv" className={tinyLbl}>
            {'\u03C3'} as decimal (e.g. 0.22 for 22%)
          </label>
          <input
            id="direct-iv"
            type="text"
            inputMode="decimal"
            placeholder="e.g. 0.22"
            value={directIVInput}
            onChange={(e) => onDirectIVChange(e.target.value)}
            aria-invalid={!!errors['iv']}
            className={inputCls}
          />
        </div>
      )}
      {errors['vix'] && <ErrorMsg th={th}>{errors['vix']}</ErrorMsg>}
      {errors['multiplier'] && (
        <ErrorMsg th={th}>{errors['multiplier']}</ErrorMsg>
      )}
      {errors['iv'] && <ErrorMsg th={th}>{errors['iv']}</ErrorMsg>}

      {ivMode === IV_MODES.VIX &&
        dVix &&
        !errors['vix'] &&
        Number.parseFloat(dVix) > 0 &&
        results && (
          <VIXRegimeCard
            th={th}
            vix={Number.parseFloat(dVix)}
            spot={results.spot}
          />
        )}

      {ivMode === IV_MODES.VIX && dVix && !errors['vix'] && (
        <div className="mt-3.5">
          <div className="text-tertiary mb-2 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
            Term Structure
          </div>
          <VIXTermStructure
            th={th}
            vix={Number.parseFloat(dVix)}
            onUseVix1dAsSigma={onUseVix1dAsSigma}
            initialVix1d={market.data.quotes?.vix1d?.price}
            initialVix9d={market.data.quotes?.vix9d?.price}
            initialVvix={market.data.quotes?.vvix?.price}
          />
        </div>
      )}
    </SectionBox>
  );
}
