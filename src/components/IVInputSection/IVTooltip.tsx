import { DEFAULTS } from '../../constants';

interface Props {
  open: boolean;
}

export default function IVTooltip({ open }: Props) {
  if (!open) return null;

  return (
    <div
      id="adj-tooltip-content"
      role="tooltip"
      className="bg-tooltip-bg text-tooltip-text absolute -right-5 bottom-[calc(100%+10px)] z-50 w-[340px] rounded-xl p-[18px_20px] font-sans text-[13px] leading-[1.7] font-normal shadow-[0_4px_24px_rgba(0,0,0,0.25)]"
    >
      <div className="mb-2.5 text-[15px] font-bold">0DTE IV Adjustment</div>
      <p className="m-0 mb-3">
        VIX measures <strong>30-day</strong> implied volatility, but same-day
        (0DTE) options typically trade at{' '}
        <strong>10{'\u2013'}20% higher IV</strong> than what VIX indicates.
      </p>
      <p className="m-0 mb-3">
        This multiplier scales VIX upward to approximate actual 0DTE IV. For
        example, with VIX at 20:
      </p>
      <div className="bg-tooltip-code-bg text-tooltip-code-text mb-3 rounded-lg p-[10px_12px] font-mono text-xs leading-[1.8]">
        <div>
          {'\u00D7'} 1.00 {'\u2192'} {'\u03C3'} = 0.200 (raw VIX, no adj.)
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
        {DEFAULTS.IV_PREMIUM_MAX}. This is the largest source of estimation
        error. Tune based on observed 0DTE straddle pricing.
      </p>
      <div className="bg-tooltip-bg absolute right-8 -bottom-1.5 h-3 w-3 rotate-45" />
    </div>
  );
}
