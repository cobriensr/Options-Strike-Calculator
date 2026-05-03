/**
 * StrikeRow — one row of the Strike Battle Map.
 *
 * Layout per row:
 *
 *   [strike] | [────── flow bar ──────] | [────── gamma bar ──────]
 *
 * Both bars are anchored on a centered zero axis and extend left
 * (negative / bearish or amplifying) or right (positive / bullish or
 * dampening). Bar width is normalized against the largest absolute
 * magnitude in the visible set so cross-strike comparison stays
 * proportional within the panel.
 *
 * Visual conventions:
 *   - Customer-flow bar: green when positive (bullish demand at strike),
 *     red when negative (bearish demand). Matches the FlowChart gradient
 *     used by the Greek Flow panel for consistency.
 *   - Dealer-gamma bar: blue when positive (long γ, dampening), orange
 *     when negative (short γ, amplifying). Distinct hue from the flow
 *     bar because the *meaning* of sign is different — flow is customer
 *     intent, gamma is dealer mechanics.
 *   - Magnet highlight: a bright border around the row that holds the
 *     top-1 customer-flow magnitude, surfacing the magnet candidate
 *     visually without requiring the trader to read numbers.
 */

import { memo } from 'react';

interface StrikeRowProps {
  strike: number;
  flowSigned: number;
  flowMagMax: number;
  gammaSigned: number;
  gammaMagMax: number;
  isMagnet: boolean;
}

const FLOW_POS = 'bg-emerald-400/80';
const FLOW_NEG = 'bg-rose-400/80';
const GAMMA_POS = 'bg-sky-400/70';
const GAMMA_NEG = 'bg-amber-400/80';

function widthPct(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  // Cap at 50% so each side fills at most half the bar track.
  return Math.min(50, (Math.abs(value) / max) * 50);
}

interface BarProps {
  signed: number;
  max: number;
  posClass: string;
  negClass: string;
  label: string;
}

function Bar({ signed, max, posClass, negClass, label }: BarProps) {
  const pct = widthPct(signed, max);
  const isPos = signed > 0;
  const colorClass = signed === 0 ? '' : isPos ? posClass : negClass;
  return (
    <div
      className="border-edge bg-surface relative h-3 overflow-hidden rounded-sm border"
      role="img"
      aria-label={`${label}: ${signed.toLocaleString('en-US', {
        maximumFractionDigits: 0,
        signDisplay: 'auto',
      })}`}
    >
      {/* Centered zero axis */}
      <div className="bg-secondary/40 absolute top-0 left-1/2 h-full w-px" />
      {/* Bar fill — positions on left or right of center based on sign */}
      <div
        className={`absolute top-0 h-full ${colorClass}`}
        style={
          isPos
            ? { left: '50%', width: `${pct}%` }
            : { right: '50%', width: `${pct}%` }
        }
      />
    </div>
  );
}

function StrikeRowInner({
  strike,
  flowSigned,
  flowMagMax,
  gammaSigned,
  gammaMagMax,
  isMagnet,
}: StrikeRowProps) {
  const containerClasses = [
    'grid grid-cols-[3rem_1fr_1fr] items-center gap-2 rounded-sm px-1 py-0.5',
    isMagnet ? 'border-emerald-300/60 ring-emerald-300/40 ring-1' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={containerClasses} data-testid={`strike-row-${strike}`}>
      <span className="text-primary font-mono text-[10px]">{strike}</span>
      <Bar
        signed={flowSigned}
        max={flowMagMax}
        posClass={FLOW_POS}
        negClass={FLOW_NEG}
        label={`flow at ${strike}`}
      />
      <Bar
        signed={gammaSigned}
        max={gammaMagMax}
        posClass={GAMMA_POS}
        negClass={GAMMA_NEG}
        label={`dealer gamma at ${strike}`}
      />
    </div>
  );
}

export const StrikeRow = memo(StrikeRowInner);
