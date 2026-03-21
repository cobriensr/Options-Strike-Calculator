import type { Theme } from '../themes';
import type { CalculationResults } from '../types';
import { getKurtosisFactor } from '../constants';
import { SectionBox, Chip } from './ui';

interface Props {
  th: Theme;
  skewPct: number;
  onSkewChange: (v: number) => void;
  showIC: boolean;
  onToggleIC: () => void;
  wingWidth: number;
  onWingWidthChange: (v: number) => void;
  contracts: number;
  onContractsChange: (v: number) => void;
  results?: CalculationResults | null;
}

export default function AdvancedSection({
  th,
  skewPct,
  onSkewChange,
  showIC,
  onToggleIC,
  wingWidth,
  onWingWidthChange,
  contracts,
  onContractsChange,
  results,
}: Props) {
  return (
    <SectionBox
      label="Advanced"
      headerRight={
        <button
          onClick={onToggleIC}
          className={
            'cursor-pointer rounded-md border-[1.5px] p-[5px_12px] font-sans text-xs font-semibold transition-colors duration-100 ' +
            (showIC
              ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text'
              : 'border-chip-border bg-chip-bg text-chip-text hover:border-edge-heavy hover:bg-surface-alt')
          }
        >
          {showIC ? 'Hide' : 'Show'} Iron Condor
        </button>
      }
    >
      {/* Put Skew Slider */}
      <div className={showIC ? 'mb-5' : ''}>
        <div className="mb-1.5 flex items-center justify-between">
          <label
            htmlFor="skew-slider"
            className="text-tertiary font-sans text-[11px] font-bold tracking-[0.08em] uppercase"
          >
            Put Skew
          </label>
          <span className="text-accent font-mono text-sm font-medium">
            {skewPct === 0
              ? 'Off'
              : '+' + skewPct + '% put / \u2212' + skewPct + '% call'}
          </span>
        </div>
        <input
          id="skew-slider"
          type="range"
          min="0"
          max="8"
          step="1"
          value={skewPct}
          onChange={(e) => onSkewChange(Number.parseInt(e.target.value))}
          aria-label={'Put skew adjustment, currently ' + skewPct + ' percent'}
          className="m-0 w-full cursor-pointer"
          style={{ accentColor: th.accent }}
        />
        <div className="text-muted mt-1 flex justify-between font-mono text-[10px]">
          <span>0%</span>
          <span>3%</span>
          <span>5%</span>
          <span>8%</span>
        </div>
        <p className="text-muted mt-1.5 mb-0 text-[11px] italic">
          OTM puts trade at higher IV than calls. Typical 0DTE skew: 2{'\u2013'}
          5%.
        </p>
      </div>

      {/* Iron Condor Wing Width */}
      {showIC && (
        <div className="border-edge border-t pt-3.5">
          <div className="mb-1.5 flex items-center justify-between">
            <label
              htmlFor="wing-width"
              className="text-tertiary font-sans text-[11px] font-bold tracking-[0.08em] uppercase"
            >
              Wing Width (SPX pts)
            </label>
            <span className="text-accent font-mono text-sm font-medium">
              {wingWidth}
            </span>
          </div>
          <div
            className="flex flex-wrap gap-1.5"
            role="radiogroup"
            aria-label="Iron condor wing width"
          >
            {[5, 10, 15, 20, 25, 30, 50].map((w) => (
              <Chip
                key={w}
                active={wingWidth === w}
                onClick={() => onWingWidthChange(w)}
                label={String(w)}
              />
            ))}
          </div>
          <p className="text-muted mt-1.5 mb-0 text-[11px] italic">
            Distance from short strike to long (protective) strike on each side.
          </p>

          {/* Contracts Counter */}
          <div className="border-edge mt-3.5 border-t pt-3.5">
            <div className="flex items-center justify-between">
              <label
                htmlFor="contracts-count"
                className="text-tertiary font-sans text-[11px] font-bold tracking-[0.08em] uppercase"
              >
                Contracts
              </label>
              <div className="flex items-center">
                <button
                  onClick={() => onContractsChange(Math.max(1, contracts - 1))}
                  aria-label="Decrease contracts"
                  className="border-edge-strong bg-chip-bg text-primary flex h-8 w-8 cursor-pointer items-center justify-center rounded-l-md border-[1.5px] border-r-0 font-mono text-base font-bold"
                >
                  {'\u2212'}
                </button>
                <input
                  id="contracts-count"
                  type="text"
                  inputMode="numeric"
                  value={contracts}
                  onChange={(e) => {
                    const v = Number.parseInt(e.target.value);
                    if (!Number.isNaN(v) && v >= 1 && v <= 999)
                      onContractsChange(v);
                    else if (e.target.value === '') onContractsChange(1);
                  }}
                  className="border-edge-strong bg-input text-primary h-8 w-[52px] border-[1.5px] text-center font-mono text-[15px] font-semibold outline-none"
                  aria-label="Number of contracts"
                />
                <button
                  onClick={() =>
                    onContractsChange(Math.min(999, contracts + 1))
                  }
                  aria-label="Increase contracts"
                  className="border-edge-strong bg-chip-bg text-primary flex h-8 w-8 cursor-pointer items-center justify-center rounded-r-md border-[1.5px] border-l-0 font-mono text-base font-bold"
                >
                  +
                </button>
              </div>
            </div>
            <p className="text-muted mt-1.5 mb-0 text-[11px] italic">
              SPX multiplier: $100/pt. P&L table shows per-contract and total
              dollar values.
            </p>
          </div>
        </div>
      )}

      {/* Model Parameters — derived values driving calculations */}
      {results && (
        <div className="border-edge mt-auto border-t pt-3.5">
          <div className="text-tertiary mb-2 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
            Model Parameters
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[
              {
                label: 'Eff. \u03C3',
                value: (results.sigma * 100).toFixed(2) + '%',
              },
              {
                label: 'Hours Left',
                value: results.hoursRemaining.toFixed(1) + 'h',
              },
              {
                label: 'IV Accel',
                value: (() => {
                  const row = results.allDeltas.find((r) => !('error' in r));
                  return row && !('error' in row)
                    ? row.ivAccelMult.toFixed(2) + 'x'
                    : '\u2014';
                })(),
              },
              {
                label: 'Kurtosis',
                value: getKurtosisFactor(results.vix).toFixed(1) + 'x',
              },
            ].map(({ label, value }) => (
              <div
                key={label}
                className="bg-surface-alt rounded-lg p-[8px_10px]"
              >
                <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
                  {label}
                </div>
                <div className="text-primary mt-0.5 font-mono text-[15px] font-medium">
                  {value}
                </div>
              </div>
            ))}
          </div>

          {/* Position Snapshot — 10Δ IC boundaries + max risk */}
          {(() => {
            const ref = results.allDeltas.find(
              (r) => !('error' in r) && r.delta === 10,
            );
            if (!ref || 'error' in ref) return null;
            const maxLossPerContract = wingWidth * 100;
            const totalMaxLoss = maxLossPerContract * contracts;
            const rangeWidth = ref.callSnapped - ref.putSnapped;
            const rangePct = ((rangeWidth / results.spot) * 100).toFixed(1);
            return (
              <div className="border-edge mt-3.5 border-t pt-3.5">
                <div className="text-tertiary mb-2 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
                  10{'\u0394'} IC Snapshot
                </div>
                <div className="bg-surface-alt rounded-lg p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-sm font-medium text-red-400">
                      {ref.putSnapped}
                    </span>
                    <div className="mx-2 flex flex-1 flex-col items-center">
                      <span className="text-tertiary text-[10px]">
                        {rangePct}% range
                      </span>
                      <div className="bg-edge relative my-1 h-[3px] w-full rounded">
                        <div
                          className="bg-accent absolute inset-y-0 rounded"
                          style={{ left: '10%', right: '10%' }}
                        />
                        <div className="bg-accent absolute top-1/2 left-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full" />
                      </div>
                      <span className="text-muted font-mono text-[10px]">
                        {results.spot.toFixed(0)}
                      </span>
                    </div>
                    <span className="font-mono text-sm font-medium text-green-400">
                      {ref.callSnapped}
                    </span>
                  </div>
                </div>
                {showIC && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div className="bg-surface-alt rounded-lg p-[8px_10px]">
                      <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
                        Max Loss
                      </div>
                      <div className="text-primary mt-0.5 font-mono text-[15px] font-medium">
                        ${totalMaxLoss.toLocaleString()}
                      </div>
                    </div>
                    <div className="bg-surface-alt rounded-lg p-[8px_10px]">
                      <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
                        Per Contract
                      </div>
                      <div className="text-primary mt-0.5 font-mono text-[15px] font-medium">
                        ${maxLossPerContract.toLocaleString()}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </SectionBox>
  );
}
