/**
 * MarketFlow — unified container for all options flow sections with shared
 * date/time scrub controls for backtesting.
 *
 * Owns `selectedDate` + `scrubTimestamp` state and passes them to the
 * useOptionsFlow and useWhalePositioning hooks so all four sub-sections
 * (Flow Aggression, Retail × Whale Confluence, Options Flow, Whale
 * Positioning) reflect the same historical moment.
 *
 * The scrub controls (time prev/next, date picker, LIVE/SCRUBBED badge,
 * refresh) live in the container's SectionBox headerRight slot.
 */

import { memo, useCallback, useMemo, useState } from 'react';
import { SectionBox } from './ui';
import { ScrubControls } from './ScrubControls';
import { useOptionsFlow } from '../hooks/useOptionsFlow';
import { useWhalePositioning } from '../hooks/useWhalePositioning';
import { FlowDirectionalRollup } from './OptionsFlow/FlowDirectionalRollup';
import { FlowConfluencePanel } from './OptionsFlow/FlowConfluencePanel';
import { OptionsFlowTable } from './OptionsFlow/OptionsFlowTable';
import { WhalePositioningTable } from './OptionsFlow/WhalePositioningTable';
import { findConfluences } from '../utils/flow-confluence';
import { classifyAggression } from '../utils/flow-aggression';
import ErrorBoundary from './ErrorBoundary';
import type { RankedStrike } from '../types/flow';
import type { RegimeResult } from '../types/market-internals';

// ============================================================
// TYPES
// ============================================================

export interface MarketFlowProps {
  marketOpen: boolean;
  regime?: RegimeResult;
  gexByStrike: Map<number, number>;
}

// ============================================================
// HELPERS
// ============================================================

/** Compute today's ET date as YYYY-MM-DD. */
function getTodayET(): string {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
}

/** Format an ISO timestamp to 24h "HH:MM CT" for the meta row. */
function formatFlowTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return (
    new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'America/Chicago',
    }).format(d) + ' CT'
  );
}

/**
 * Compact lean label for the Flow Aggression badge. Returns null when
 * there's no useful signal so the badge slot collapses.
 */
const LEAN_RATIO_THRESHOLD = 1.5;
function flowAggressionBadge(strikes?: RankedStrike[]): string | null {
  if (!strikes?.length) return null;
  let callPremium = 0;
  let putPremium = 0;
  let count = 0;
  for (const s of strikes) {
    if (classifyAggression(s.ask_side_ratio) !== 'aggressive') continue;
    count += 1;
    if (s.type === 'call') callPremium += s.total_premium;
    else putPremium += s.total_premium;
  }
  if (count === 0) return null;
  if (callPremium > putPremium * LEAN_RATIO_THRESHOLD) return 'CALL-HEAVY';
  if (putPremium > callPremium * LEAN_RATIO_THRESHOLD) return 'PUT-HEAVY';
  return 'BALANCED';
}

/** Spot / count / updated metadata strip shown on sub-section headers. */
function MetaRow({
  spot,
  count,
  updated,
}: {
  spot: number | null | undefined;
  count: number | undefined;
  updated: string | null | undefined;
}) {
  const time = formatFlowTime(updated);
  if (spot == null && count == null && !time) return null;
  return (
    <div className="text-muted flex items-center gap-3 font-mono text-[11px]">
      {spot != null && (
        <span>
          Spot{' '}
          <strong className="font-semibold text-sky-300">
            {spot.toFixed(2)}
          </strong>
        </span>
      )}
      {count != null && (
        <span>
          {count} {count === 1 ? 'alert' : 'alerts'}
        </span>
      )}
      {time && <span>Updated {time}</span>}
    </div>
  );
}

// ============================================================
// LIGHTWEIGHT SUB-SECTION
// ============================================================

/**
 * A lighter-weight collapsible sub-section for use inside MarketFlow.
 * No border/shadow/padding like SectionBox — just a header + disclosure.
 */
