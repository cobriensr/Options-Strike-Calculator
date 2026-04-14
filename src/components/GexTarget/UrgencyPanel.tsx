import { memo, useMemo } from 'react';
import { theme } from '../../themes';
import { SectionBox } from '../ui';
import type { StrikeScore } from '../../utils/gex-target';

export interface UrgencyPanelProps {
  leaderboard: StrikeScore[];
}

function formatDeltaPct(val: number | null): string {
  if (val === null) return '—';
  const sign = val >= 0 ? '+' : '';
  return `${sign}${(val * 100).toFixed(1)}%`;
}

export const UrgencyPanel = memo(function UrgencyPanel({
  leaderboard,
}: Readonly<UrgencyPanelProps>) {
  // Sort ascending by strike so the panel reads like a price ladder:
  // lowest strike (floor) at top, highest (ceiling) at bottom.
  const top5 = useMemo(
    () => [...leaderboard].sort((a, b) => a.strike - b.strike),
    [leaderboard],
  );

  const maxAbs = useMemo(() => {
    const max = Math.max(
      ...top5.map((s) => Math.abs(s.features.deltaPct_5m ?? 0)),
    );
    return max === 0 ? 1 : max;
  }, [top5]);

  // Spot is the same for every row — grab it off the first entry.
  const spot = leaderboard[0]?.features.spot ?? 0;
  const atmStrike = useMemo(() => {
    if (!top5.length || spot === 0) return null;
    return top5.reduce((best, s) =>
      Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best,
    ).strike;
  }, [top5, spot]);

  if (top5.length === 0) {
    return (
      <SectionBox label="5-MIN URGENCY">
        <span
          className="font-mono text-[12px]"
          style={{ color: theme.textMuted }}
        >
          No data
        </span>
      </SectionBox>
    );
  }

  return (
    <SectionBox label="5-MIN URGENCY">
      <div className="flex flex-col gap-1.5">
        {top5.map((s) => {
          const raw = s.features.deltaPct_5m;
          const pct =
            raw === null ? 0 : Math.min(Math.abs(raw) / maxAbs, 1) * 100;
          const isPos = raw === null ? true : raw >= 0;
          const barColor = isPos ? theme.green : theme.red;
          const dimmed = raw === null;

          const isAtm = s.strike === atmStrike;
          return (
            <div
              key={s.strike}
              className={`flex flex-col gap-0.5 rounded px-1 -mx-1${isAtm ? 'bg-sky-500/10' : ''}`}
            >
              <div className="flex items-center justify-between">
                <span
                  className="font-mono text-[12px]"
                  style={{ color: isAtm ? '#7dd3fc' : theme.text }}
                >
                  {s.strike}
                </span>
                <span
                  className="font-mono text-[11px]"
                  style={{ color: isPos ? theme.green : theme.red }}
                >
                  {formatDeltaPct(raw)}
                </span>
              </div>
              <div
                className="relative h-[6px] w-full rounded-full"
                style={{
                  backgroundColor: `color-mix(in srgb, ${theme.border} 20%, transparent)`,
                }}
              >
                <div
                  className="absolute top-0 left-0 h-full rounded-full transition-[width] duration-300"
                  style={{
                    width: `${pct}%`,
                    backgroundColor: barColor,
                    opacity: dimmed ? 0.2 : 0.85,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </SectionBox>
  );
});
