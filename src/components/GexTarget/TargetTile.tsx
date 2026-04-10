import { memo } from 'react';
import { theme } from '../../themes';
import { SectionBox, StatusBadge } from '../ui';
import type { TargetScore, StrikeScore } from '../../utils/gex-target';

export interface TargetTileProps {
  score: TargetScore | null;
}

function formatDeltaPct(val: number | null): string {
  if (val === null) return '—';
  const sign = val >= 0 ? '+' : '';
  return `${sign}${(val * 100).toFixed(1)}%`;
}

function WallLabel({ target }: Readonly<{ target: StrikeScore }>) {
  if (target.tier === 'NONE') {
    return (
      <span
        className="text-[11px] tracking-wide uppercase"
        style={{ color: theme.textMuted }}
      >
        No Target
      </span>
    );
  }

  const label =
    target.wallSide === 'CALL'
      ? 'Call Wall'
      : target.wallSide === 'PUT'
        ? 'Put Wall'
        : 'No Target';

  const color =
    target.wallSide === 'CALL'
      ? theme.green
      : target.wallSide === 'PUT'
        ? theme.red
        : theme.textMuted;

  return (
    <span className="text-[11px] tracking-wide uppercase" style={{ color }}>
      {label}
    </span>
  );
}

function TierBadge({ target }: Readonly<{ target: StrikeScore }>) {
  if (target.tier === 'NONE') return null;

  const color =
    target.tier === 'HIGH'
      ? theme.green
      : target.tier === 'MEDIUM'
        ? theme.caution
        : theme.textMuted;

  return <StatusBadge label={target.tier} color={color} />;
}

function StatsRow({ target }: Readonly<{ target: StrikeScore }>) {
  const stats = [
    { label: '5m Δ%', value: formatDeltaPct(target.features.deltaPct_5m) },
    { label: '20m Δ%', value: formatDeltaPct(target.features.deltaPct_20m) },
    {
      label: 'Dist',
      value: `${target.features.distFromSpot.toFixed(0)} pts`,
    },
    { label: 'Score', value: target.finalScore.toFixed(2) },
  ];

  return (
    <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-[var(--color-edge)] pt-3">
      {stats.map(({ label, value }) => (
        <div key={label} className="flex flex-col gap-0.5">
          <span
            className="text-[9px] tracking-wide uppercase"
            style={{ color: theme.textMuted }}
          >
            {label}
          </span>
          <span
            className="font-mono text-[13px] font-semibold"
            style={{ color: theme.text }}
          >
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

export const TargetTile = memo(function TargetTile({
  score,
}: Readonly<TargetTileProps>) {
  const target = score?.target ?? null;
  const hasTarget = target !== null && target.tier !== 'NONE';

  return (
    <SectionBox label="TARGET STRIKE">
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between">
          <div className="flex flex-col gap-1">
            <span
              className="font-mono text-4xl leading-none font-bold"
              style={{ color: hasTarget ? theme.text : theme.textMuted }}
            >
              {hasTarget ? target.strike.toString() : '— —'}
            </span>
            <div className="flex items-center gap-2">
              {target ? (
                <WallLabel target={target} />
              ) : (
                <span
                  className="text-[11px] tracking-wide uppercase"
                  style={{ color: theme.textMuted }}
                >
                  No Target
                </span>
              )}
            </div>
          </div>
          {target && <TierBadge target={target} />}
        </div>

        {target ? (
          <StatsRow target={target} />
        ) : (
          <div
            className="py-4 text-center font-mono text-[12px]"
            style={{ color: theme.textMuted }}
          >
            Waiting for scoring data…
          </div>
        )}
      </div>
    </SectionBox>
  );
});
