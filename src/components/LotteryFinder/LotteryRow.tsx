import { memo } from 'react';
import type { ExitPolicy, LotteryFire } from './types.js';
import { EXIT_POLICY_LABELS, EXIT_POLICY_TOOLTIPS } from './types.js';

interface LotteryRowProps {
  fire: LotteryFire;
  /** Which realized exit policy to surface as the primary number. */
  exitPolicy: ExitPolicy;
}

const formatTimeCT = (iso: string): string => {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Chicago',
  });
};

const formatPct = (n: number | null): string => {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
};

const formatDollar = (n: number): string => {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
};

const pctClass = (n: number | null): string => {
  if (n == null) return 'text-neutral-500';
  if (n >= 50) return 'text-green-300';
  if (n >= 0) return 'text-green-400';
  if (n >= -25) return 'text-amber-300';
  return 'text-red-300';
};

const optionTypeBadge = (t: 'C' | 'P'): string =>
  t === 'C'
    ? 'border-green-500/40 bg-green-950/30 text-green-200'
    : 'border-red-500/40 bg-red-950/30 text-red-200';

const todBadge = (tod: string): string => {
  switch (tod) {
    case 'AM_open':
      return 'border-amber-500/40 bg-amber-950/30 text-amber-200';
    case 'MID':
      return 'border-blue-500/40 bg-blue-950/30 text-blue-200';
    case 'LUNCH':
      return 'border-neutral-700 bg-neutral-900 text-neutral-300';
    case 'PM':
      return 'border-purple-500/40 bg-purple-950/30 text-purple-200';
    default:
      return 'border-neutral-700 bg-neutral-900 text-neutral-300';
  }
};

const tideBadge = (
  diff: number | null,
): { label: string; cls: string; tooltip: string } | null => {
  if (diff == null) return null;
  const arrow = diff > 0 ? '⬆' : diff < 0 ? '⬇' : '→';
  const cls =
    diff > 0
      ? 'border-green-500/40 bg-green-950/30 text-green-200'
      : diff < 0
        ? 'border-red-500/40 bg-red-950/30 text-red-200'
        : 'border-neutral-700 bg-neutral-900 text-neutral-300';
  return {
    label: `Tide ${arrow}`,
    cls,
    tooltip: `Market Tide NCP - NPP at fire time = ${diff.toFixed(0)}. Display-only; not a selection signal (see spec Appendix A).`,
  };
};

export const LotteryRow = memo(function LotteryRow({
  fire,
  exitPolicy,
}: LotteryRowProps) {
  const realized = fire.outcomes[exitPolicy];
  const peak = fire.outcomes.peakCeilingPct;
  const tide = tideBadge(fire.macro.mktTideDiff);

  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* Ticker + strike + side */}
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-base font-semibold text-white">
            {fire.underlyingSymbol}
          </span>
          <span className="font-mono text-base text-neutral-200">
            {fire.strike}
          </span>
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${optionTypeBadge(fire.optionType)}`}
            title={fire.optionType === 'C' ? 'Call' : 'Put'}
          >
            {fire.optionType}
          </span>
        </div>

        {/* Time of trigger */}
        <span className="font-mono text-xs text-neutral-400">
          {formatTimeCT(fire.triggerTimeCt)} CT
        </span>

        {/* Alert seq + RE-LOAD + cheap-call-PM badges */}
        <span className="text-[11px] text-neutral-400">
          fire #{fire.entry.alertSeq}
        </span>
        {fire.tags.reload && (
          <span
            className="rounded border border-amber-500/40 bg-amber-950/30 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200"
            title="RE-LOAD: this fire's burst is ≥2× the prior fire on the same chain AND entry price dropped ≥30% since prior. 9.1% historical lottery rate vs 1.4% non-RE-LOAD."
          >
            RE-LOAD
          </span>
        )}
        {fire.tags.cheapCallPm && (
          <span
            className="rounded border border-fuchsia-500/40 bg-fuchsia-950/30 px-1.5 py-0.5 text-[10px] font-semibold text-fuchsia-200"
            title="Cheap-call-PM: entry < $1, call, PM session. The selection rule from the 15-day backtest — 18.9% lottery rate vs 9.1% RE-LOAD baseline. Caveat: edge concentrated in 1-2 outlier days/15."
          >
            cheap-call-PM
          </span>
        )}

        {/* Time-of-day badge */}
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${todBadge(fire.tags.tod)}`}
          title="Time-of-day bucket — AM_open / MID / LUNCH / PM"
        >
          {fire.tags.tod}
        </span>

        {/* Macro context: only Market Tide today (compact). */}
        {tide && (
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${tide.cls}`}
            title={tide.tooltip}
          >
            {tide.label}
          </span>
        )}

        {/* Spacer pushes the realized number to the right */}
        <span className="flex-1" />

        {/* Realized return under the selected policy + peak ceiling */}
        <div className="flex items-baseline gap-3">
          <span
            className={`font-mono text-lg font-bold ${pctClass(realized)}`}
            title={EXIT_POLICY_TOOLTIPS[exitPolicy]}
          >
            {formatPct(realized)}
          </span>
          <span
            className="text-[10px] text-neutral-500"
            title="Best-case peak return — % gain at the highest post-entry print. Look-ahead reference, not tradeable."
          >
            peak {formatPct(peak)}
          </span>
        </div>
      </div>

      {/* Second row: entry + flow + trigger */}
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-neutral-400">
        <span>
          entry{' '}
          <span className="font-mono text-neutral-200">
            {formatDollar(fire.entry.price)}
          </span>
        </span>
        <span>
          spot{' '}
          <span className="font-mono text-neutral-300">
            {fire.entry.spotAtFirst.toFixed(2)}
          </span>
        </span>
        <span>
          IV{' '}
          <span className="font-mono text-neutral-300">
            {(fire.trigger.iv * 100).toFixed(0)}%
          </span>
        </span>
        <span>
          Δ{' '}
          <span className="font-mono text-neutral-300">
            {fire.trigger.delta.toFixed(2)}
          </span>
        </span>
        <span>
          ask%{' '}
          <span className="font-mono text-neutral-300">
            {(fire.trigger.askPct * 100).toFixed(0)}%
          </span>
        </span>
        <span>
          win-vol/OI{' '}
          <span className="font-mono text-neutral-300">
            {(fire.trigger.volToOiWindow * 100).toFixed(0)}%
          </span>
        </span>
        <span className="ml-auto text-neutral-500">
          {EXIT_POLICY_LABELS[exitPolicy]}
        </span>
      </div>
    </div>
  );
});