function SubSection({
  label,
  badge,
  headerRight,
  defaultCollapsed,
  children,
}: {
  label: string;
  badge?: string | null;
  headerRight?: React.ReactNode;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? false);
  const toggle = useCallback(() => setCollapsed((v) => !v), []);
  const isOpen = !collapsed;

  return (
    <div className="border-edge/40 border-b last:border-b-0">
      <div className="flex items-center justify-between py-2">
        <button
          type="button"
          className="flex flex-1 cursor-pointer items-center gap-2 text-left select-none"
          onClick={toggle}
          aria-label={`Toggle ${label}`}
          aria-expanded={isOpen}
        >
          <span
            className="text-muted text-[11px] transition-transform duration-200"
            style={{
              transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
            }}
            aria-hidden="true"
          >
            &#x25BE;
          </span>
          <h3 className="text-tertiary font-sans text-[12px] font-bold tracking-[0.1em] uppercase">
            {label}
          </h3>
          {badge && (
            <span className="text-accent bg-accent-bg rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold">
              {badge}
            </span>
          )}
        </button>
        {headerRight}
      </div>
      {isOpen && <div className="pb-3">{children}</div>}
    </div>
  );
}

// ============================================================
// MAIN COMPONENT
// ============================================================

const MarketFlow = memo(function MarketFlow({
  marketOpen,
  regime,
  gexByStrike,
}: MarketFlowProps) {
  // ---------- date / scrub state ----------
  const [selectedDate, setSelectedDate] = useState(getTodayET);
  const [scrubTimestamp, setScrubTimestamp] = useState<string | null>(null);

  const todayET = getTodayET();
  const isToday = selectedDate === todayET;
  const isScrubbed = scrubTimestamp != null;

  // ---------- hooks ----------
  const optionsFlow = useOptionsFlow({
    marketOpen,
    selectedDate,
    asOf: scrubTimestamp,
  });

  const whale = useWhalePositioning({
    marketOpen,
    selectedDate,
    asOf: scrubTimestamp,
  });

  // ---------- merged timestamps ----------
  const mergedTimestamps = useMemo(() => {
    const flowTs = optionsFlow.data?.timestamps ?? [];
    const whaleTs = whale.data?.timestamps ?? [];
    const set = new Set([...flowTs, ...whaleTs]);
    return [...set].sort();
  }, [optionsFlow.data?.timestamps, whale.data?.timestamps]);

  // The "current" timestamp to display in the scrub controls.
  // When scrubbing, show the scrubTimestamp. When live, show the latest.
  const displayTimestamp = useMemo(() => {
    if (scrubTimestamp) return scrubTimestamp;
    // In live mode, show the newest timestamp from either source.
    const flowLast = optionsFlow.data?.lastUpdated;
    const whaleLast = whale.data?.lastUpdated;
    if (flowLast && whaleLast) {
      return flowLast > whaleLast ? flowLast : whaleLast;
    }
    return flowLast ?? whaleLast ?? null;
  }, [scrubTimestamp, optionsFlow.data?.lastUpdated, whale.data?.lastUpdated]);

  // ---------- scrub navigation ----------
  const scrubIndex = useMemo(() => {
    if (!scrubTimestamp || mergedTimestamps.length === 0) return -1;
    // Find the closest timestamp <= scrubTimestamp.
    let best = -1;
    for (let i = 0; i < mergedTimestamps.length; i++) {
      if (mergedTimestamps[i]! <= scrubTimestamp) best = i;
      else break;
    }
    return best;
  }, [scrubTimestamp, mergedTimestamps]);

  const canScrubPrev = mergedTimestamps.length > 0 && scrubIndex > 0;
  const canScrubNext =
    mergedTimestamps.length > 0 &&
    (scrubIndex === -1 || scrubIndex < mergedTimestamps.length - 1);

  const scrubPrev = useCallback(() => {
    if (!canScrubPrev) return;
    setScrubTimestamp(mergedTimestamps[scrubIndex - 1]!);
  }, [canScrubPrev, mergedTimestamps, scrubIndex]);

  const scrubNext = useCallback(() => {
    if (!canScrubNext) return;
    if (scrubIndex === -1) {
      // Not scrubbing yet — go to the last timestamp.
      setScrubTimestamp(mergedTimestamps.at(-1) ?? null);
      return;
    }
    const nextIdx = scrubIndex + 1;
    // If stepping to the latest timestamp, resume live.
    if (nextIdx >= mergedTimestamps.length - 1 && isToday) {
      setScrubTimestamp(null);
    } else {
      setScrubTimestamp(mergedTimestamps[nextIdx]!);
    }
  }, [canScrubNext, mergedTimestamps, scrubIndex, isToday]);

  const scrubTo = useCallback(
    (ts: string) => {
      // If selecting the latest timestamp on today, resume live.
      if (isToday && ts === mergedTimestamps.at(-1)) {
        setScrubTimestamp(null);
      } else {
        setScrubTimestamp(ts);
      }
    },
    [isToday, mergedTimestamps],
  );

  const scrubLive = useCallback(() => {
    setScrubTimestamp(null);
    setSelectedDate(getTodayET());
  }, []);

  const handleDateChange = useCallback((date: string) => {
    setSelectedDate(date);
    setScrubTimestamp(null);
  }, []);

  const handleRefresh = useCallback(() => {
    optionsFlow.refresh();
    whale.refresh();
  }, [optionsFlow, whale]);

  const isLoading = optionsFlow.isLoading || whale.isLoading;
  const isLive = !isScrubbed && isToday && marketOpen;

  // ---------- derived data ----------
  const aggressionBadge = flowAggressionBadge(optionsFlow.data?.strikes);

  const confluenceMatchCount = useMemo(() => {
    const retail = optionsFlow.data?.strikes ?? [];
    const whaleAlerts = whale.data?.strikes ?? [];
    if (retail.length === 0 || whaleAlerts.length === 0) return 0;
    return findConfluences(retail, whaleAlerts).length;
  }, [optionsFlow.data?.strikes, whale.data?.strikes]);

  // ---------- render ----------
  const headerRight = (
    <ScrubControls
      timestamp={displayTimestamp}
      timestamps={mergedTimestamps}
      selectedDate={selectedDate}
      onDateChange={handleDateChange}
      isLive={isLive}
      isScrubbed={isScrubbed}
      canScrubPrev={canScrubPrev}
      canScrubNext={canScrubNext}
      onScrubPrev={scrubPrev}
      onScrubNext={scrubNext}
      onScrubTo={scrubTo}
      onScrubLive={scrubLive}
      onRefresh={handleRefresh}
      loading={isLoading}
      sectionLabel="Market Flow"
    />
  );

  return (
    <SectionBox label="Market Flow" headerRight={headerRight} collapsible>
      <ErrorBoundary label="Flow Aggression">
        <SubSection label="Flow Aggression" badge={aggressionBadge}>
          <FlowDirectionalRollup
            strikes={optionsFlow.data?.strikes ?? []}
            spot={optionsFlow.data?.spot ?? null}
            alertCount={optionsFlow.data?.alertCount ?? 0}
          />
        </SubSection>
      </ErrorBoundary>

      <ErrorBoundary label="Flow Confluence">
        <SubSection
          label="Retail \u00d7 Whale Confluence"
          badge={
            confluenceMatchCount > 0
              ? `${confluenceMatchCount} ${confluenceMatchCount === 1 ? 'match' : 'matches'}`
              : null
          }
        >
          <FlowConfluencePanel
            intradayStrikes={optionsFlow.data?.strikes ?? []}
            whaleAlerts={whale.data?.strikes ?? []}
            regime={regime}
          />
        </SubSection>
      </ErrorBoundary>

      <ErrorBoundary label="Options Flow">
        <SubSection
          label="Options Flow"
          badge="0-1 DTE \u00b7 15m"
          headerRight={
            <MetaRow
              spot={optionsFlow.data?.spot}
              count={optionsFlow.data?.alertCount}
              updated={optionsFlow.data?.lastUpdated}
            />
          }
        >
          <OptionsFlowTable
            strikes={optionsFlow.data?.strikes ?? []}
            windowMinutes={optionsFlow.data?.windowMinutes}
            isLoading={optionsFlow.isLoading}
            error={optionsFlow.error}
            gexByStrike={gexByStrike}
          />
        </SubSection>
      </ErrorBoundary>

      <ErrorBoundary label="Whale Positioning">
        <SubSection
          label="Whale Positioning"
          badge="0-7 DTE \u00b7 \u2265$1M"
          headerRight={
            <MetaRow
              spot={whale.data?.spot}
              count={whale.data?.alertCount}
              updated={whale.data?.lastUpdated}
            />
          }
        >
          <WhalePositioningTable
            alerts={whale.data?.strikes ?? []}
            totalPremium={whale.data?.totalPremium ?? 0}
            alertCount={whale.data?.alertCount ?? 0}
            isLoading={whale.isLoading}
            error={whale.error}
          />
        </SubSection>
      </ErrorBoundary>
    </SectionBox>
  );
});

export default MarketFlow;
