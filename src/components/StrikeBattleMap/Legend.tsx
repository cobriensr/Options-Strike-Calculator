/**
 * Legend — explains the Strike Battle Map's bar / color / ring semantics.
 *
 * Three rows mirror the three visual axes a row encodes:
 *   1. Top bar — customer directional flow at the strike.
 *   2. Bottom bar — dealer net gamma at the strike.
 *   3. Strike highlight — the magnet ring (pin candidate).
 *
 * Color tokens are duplicated from StrikeRow.tsx so the swatches stay
 * in sync; if either side changes, update both. Kept inline rather than
 * imported to avoid coupling the visual component to the legend's copy.
 */

import { memo } from 'react';

interface ChipProps {
  swatchClass: string;
  label: string;
  hint: string;
}

function Chip({ swatchClass, label, hint }: ChipProps) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={`inline-block h-2.5 w-3.5 shrink-0 rounded-sm ${swatchClass}`}
      />
      <span className="text-primary font-medium">{label}</span>
      <span className="text-secondary">— {hint}</span>
    </span>
  );
}

function LegendInner() {
  return (
    <dl className="text-secondary mb-3 grid grid-cols-1 gap-x-6 gap-y-1 font-sans text-[10px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <dt className="text-secondary w-24 shrink-0 font-mono">Top bar</dt>
        <dd className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Chip
            swatchClass="bg-emerald-400/80"
            label="bullish flow"
            hint="ask-side calls > bid-side calls at strike"
          />
          <Chip
            swatchClass="bg-rose-400/80"
            label="bearish flow"
            hint="ask-side puts > bid-side puts at strike"
          />
        </dd>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <dt className="text-secondary w-24 shrink-0 font-mono">Bottom bar</dt>
        <dd className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Chip
            swatchClass="bg-sky-400/70"
            label="dealer long γ"
            hint="dampening — price tends to mean-revert here"
          />
          <Chip
            swatchClass="bg-amber-400/80"
            label="dealer short γ"
            hint="amplifying — price tends to accelerate here"
          />
        </dd>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <dt className="text-secondary w-24 shrink-0 font-mono">
          Row highlight
        </dt>
        <dd className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Chip
            swatchClass="border-emerald-300/60 ring-emerald-300/40 ring-1 border"
            label="magnet"
            hint="top-1 flow strike with > 50% of top-5 magnitude (pin candidate)"
          />
        </dd>
      </div>
    </dl>
  );
}

export const Legend = memo(LegendInner);
