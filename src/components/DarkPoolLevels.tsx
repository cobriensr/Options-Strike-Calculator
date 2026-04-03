/**
 * DarkPoolLevels — compact dashboard widget showing institutional
 * dark pool block trade clusters, auto-refreshed every 60 seconds.
 *
 * Displays SPX levels where large ($5M+) SPY dark pool prints have
 * clustered, filtered to $100M+ aggregate premium. Color-coded by
 * direction: green for buyer-initiated, red for seller-initiated,
 * gray for mixed. Horizontal bars show relative premium magnitude.
 */

import { memo, useMemo } from 'react';
import { theme } from '../themes';
import { SectionBox } from './ui';
import type { DarkPoolLevel } from '../hooks/useDarkPoolLevels';

const PREMIUM_FLOOR = 25_000_000; // $25M minimum to display

interface Props {
  levels: DarkPoolLevel[];
  loading: boolean;
  error: string | null;
  updatedAt: string | null;
}

const DIRECTION_COLORS: Record<
  DarkPoolLevel['direction'],
  { bar: string; text: string; label: string }
> = {
  BUY: {
    bar: 'var(--color-success)',
    text: 'var(--color-success)',
    label: 'BUY',
  },
  SELL: {
    bar: 'var(--color-danger)',
    text: 'var(--color-danger)',
    label: 'SELL',
  },
  MIXED: {
    bar: 'var(--color-muted)',
    text: 'var(--color-muted)',
    label: 'MIXED',
  },
};

function formatPremium(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(0)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(0)}K`;
  return `$${abs.toFixed(0)}`;
}

function formatTime(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/New_York',
    });
  } catch {
    return '';
  }
}

export default memo(function DarkPoolLevels({
  levels,
  loading,
  error,
  updatedAt,
}: Props) {
  const filtered = useMemo(
    () => levels.filter((l) => l.totalPremium >= PREMIUM_FLOOR),
    [levels],
  );

  const maxPremium = useMemo(
    () =>
      filtered.length > 0
        ? Math.max(...filtered.map((l) => l.totalPremium))
        : 1,
    [filtered],
  );

  const totalClusters = levels.length;

  const badge =
    totalClusters > 0 ? `${filtered.length} of ${totalClusters}` : null;

  const headerRight = updatedAt ? (
    <span className="text-muted font-sans text-[10px]">
      {formatTime(updatedAt)}
    </span>
  ) : null;

  if (loading) {
    return (
      <SectionBox label="Dark Pool Levels" headerRight={headerRight}>
        <div className="text-muted animate-pulse text-center font-sans text-xs">
          Loading dark pool data...
        </div>
      </SectionBox>
    );
  }

  if (error) {
    return (
      <SectionBox label="Dark Pool Levels" headerRight={headerRight}>
        <div className="text-muted text-center font-sans text-xs">{error}</div>
      </SectionBox>
    );
  }

  if (filtered.length === 0) {
    return (
      <SectionBox
        label="Dark Pool Levels"
        badge={badge}
        headerRight={headerRight}
      >
        <div className="text-muted text-center font-sans text-xs">
          No clusters above $25M threshold
        </div>
      </SectionBox>
    );
  }

  return (
    <SectionBox
      label="Dark Pool Levels"
      badge={badge}
      headerRight={headerRight}
    >
      <div role="table" aria-label="Dark pool levels">
        <div className="sr-only" role="row">
          <span role="columnheader">SPX Level</span>
          <span role="columnheader">Premium</span>
          <span role="columnheader">Direction</span>
          <span role="columnheader">Blocks</span>
          <span role="columnheader">Time</span>
        </div>
        {filtered.map((level) => (
          <LevelRow
            key={level.spxApprox}
            level={level}
            maxPremium={maxPremium}
          />
        ))}
      </div>
    </SectionBox>
  );
});

function LevelRow({
  level,
  maxPremium,
}: {
  level: DarkPoolLevel;
  maxPremium: number;
}) {
  const colors = DIRECTION_COLORS[level.direction];
  const barWidth = Math.max((level.totalPremium / maxPremium) * 100, 2);

  return (
    <div role="row" className="flex items-center gap-2 py-1.5">
      {/* SPX Level */}
      <span
        role="cell"
        className="w-[52px] shrink-0 text-right font-mono text-sm font-bold"
        style={{ color: theme.text }}
      >
        {level.spxApprox}
      </span>

      {/* Premium bar */}
      <div role="cell" className="min-w-0 flex-1">
        <div
          className="h-[14px] rounded-sm transition-[width] duration-300"
          style={{
            width: `${barWidth}%`,
            backgroundColor: colors.bar,
            opacity: 0.7,
          }}
          aria-label={`${formatPremium(level.totalPremium)} premium`}
        />
      </div>

      {/* Premium value */}
      <span
        role="cell"
        className="w-[56px] shrink-0 text-right font-mono text-xs font-semibold"
        style={{ color: theme.textSecondary }}
      >
        {formatPremium(level.totalPremium)}
      </span>

      {/* Direction badge */}
      <span
        role="cell"
        className="w-[44px] shrink-0 text-center font-sans text-[10px] font-bold"
        style={{ color: colors.text }}
      >
        {colors.label}
      </span>

      {/* Block count */}
      <span
        role="cell"
        className="text-muted w-[52px] shrink-0 text-right font-sans text-[10px]"
      >
        {level.tradeCount} block{level.tradeCount !== 1 ? 's' : ''}
      </span>

      {/* Latest trade time */}
      <span
        role="cell"
        className="text-muted w-[52px] shrink-0 text-right font-mono text-[10px]"
      >
        {formatTime(level.latestTime)}
      </span>
    </div>
  );
}
