import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';

export interface RatioTrajectory {
  /** Signed delta (current − baseline). */
  delta: number;
  /** Elapsed minutes between baseline and current snapshot. */
  spanMin: number;
}

interface Props {
  title: string;
  subtitle: string;
  ratio: number;
  label: string;
  color: string;
  advice: string;
  trajectory?: RatioTrajectory | null;
}

/**
 * Thresholds for colorizing the trajectory line. Rising ratios are
 * flagged because term-structure tightening (ratio → 1.0+) is the
 * regime change the trader cares about; falling ratios normalize.
 */
const TRAJECTORY_MUTED_BELOW = 0.02;
const TRAJECTORY_RED_ABOVE = 0.1;
const TRAJECTORY_CAUTION_ABOVE = 0.05;

function trajectoryColor(delta: number): string {
  const abs = Math.abs(delta);
  if (abs < TRAJECTORY_MUTED_BELOW) return theme.textMuted;
  if (delta > 0) return abs >= TRAJECTORY_RED_ABOVE ? theme.red : theme.caution;
  return abs >= TRAJECTORY_CAUTION_ABOVE ? theme.green : theme.textMuted;
}

function formatDelta(delta: number): string {
  const rounded = Math.round(delta * 100) / 100;
  if (rounded === 0) return '\u00B10.00';
  const sign = rounded > 0 ? '+' : '\u2212';
  return `${sign}${Math.abs(rounded).toFixed(2)}`;
}

export default function RatioCard({
  title,
  subtitle,
  ratio,
  label,
  color,
  advice,
  trajectory,
}: Readonly<Props>) {
  const trajectoryHue = trajectory
    ? trajectoryColor(trajectory.delta)
    : theme.textMuted;
  return (
    <div className="bg-surface border-edge rounded-[10px] border p-3 sm:p-3.5">
      <div className="mb-2 flex items-start justify-between">
        <div>
          <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
            {title}
          </div>
          <div className="text-muted font-sans text-[10px]">{subtitle}</div>
        </div>
        <span
          className="rounded-full px-2 py-0.5 font-sans text-[10px] font-bold tracking-[0.06em] uppercase"
          style={{ backgroundColor: tint(color, '18'), color }}
        >
          {label}
        </span>
      </div>

      <div className="mb-1.5 flex items-baseline gap-2">
        <div className="font-mono text-[22px] font-extrabold" style={{ color }}>
          {ratio.toFixed(2)}x
        </div>
        {trajectory && (
          <div
            className="font-mono text-[10px] font-semibold tracking-tight"
            style={{ color: trajectoryHue }}
            aria-label={`15-minute change ${formatDelta(trajectory.delta)}`}
          >
            {formatDelta(trajectory.delta)}
            <span className="text-muted ml-1 font-sans font-normal">
              {'/ '}
              {trajectory.spanMin}m
            </span>
          </div>
        )}
      </div>

      {/* Ratio bar visualization */}
      <div className="mb-2">
        <div className="bg-surface-alt relative h-1.5 overflow-hidden rounded-[3px]">
          <div
            className="absolute top-0 left-0 h-full rounded-[3px] transition-[width] duration-300"
            style={{
              width: Math.min(ratio / 2, 1) * 100 + '%',
              backgroundColor: color,
            }}
          />
          {/* 1.0x marker */}
          <div
            className="absolute -top-px left-1/2 h-2 w-0.5"
            style={{ backgroundColor: tint(theme.textMuted, '60') }}
          />
        </div>
        <div className="text-muted mt-0.5 flex justify-between font-mono text-[8px]">
          <span>0.5x</span>
          <span>1.0x</span>
          <span>1.5x</span>
          <span>2.0x</span>
        </div>
      </div>

      <div className="text-secondary font-sans text-[11px] leading-normal">
        {advice}
      </div>
    </div>
  );
}
