/**
 * DarkPoolLevels — dashboard widget showing institutional dark pool
 * strike levels ranked by aggregate premium.
 *
 * Displays SPX price levels where large ($5M+) SPY dark pool blocks
 * have accumulated, sorted by total premium. Larger premium = stronger
 * institutional support/resistance. Auto-refreshes every 60 seconds.
 *
 * User can adjust how many levels are visible with +/- controls.
 */

import { memo, useMemo, useState, useCallback } from 'react';
import { theme } from '../themes';
import { SectionBox } from './ui';
import type { DarkPoolLevel } from '../hooks/useDarkPoolLevels';

const DEFAULT_VISIBLE = 15;
const MIN_VISIBLE = 5;
const MAX_VISIBLE = 50;
const STEP = 5;

interface Props {
  levels: DarkPoolLevel[];
  loading: boolean;
  error: string | null;
  updatedAt: string | null;
}

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
      timeZone: 'America/Chicago',
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
  const [visibleCount, setVisibleCount] = useState(DEFAULT_VISIBLE);
  const [sortBy, setSortBy] = useState<'premium' | 'time'>('premium');

  const sorted = useMemo(() => {
    if (sortBy === 'time') {
      return [...levels].sort((a, b) => {
        const tA = a.latestTime ?? '';
        const tB = b.latestTime ?? '';
        return tB.localeCompare(tA);
      });
    }
    return levels; // API already returns by premium desc
  }, [levels, sortBy]);

  const filtered = useMemo(
    () => sorted.slice(0, visibleCount),
    [sorted, visibleCount],
  );

  const maxPremium = useMemo(
    () =>
      filtered.length > 0
        ? Math.max(...filtered.map((l) => l.totalPremium))
        : 1,
    [filtered],
  );

  const handleLess = useCallback(
    () => setVisibleCount((v) => Math.max(v - STEP, MIN_VISIBLE)),
    [],
  );
  const handleMore = useCallback(
    () => setVisibleCount((v) => Math.min(v + STEP, MAX_VISIBLE)),
    [],
  );
  const toggleSort = useCallback(
    () => setSortBy((s) => (s === 'premium' ? 'time' : 'premium')),
    [],
  );

  const totalLevels = levels.length;

  const badge = totalLevels > 0 ? `${filtered.length} of ${totalLevels}` : null;

  const headerRight = (
    <div className="flex items-center gap-2">
      {updatedAt && (
        <span className="text-muted font-sans text-[10px]">
          Updated {formatTime(updatedAt)}
        </span>
      )}
      <button
        onClick={toggleSort}
        aria-label={`Sort by ${sortBy === 'premium' ? 'latest time' : 'premium'}`}
        className="text-accent hover:text-primary border-edge cursor-pointer rounded border px-1.5 py-0.5 font-sans text-[10px] font-semibold transition-colors"
      >
        {sortBy === 'premium' ? 'By Premium' : 'By Latest'}
      </button>
      <div className="border-edge flex items-center gap-0.5 rounded border">
        <button
          onClick={handleLess}
          disabled={visibleCount <= MIN_VISIBLE}
          aria-label="Show fewer levels"
          className="text-secondary hover:text-primary disabled:text-muted cursor-pointer px-1.5 py-0.5 font-mono text-xs font-bold disabled:cursor-default"
        >
          &minus;
        </button>
        <span className="text-secondary min-w-[20px] text-center font-mono text-[10px]">
          {visibleCount}
        </span>
        <button
          onClick={handleMore}
          disabled={visibleCount >= MAX_VISIBLE || visibleCount >= totalLevels}
          aria-label="Show more levels"
          className="text-secondary hover:text-primary disabled:text-muted cursor-pointer px-1.5 py-0.5 font-mono text-xs font-bold disabled:cursor-default"
        >
          +
        </button>
      </div>
    </div>
  );

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
        <div className="border-edge-strong bg-surface rounded-[14px] border-2 border-dashed px-8 py-8 text-center">
          <div className="text-muted mb-1 text-[20px]">{'\u2014'}</div>
          <p className="text-secondary m-0 font-sans text-[13px]">
            No dark pool levels available for this session.
          </p>
          <p className="text-muted m-0 mt-1 font-sans text-[11px]">
            Levels appear when large institutional blocks are detected.
          </p>
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
          <span role="columnheader">Blocks</span>
          <span role="columnheader">Time</span>
        </div>
        {filtered.map((level) => (
          <LevelRow
            key={level.spxLevel}
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
  const barWidth = Math.max((level.totalPremium / maxPremium) * 100, 2);

  return (
    <div role="row" className="flex items-center gap-2 py-1.5">
      {/* SPX Level */}
      <span
        role="cell"
        className="w-[52px] shrink-0 text-right font-mono text-sm font-bold"
        style={{ color: theme.text }}
      >
        {level.spxLevel}
      </span>

      {/* Premium bar */}
      <div role="cell" className="min-w-0 flex-1">
        <div
          className="h-[14px] rounded-sm transition-[width] duration-300"
          style={{
            width: `${barWidth}%`,
            backgroundColor: theme.accent,
            opacity: 0.6,
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
