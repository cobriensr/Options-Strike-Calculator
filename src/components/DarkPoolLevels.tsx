/**
 * DarkPoolLevels — dashboard widget showing institutional dark pool
 * strike levels accumulated throughout the day.
 *
 * Displays SPX price levels where large SPY dark pool blocks have
 * printed, sorted by total premium (ranked), strike (ladder), or
 * distance from spot. The running-total design shows premium
 * accumulating at each level over the session — larger bars = more
 * institutional interest at that price.
 *
 * Auto-refreshes every 60 seconds during market hours.
 */

import { memo, useMemo, useState, useCallback } from 'react';
import { theme } from '../themes';
import { formatTimeCT } from '../utils/component-formatters';
import { getETToday } from '../utils/timezone';
import { DateInput } from './ui/DateInput';
import { SectionBox } from './ui';
import { StatusBadge } from './ui';
import { ScrubControlsCompact } from './ui/ScrubControlsCompact';
import type { DarkPoolLevel, DarkPoolSymbol } from '../hooks/useDarkPoolLevels';
import { DARK_POOL_SYMBOLS } from '../hooks/useDarkPoolLevels';

const DEFAULT_VISIBLE = 15;
const MIN_VISIBLE = 5;
const MAX_VISIBLE = 50;
const STEP = 5;

type SortMode = 'premium' | 'latest' | 'strike' | 'distance';

interface Props {
  levels: DarkPoolLevel[];
  loading: boolean;
  error: string | null;
  /** Epoch milliseconds of the most recent fetch, or null for "no time
   *  yet". Rendered via the shared `formatTimeCT` helper which accepts
   *  the numeric overload directly. */
  fetchedAt: number | null;
  /** Reference price for ATM detection + distance label. Caller is
   *  responsible for passing a price that matches `selectedSymbol`'s
   *  scale (SPX→spx, NDX→ndx, SPY→spy, QQQ→qqq). When the price's
   *  symbol does not match the selector, distance display will be
   *  meaningless — the component does not enforce this; pass null
   *  when the right price is unavailable. */
  spxPrice?: number | null;
  onRefresh: () => void;
  // Symbol selector (optional — omit for tests or when hook is not wired;
  // defaults to 'SPX' so legacy single-symbol callers still render).
  selectedSymbol?: DarkPoolSymbol;
  onSymbolChange?: (s: DarkPoolSymbol) => void;
  // Date & time scrubbing (optional — omit for tests or when hook is not wired)
  selectedDate?: string;
  onDateChange?: (d: string) => void;
  scrubTime?: string | null;
  isLive?: boolean;
  isScrubbed?: boolean;
  canScrubPrev?: boolean;
  canScrubNext?: boolean;
  onScrubPrev?: () => void;
  onScrubNext?: () => void;
  onScrubTo?: (time: string) => void;
  /** Available HH:MM time slots for the trading session. */
  timeGrid?: readonly string[];
  onScrubLive?: () => void;
}

