/**
 * GexTarget — 5-panel GEX target widget.
 *
 * Composes TargetTile (Panel 1), UrgencyPanel (Panel 2), SparklinePanel
 * (Panel 3), a Phase-8 price-chart placeholder (Panel 4), and StrikeBox
 * (Panel 5) into a single SectionBox with a mode toggle + scrubber header.
 *
 * The component owns the `mode` toggle state; `useGexTarget` always returns
 * all three modes so switching modes is a pure UI change with no refetch.
 */

import { memo, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { SectionBox, Chip, StatusBadge } from '../ui';
import { useGexTarget } from '../../hooks/useGexTarget';
import { TargetTile } from './TargetTile';
import { UrgencyPanel } from './UrgencyPanel';
import { SparklinePanel } from './SparklinePanel';
import { StrikeBox } from './StrikeBox';
import type { TargetScore, StrikeScore } from '../../utils/gex-target';

// ── Types ─────────────────────────────────────────────────

export interface GexTargetProps {
  marketOpen: boolean;
}

type Mode = 'oi' | 'vol' | 'dir';

// ── Helpers ───────────────────────────────────────────────

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

// ── Main component ─────────────────────────────────────────

export const GexTarget = memo(function GexTarget({
  marketOpen,
}: GexTargetProps) {
  const [mode, setMode] = useState<Mode>('oi');

  const {
    oi,
    vol,
    dir,
    timestamp,
    selectedDate,
    setSelectedDate,
    availableDates,
    isLive,
    isScrubbed,
    canScrubPrev,
    canScrubNext,
    scrubPrev,
    scrubNext,
    scrubLive,
    loading,
    error,
    refresh,
  } = useGexTarget(marketOpen);

  // ── Mode selection ───────────────────────────────────────

  const setOi = useCallback(() => setMode('oi'), []);
  const setVol = useCallback(() => setMode('vol'), []);
  const setDir = useCallback(() => setMode('dir'), []);

  const activeScore: TargetScore | null =
    mode === 'oi' ? oi : mode === 'vol' ? vol : dir;
  const activeLeaderboard: StrikeScore[] = activeScore?.leaderboard ?? [];

  // ── Live badge config ────────────────────────────────────

  const badgeLabel = isLive ? '● LIVE' : isScrubbed ? 'SCRUBBED' : 'BACKTEST';
  const badgeColor = isLive ? '#00e676' : isScrubbed ? '#ffb300' : '#ff9800';

  // ── Data availability check ──────────────────────────────

  const dateInAvailable =
    availableDates.length === 0 || availableDates.includes(selectedDate);

  // ── Datalist id ──────────────────────────────────────────

  const datalistId = 'gex-target-available-dates';
  const minDate = availableDates.length > 0 ? availableDates[0] : undefined;
  const maxDate = availableDates.length > 0 ? availableDates.at(-1) : undefined;

  // ── Header ───────────────────────────────────────────────

  const headerRight = (
    <div className="flex flex-wrap items-center gap-2">
      {/* Mode toggle */}
      <div className="flex items-center gap-1">
        <Chip active={mode === 'oi'} onClick={setOi} label="OI" />
        <Chip active={mode === 'vol'} onClick={setVol} label="VOL" />
        <Chip active={mode === 'dir'} onClick={setDir} label="DIR" />
      </div>

      {/* Scrubber */}
      <div className="border-edge flex items-center gap-0.5 rounded border">
        <button
          type="button"
          onClick={scrubPrev}
          disabled={!canScrubPrev}
          aria-label="Previous snapshot"
          className="text-secondary hover:text-primary disabled:text-muted cursor-pointer px-1.5 py-0.5 font-mono text-xs font-bold disabled:cursor-default"
        >
          &#x25C0;
        </button>
        {timestamp && (
          <span
            className="min-w-[44px] text-center font-mono text-[10px]"
            style={{
              color: isLive ? '#00e676' : isScrubbed ? '#ffb300' : '#ff9800',
            }}
          >
            {formatTime(timestamp)}
          </span>
        )}
        <button
          type="button"
          onClick={scrubNext}
          disabled={!canScrubNext}
          aria-label="Next snapshot"
          className="text-secondary hover:text-primary disabled:text-muted cursor-pointer px-1.5 py-0.5 font-mono text-xs font-bold disabled:cursor-default"
        >
          &#x25B6;
        </button>
      </div>

      {/* LIVE button — only shown when scrubbed or not live */}
      {(isScrubbed || !isLive) && (
        <button
          type="button"
          onClick={scrubLive}
          aria-label="Resume live"
          className="cursor-pointer rounded px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider transition-colors"
          style={{
            color: '#00e676',
            background: 'rgba(0,230,118,0.08)',
            border: '1px solid rgba(0,230,118,0.25)',
          }}
        >
          LIVE
        </button>
      )}

      {/* Date picker */}
      <input
        type="date"
        value={selectedDate}
        onChange={(e) => setSelectedDate(e.target.value)}
        aria-label="Select date"
        list={datalistId}
        min={minDate}
        max={maxDate}
        className="text-secondary border-edge rounded border bg-transparent px-1.5 py-0.5 font-mono text-[10px]"
      />
      <datalist id={datalistId}>
        {availableDates.map((d) => (
          <option key={d} value={d} />
        ))}
      </datalist>

      {/* Status badge */}
      <StatusBadge label={badgeLabel} color={badgeColor} />

      {/* Refresh */}
      <button
        type="button"
        onClick={refresh}
        aria-label="Refresh GEX target data"
        className="text-muted hover:text-secondary cursor-pointer font-mono text-[11px]"
      >
        ↻
      </button>
    </div>
  );

  // ── Content ───────────────────────────────────────────────

  let content: ReactNode;

  if (loading) {
    content = (
      <div className="text-muted flex items-center justify-center py-8 font-mono text-[13px]">
        Loading GEX target…
      </div>
    );
  } else if (error) {
    content = (
      <div className="flex flex-col items-center gap-3 py-8">
        <p
          role="alert"
          className="text-danger font-mono text-[13px] font-medium"
        >
          {error}
        </p>
        <button
          type="button"
          onClick={refresh}
          className="text-secondary border-edge rounded border px-3 py-1 font-mono text-[12px]"
        >
          Retry
        </button>
      </div>
    );
  } else {
    content = (
      <>
        {/* Data-availability banner */}
        {availableDates.length > 0 && !dateInAvailable && (
          <p className="mb-2 text-[11px] text-[var(--color-muted)] italic">
            No data for this date. GEX target history is captured live from the
            cron — select a date from the picker to see available sessions.
          </p>
        )}

        {/* 5-panel layout */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_2fr]">
          {/* Left column: panels 1-3 */}
          <div className="flex flex-col gap-3">
            <TargetTile score={activeScore} />
            <UrgencyPanel leaderboard={activeLeaderboard} />
            <SparklinePanel leaderboard={activeLeaderboard} />
          </div>

          {/* Panel 4: price chart placeholder */}
          <div className="flex min-h-[300px] items-center justify-center rounded-lg border border-dashed border-[var(--color-edge)] text-sm text-[var(--color-muted)]">
            Price chart — Phase 8
          </div>
        </div>

        {/* Panel 5: full-width strike box */}
        <div className="mt-3">
          <StrikeBox leaderboard={activeLeaderboard} />
        </div>
      </>
    );
  }

  return (
    <SectionBox label="GEX TARGET" headerRight={headerRight}>
      {content}
    </SectionBox>
  );
});

export default GexTarget;
