/**
 * GexPerStrike — 0DTE gamma exposure per strike with center-diverging bars,
 * charm/vanna overlays, hover tooltips, spot price line, and summary cards.
 *
 * Orchestrator only: wires props through `useGexViewState` and delegates
 * rendering to sibling subcomponents. All derived state and memoization
 * lives in the hook.
 *
 * See sibling files for the moving parts:
 *   - useGexViewState.ts  — state + derived memos (filtered, maxes, summary)
 *   - formatters.ts / mode.ts / colors.ts — pure helpers
 *   - Header.tsx          — date picker + scrubber + visible-count stepper
 *   - OverlayControls.tsx — charm/vanna/dex toggles + OI/VOL/DIR mode + legend
 *   - StrikesTable.tsx    — price-ladder bar chart
 *   - SummaryCards.tsx    — bottom aggregate tiles
 *   - Tooltip.tsx         — row hover readout
 */

import { memo } from 'react';
import { SectionBox } from '../ui';
import type { GexStrikeLevel } from '../../hooks/useGexPerStrike';
import { Header } from './Header';
import { OverlayControls } from './OverlayControls';
import { StrikesTable } from './StrikesTable';
import { SummaryCards } from './SummaryCards';
import { GexTooltip } from './Tooltip';
import { GEX_VIEW_LIMITS, useGexViewState } from './useGexViewState';

interface Props {
  strikes: GexStrikeLevel[];
  loading: boolean;
  error: string | null;
  timestamp: string | null;
  onRefresh: () => void;
  /** Panel-local viewed date (YYYY-MM-DD in ET) — decoupled from the calculator. */
  selectedDate: string;
  onDateChange: (date: string) => void;
  isLive: boolean;
  isToday: boolean;
  isScrubbed: boolean;
  canScrubPrev: boolean;
  canScrubNext: boolean;
  timestamps: string[];
  onScrubPrev: () => void;
  onScrubNext: () => void;
  onScrubTo: (ts: string) => void;
  onScrubLive: () => void;
}

export default memo(function GexPerStrike({
  strikes,
  loading,
  error,
  timestamp,
  onRefresh,
  selectedDate,
  onDateChange,
  isLive,
  isToday,
  isScrubbed,
  canScrubPrev,
  canScrubNext,
  timestamps,
  onScrubPrev,
  onScrubNext,
  onScrubTo,
  onScrubLive,
}: Props) {
  const s = useGexViewState(strikes);

  const totalStrikes = strikes.length;
  const badge =
    totalStrikes > 0 ? `${s.filtered.length} of ${totalStrikes}` : null;

  const header = (
    <Header
      timestamp={timestamp}
      timestamps={timestamps}
      selectedDate={selectedDate}
      onDateChange={onDateChange}
      isLive={isLive}
      isToday={isToday}
      isScrubbed={isScrubbed}
      canScrubPrev={canScrubPrev}
      canScrubNext={canScrubNext}
      loading={loading}
      onScrubPrev={onScrubPrev}
      onScrubNext={onScrubNext}
      onScrubTo={onScrubTo}
      onScrubLive={onScrubLive}
      onRefresh={onRefresh}
      visibleCount={s.visibleCount}
      totalStrikes={totalStrikes}
      minVisible={GEX_VIEW_LIMITS.MIN_VISIBLE}
      maxVisible={GEX_VIEW_LIMITS.MAX_VISIBLE}
      onLess={s.handleLess}
      onMore={s.handleMore}
    />
  );

  if (loading) {
    return (
      <SectionBox label="0DTE GEX Per Strike" collapsible headerRight={header}>
        <div className="text-muted animate-pulse text-center font-sans text-xs">
          Loading GEX data...
        </div>
      </SectionBox>
    );
  }

  if (error) {
    return (
      <SectionBox label="0DTE GEX Per Strike" collapsible headerRight={header}>
        <div className="text-muted text-center font-sans text-xs">{error}</div>
      </SectionBox>
    );
  }

  if (s.filtered.length === 0) {
    return (
      <SectionBox
        label="0DTE GEX Per Strike"
        badge={badge}
        collapsible
        headerRight={header}
      >
        <div className="border-edge-strong bg-surface rounded-[14px] border-2 border-dashed px-8 py-8 text-center">
          <div className="text-muted mb-1 text-[20px]">{'\u2014'}</div>
          <p className="text-secondary m-0 font-sans text-[13px]">
            No 0DTE GEX data available for this session.
          </p>
          <p className="text-muted m-0 mt-1 font-sans text-[11px]">
            Data appears after the first cron fetch of the day.
          </p>
        </div>
      </SectionBox>
    );
  }

  return (
    <SectionBox
      label="0DTE GEX Per Strike"
      badge={badge}
      collapsible
      headerRight={header}
    >
      <OverlayControls
        viewMode={s.viewMode}
        onViewModeChange={s.setViewMode}
        showCharm={s.showCharm}
        showVanna={s.showVanna}
        showDex={s.showDex}
        onToggleCharm={s.toggleCharm}
        onToggleVanna={s.toggleVanna}
        onToggleDex={s.toggleDex}
      />

      <StrikesTable
        filtered={s.filtered}
        price={s.price}
        viewMode={s.viewMode}
        showCharm={s.showCharm}
        showVanna={s.showVanna}
        showDex={s.showDex}
        maxGex={s.maxGex}
        maxCharm={s.maxCharm}
        maxVanna={s.maxVanna}
        maxDelta={s.maxDelta}
        hovered={s.hovered}
        onHoverEnter={s.handleHoverEnter}
        onHoverMove={s.handleHoverMove}
        onHoverLeave={s.handleHoverLeave}
        onFocusRow={s.handleHoverEnter}
        onBlurRow={s.handleHoverLeave}
      />

      <SummaryCards summary={s.summary} />

      {s.hovered !== null && s.filtered[s.hovered] && (
        <GexTooltip
          data={s.filtered[s.hovered]!}
          viewMode={s.viewMode}
          x={s.mousePos.x}
          y={s.mousePos.y}
        />
      )}
    </SectionBox>
  );
});
