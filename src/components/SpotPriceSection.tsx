import { theme } from '../themes';
import { SectionBox, ErrorMsg } from './ui';
import { tinyLbl, inputCls } from '../utils/ui-utils';

interface Props {
  spotPrice: string;
  onSpotChange: (v: string) => void;
  spxDirect: string;
  onSpxDirectChange: (v: string) => void;
  spxRatio: number;
  onSpxRatioChange: (v: number) => void;
  dSpot: string;
  effectiveRatio: number;
  spxDirectActive: boolean;
  derivedRatio: number;
  errors: Record<string, string>;
}

export default function SpotPriceSection({
  spotPrice,
  onSpotChange,
  spxDirect,
  onSpxDirectChange,
  spxRatio,
  onSpxRatioChange,
  dSpot,
  effectiveRatio,
  spxDirectActive,
  derivedRatio,
  errors,
}: Props) {
  return (
    <SectionBox label="Spot Price">
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label htmlFor="spot-price" className={tinyLbl}>
            SPY Price
          </label>
          <input
            id="spot-price"
            type="text"
            inputMode="decimal"
            placeholder="e.g. 672"
            value={spotPrice}
            onChange={(e) => onSpotChange(e.target.value)}
            aria-invalid={!!errors['spot']}
            aria-describedby={errors['spot'] ? 'spot-err' : undefined}
            className={inputCls}
          />
        </div>
        <div>
          <label htmlFor="spx-direct" className={tinyLbl}>
            SPX Price{' '}
            <span className="text-muted font-normal tracking-normal normal-case">
              (optional)
            </span>
          </label>
          <input
            id="spx-direct"
            type="text"
            inputMode="decimal"
            placeholder="e.g. 6731"
            value={spxDirect}
            onChange={(e) => onSpxDirectChange(e.target.value)}
            className={inputCls}
          />
        </div>
      </div>
      {errors['spot'] && <ErrorMsg id="spot-err">{errors['spot']}</ErrorMsg>}
      {dSpot && !errors['spot'] && Number.parseFloat(dSpot) > 0 && (
        <div className="bg-surface-alt mt-3 rounded-lg p-[12px_14px]">
          {spxDirectActive ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-tertiary font-sans text-[11px] font-bold tracking-[0.08em] uppercase">
                  Derived ratio
                </span>
                <span className="text-accent font-mono text-sm font-medium">
                  {derivedRatio.toFixed(4)}
                </span>
              </div>
              <div className="text-muted mt-1.5 text-xs italic">
                Using actual SPX value. Clear SPX field to use slider.
              </div>
            </>
          ) : (
            <>
              <div className="mb-2 flex items-center justify-between">
                <label
                  htmlFor="spx-ratio"
                  className="text-tertiary m-0 font-sans text-[11px] font-bold tracking-[0.08em] uppercase"
                >
                  SPX/SPY Ratio
                </label>
                <span className="text-accent font-mono text-sm font-medium">
                  {spxRatio.toFixed(2)}
                </span>
              </div>
              <input
                id="spx-ratio"
                type="range"
                min="9.95"
                max="10.05"
                step="0.01"
                value={spxRatio}
                onChange={(e) =>
                  onSpxRatioChange(Number.parseFloat(e.target.value))
                }
                aria-label={
                  'SPX to SPY ratio, currently ' + spxRatio.toFixed(2)
                }
                aria-valuemin={9.95}
                aria-valuemax={10.05}
                aria-valuenow={spxRatio}
                className="m-0 w-full cursor-pointer"
                style={{ accentColor: theme.accent }}
              />
              <div className="text-muted mt-1 flex justify-between font-mono text-[10px]">
                <span>9.95</span>
                <span>10.00</span>
                <span>10.05</span>
              </div>
            </>
          )}
          <div className="border-edge mt-2.5 flex items-baseline justify-between border-t pt-2">
            <span className="text-tertiary font-sans text-xs font-semibold">
              SPX for calculations
            </span>
            <span className="text-primary font-mono text-lg font-semibold">
              {(Number.parseFloat(dSpot) * effectiveRatio).toFixed(0)}
            </span>
          </div>
        </div>
      )}
    </SectionBox>
  );
}