// Local DarkPool variant — kept distinct from the canonical
// `formatPremium` in src/utils/format-magnitude.ts because dark pool
// notional volumes regularly exceed $1B (canonical caps at M) and
// the integer-precision M/K rounding here matches the price-ladder
// column width budget.
function formatPremium(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(0)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(0)}K`;
  return `$${abs.toFixed(0)}`;
}

function formatDist(level: number, price: number): string {
  const diff = Math.round(level - price);
  if (diff === 0) return 'ATM';
  return `${diff > 0 ? '+' : ''}${diff}pts`;
}

const SORT_LABELS: Record<SortMode, string> = {
  premium: 'By Premium',
  latest: 'By Latest',
  strike: 'By Strike',
  distance: 'By Distance',
};

export default memo(function DarkPoolLevels({
  levels,
  loading,
  error,
  fetchedAt,
  spxPrice,
  onRefresh,
  selectedSymbol = 'SPX',
  onSymbolChange,
  selectedDate = getETToday(),
  onDateChange,
  scrubTime = null,
  isLive = true,
  isScrubbed = false,
  canScrubPrev = false,
  canScrubNext = false,
  onScrubPrev,
  onScrubNext,
  onScrubTo,
  timeGrid = [],
  onScrubLive,
}: Props) {
  const [visibleCount, setVisibleCount] = useState(DEFAULT_VISIBLE);
  const [sortBy, setSortBy] = useState<SortMode>('premium');

  // Cycle: premium → latest → strike → distance → premium
  // Distance step is skipped when spxPrice is unknown.
  const cycleSort = useCallback(() => {
    const canDistance = spxPrice != null;
    setSortBy((s) => {
      if (s === 'premium') return 'latest';
      if (s === 'latest') return 'strike';
      if (s === 'strike') return canDistance ? 'distance' : 'premium';
      return 'premium';
    });
  }, [spxPrice]);

  const sorted = useMemo(() => {
    if (sortBy === 'latest') {
      // Most recently hit first — useful for scanning which levels are
      // still active during a live session
      return [...levels].sort((a, b) => {
        const tA = a.latestTime ?? '';
        const tB = b.latestTime ?? '';
        return tB.localeCompare(tA);
      });
    }
    if (sortBy === 'strike') {
      // Price-ladder order: highest strike at top, lowest at bottom
      return [...levels].sort((a, b) => b.level - a.level);
    }
    if (sortBy === 'distance' && spxPrice != null) {
      return [...levels].sort(
        (a, b) => Math.abs(a.level - spxPrice) - Math.abs(b.level - spxPrice),
      );
    }
    // Default: API returns by premium desc
    return levels;
  }, [levels, sortBy, spxPrice]);

  const filtered = useMemo(
    () => sorted.slice(0, visibleCount),
    [sorted, visibleCount],
  );

  // Max premium for bar scaling — always use the visible set. Use
  // reduce instead of Math.max with spread to avoid allocating a new
  // args array on every render when filtered grows past ~50 items.
  const maxPremium = useMemo(
    () =>
      filtered.length > 0
        ? filtered.reduce((m, l) => Math.max(m, l.totalPremium), 0)
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

  const totalLevels = levels.length;
  const badge = totalLevels > 0 ? `${filtered.length} of ${totalLevels}` : null;

  const badgeLabel = isLive ? '● LIVE' : isScrubbed ? 'SCRUBBED' : 'BACKTEST';
  const badgeColor = isLive
    ? theme.statusLive
    : isScrubbed
      ? theme.statusScrubbed
      : theme.statusStale;

  const scrubColor = isLive
    ? theme.statusLive
    : isScrubbed
      ? theme.statusScrubbed
      : theme.statusStale;

  const headerRight = (
    <div className="flex flex-wrap items-center gap-2">
      {/* Symbol selector — 4 buttons (SPX/NDX/SPY/QQQ).
          Hidden when no onSymbolChange is provided so test fixtures
          + legacy single-symbol callers don't render extra UI. */}
      {onSymbolChange && (
        <div
          className="border-edge flex items-center gap-0.5 rounded border"
          role="group"
          aria-label="Dark pool symbol"
        >
          {DARK_POOL_SYMBOLS.map((s) => {
            const active = s === selectedSymbol;
            return (
              <button
                key={s}
                onClick={() => onSymbolChange(s)}
                aria-pressed={active}
                aria-label={`Show dark pool for ${s}`}
                className={
                  'cursor-pointer px-1.5 py-0.5 font-mono text-[10px] font-semibold transition-colors ' +
                  (active ? 'text-primary' : 'text-muted hover:text-secondary')
                }
                style={
                  active
                    ? { backgroundColor: 'rgba(255,255,255,0.06)' }
                    : undefined
                }
              >
                {s}
              </button>
            );
          })}
        </div>
      )}

      {/* Time scrubber + LIVE button */}
      <ScrubControlsCompact
        timestamps={timeGrid}
        currentTimestamp={scrubTime}
        formatLabel={(t) => t}
        displayColor={scrubColor}
        canScrubPrev={canScrubPrev}
        canScrubNext={canScrubNext}
        onScrubPrev={onScrubPrev ?? (() => {})}
        onScrubNext={onScrubNext ?? (() => {})}
        onScrubTo={onScrubTo}
        showLiveButton={isScrubbed || !isLive}
        onScrubLive={onScrubLive}
        fallbackText={fetchedAt != null ? formatTimeCT(fetchedAt) : ''}
        prevAriaLabel="Earlier snapshot"
        nextAriaLabel="Later snapshot"
      />

      {/* Date picker */}
      <DateInput
        value={selectedDate ?? ''}
        onChange={onDateChange ?? (() => {})}
        label="Select date"
        labelVisible={false}
        className="text-secondary border-edge rounded border bg-transparent px-1.5 py-0.5 font-mono text-[10px]"
      />

      {/* Status badge */}
      <StatusBadge label={badgeLabel} color={badgeColor} />

      {/* Refresh */}
      <button
        onClick={onRefresh}
        disabled={loading}
        aria-label="Refresh dark pool data"
        className="text-secondary hover:text-primary disabled:text-muted cursor-pointer font-mono text-[15px] disabled:cursor-default"
      >
        <span
          className={loading ? 'inline-block animate-spin' : undefined}
          aria-hidden="true"
        >
          ↻
        </span>
      </button>

      {/* Sort cycle */}
      <button
        onClick={cycleSort}
        aria-label={`Sort mode: ${SORT_LABELS[sortBy]} — click to cycle`}
        className="text-accent hover:text-primary border-edge cursor-pointer rounded border px-1.5 py-0.5 font-sans text-[10px] font-semibold transition-colors"
      >
        {SORT_LABELS[sortBy]}
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
      <SectionBox
        label="Dark Pool Levels"
        collapsible
        headerRight={headerRight}
      >
        {/* Shimmer bars roughly matching the strike-row shape so layout
            stays stable when data arrives. Width cycle gives the column
            visual variety without being random. */}
        <div aria-busy="true" className="flex flex-col gap-2">
          {Array.from({ length: 8 }, (_, i) => (
            <div
              key={i}
              className="bg-surface-alt h-3 animate-pulse rounded"
              style={{
                width: ['100%', '92%', '78%', '88%'][i % 4],
                animationDelay: `${i * 60}ms`,
              }}
            />
          ))}
        </div>
      </SectionBox>
    );
  }

  if (error) {
    return (
      <SectionBox
        label="Dark Pool Levels"
        collapsible
        headerRight={headerRight}
      >
        <div className="text-muted text-center font-sans text-xs">{error}</div>
      </SectionBox>
    );
  }

  if (filtered.length === 0) {
    return (
      <SectionBox
        label="Dark Pool Levels"
        badge={badge}
        collapsible
        headerRight={headerRight}
      >
        <div className="border-edge-strong bg-surface rounded-[14px] border-2 border-dashed px-8 py-8 text-center">
          <div className="text-muted mb-1 text-[20px]">{'\u2014'}</div>
          <p className="text-secondary m-0 font-sans text-[13px]">
            No dark pool levels available for this session.
          </p>
          {selectedSymbol === 'SPX' ? (
            <p className="text-muted m-0 mt-1 font-sans text-[11px]">
              Levels appear when large institutional blocks are detected.
            </p>
          ) : (
            <p className="text-muted m-0 mt-1 font-sans text-[11px]">
              {selectedSymbol} dark pool data is rolling out — SPX is the only
              fully-wired feed today.
            </p>
          )}
        </div>
      </SectionBox>
    );
  }

  return (
    <SectionBox
      label="Dark Pool Levels"
      badge={badge}
      collapsible
      headerRight={headerRight}
    >
      <table
        className="w-full border-collapse"
        aria-label={`Dark pool levels (${selectedSymbol})`}
      >
        <thead className="sr-only">
          <tr>
            <th>{selectedSymbol} Level</th>
            {spxPrice != null && <th>Distance</th>}
            <th>Premium</th>
            <th>Blocks</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((level) => (
            <LevelRow
              key={level.level}
              level={level}
              maxPremium={maxPremium}
              spxPrice={spxPrice ?? null}
            />
          ))}
        </tbody>
      </table>
    </SectionBox>
  );
});

function LevelRow({
  level,
  maxPremium,
  spxPrice,
}: Readonly<{
  level: DarkPoolLevel;
  maxPremium: number;
  spxPrice: number | null;
}>) {
  const barWidth = Math.max((level.totalPremium / maxPremium) * 100, 2);
  const isAtm = spxPrice != null && Math.abs(level.level - spxPrice) < 2.5;
  const distLabel = spxPrice != null ? formatDist(level.level, spxPrice) : null;

  // Color the distance label: above spot = green, below = red, at = accent
  const distColor = (() => {
    if (spxPrice == null) return theme.textMuted;
    if (isAtm) return theme.accent;
    return level.level > spxPrice ? theme.green : theme.red;
  })();

  return (
    <tr
      className="flex items-center gap-2 py-1.5"
      style={isAtm ? { backgroundColor: 'rgba(255,255,255,0.04)' } : undefined}
    >
      {/* Index level */}
      <td
        className="w-[52px] shrink-0 text-right font-mono text-sm font-bold"
        style={{ color: isAtm ? theme.accent : theme.text }}
      >
        {level.level}
      </td>

      {/* Distance from spot (only when spxPrice is known) */}
      {spxPrice != null && (
        <td
          className="w-[46px] shrink-0 text-right font-mono text-[10px]"
          style={{ color: distColor }}
        >
          {distLabel}
        </td>
      )}

      {/* Premium bar */}
      <td className="min-w-0 flex-1">
        <div
          className="h-[14px] rounded-sm transition-[width] duration-300"
          style={{
            width: `${barWidth}%`,
            backgroundColor: theme.accent,
            opacity: 0.6,
          }}
          aria-label={`${formatPremium(level.totalPremium)} premium`}
        />
      </td>

      {/* Premium value */}
      <td
        className="w-[56px] shrink-0 text-right font-mono text-xs font-semibold"
        style={{ color: theme.textSecondary }}
      >
        {formatPremium(level.totalPremium)}
      </td>

      {/* Block count */}
      <td className="text-muted w-[52px] shrink-0 text-right font-sans text-[10px]">
        {level.tradeCount} block{level.tradeCount !== 1 ? 's' : ''}
      </td>

      {/* Latest trade time */}
      <td className="text-muted w-[52px] shrink-0 text-right font-mono text-[10px]">
        {formatTimeCT(level.latestTime)}
      </td>
    </tr>
  );
}
