import { memo } from 'react';
import { theme } from '../../themes';
import { SectionBox, StatusBadge } from '../ui';
import type {
  TargetScore,
  StrikeScore,
  ComponentScores,
} from '../../utils/gex-target';

export interface TargetTileProps {
  score: TargetScore | null;
}

type SignedBarKey = 'flowConfluence' | 'priceConfirm' | 'charmScore';
type UnsignedBarKey = 'dominance' | 'clarity' | 'proximity';

const SIGNED_BARS: { key: SignedBarKey; label: string }[] = [
  { key: 'flowConfluence', label: 'Flow' },
  { key: 'priceConfirm', label: 'Price' },
  { key: 'charmScore', label: 'Charm' },
];

const UNSIGNED_BARS: { key: UnsignedBarKey; label: string }[] = [
  { key: 'dominance', label: 'Dom' },
  { key: 'clarity', label: 'Clarity' },
  { key: 'proximity', label: 'Prox' },
];

function formatDeltaPct(val: number | null): string {
  if (val === null) return '—';
  const sign = val >= 0 ? '+' : '';
  return `${sign}${(val * 100).toFixed(1)}%`;
}

function SignedBar({
  label,
  value,
}: Readonly<{ label: string; value: number }>) {
  const pct = Math.min(Math.abs(value), 1) * 50;
  const isPos = value >= 0;
  const barColor = isPos ? theme.green : theme.red;

  return (
    <div className="flex items-center gap-2">
      <span
        className="w-[52px] shrink-0 text-[10px] tracking-wide uppercase"
        style={{ color: theme.textMuted }}
      >
        {label}
      </span>
      <div className="relative flex h-[5px] flex-1 items-center">
        <div
          className="absolute inset-0 rounded-full opacity-10"
          style={{ backgroundColor: theme.border }}
        />
        <div
          className="absolute top-0 bottom-0 w-px"
          style={{ left: '50%', backgroundColor: theme.border }}
        />
        {isPos ? (
          <div
            className="absolute top-0 bottom-0 rounded-r-full"
            style={{
              left: '50%',
              width: `${pct}%`,
              backgroundColor: barColor,
            }}
          />
        ) : (
          <div
            className="absolute top-0 bottom-0 rounded-l-full"
            style={{
              right: '50%',
              width: `${pct}%`,
              backgroundColor: barColor,
            }}
          />
        )}
      </div>
      <span
        className="w-[36px] shrink-0 text-right font-mono text-[10px]"
        style={{ color: isPos ? theme.green : theme.red }}
      >
        {value.toFixed(2)}
      </span>
    </div>
  );
}

function UnsignedBar({
  label,
  value,
}: Readonly<{ label: string; value: number }>) {
  const pct = Math.min(Math.max(value, 0), 1) * 100;

  return (
    <div className="flex items-center gap-2">
      <span
        className="w-[52px] shrink-0 text-[10px] tracking-wide uppercase"
        style={{ color: theme.textMuted }}
      >
        {label}
      </span>
      <div className="relative h-[5px] flex-1 rounded-full">
        <div
          className="absolute inset-0 rounded-full opacity-10"
          style={{ backgroundColor: theme.border }}
        />
        <div
          className="absolute top-0 bottom-0 left-0 rounded-full"
          style={{
            width: `${pct}%`,
            backgroundColor: theme.green,
          }}
        />
      </div>
      <span
        className="w-[36px] shrink-0 text-right font-mono text-[10px]"
        style={{ color: theme.textMuted }}
      >
        {value.toFixed(2)}
      </span>
    </div>
  );
}

function ComponentBars({
  components,
}: Readonly<{ components: ComponentScores }>) {
  return (
    <div className="flex flex-col gap-1.5">
      {SIGNED_BARS.map(({ key, label }) => (
        <SignedBar key={key} label={label} value={components[key]} />
      ))}
      {UNSIGNED_BARS.map(({ key, label }) => (
        <UnsignedBar key={key} label={label} value={components[key]} />
      ))}
    </div>
  );
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
    <div className="mt-3 grid grid-cols-4 gap-2 border-t border-[var(--color-edge)] pt-3">
      {stats.map(({ label, value }) => (
        <div key={label} className="flex flex-col gap-0.5">
          <span
            className="text-[10px] tracking-wide uppercase"
            style={{ color: theme.textMuted }}
          >
            {label}
          </span>
          <span
            className="font-mono text-[12px] font-medium"
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
          <>
            <ComponentBars components={target.components} />
            <StatsRow target={target} />
          </>
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
