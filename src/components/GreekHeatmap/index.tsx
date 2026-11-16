/**
 * 0DTE Greek Heatmap section — sits between Lottery Finder and Silent
 * Boom in the app shell.
 *
 * Layout:
 *   ── header row ──
 *     [Ticker ▼]  [Date YYYY-MM-DD]   PriceChip   RegimeChip
 *   ── top-strikes callout band ──
 *     [▣ s1 +X.XM] [▣ s2 ...] [▣ s3 ...] [▣ s4 ...] [▣ s5 ...]
 *     (click → scrolls the heatmap to that strike + amber-ring flash)
 *   ── net-flow row ──
 *     NCP | NPP | Total
 *   ── heatmap grid (ATM ± 50 strikes) ──
 *     Strike | Gamma | Charm | Vanna (color-coded by sign + magnitude)
 *
 * Polling: 30s while the section is expanded AND the market is open
 * AND we're viewing today. Historical dates fetch once and stop (data
 * doesn't change). Hook lives in the inner `GreekHeatmapBody` so
 * collapsing the section unmounts the hook and tears down polling.
 *
 * See docs/superpowers/specs/per-ticker-greek-heatmap-2026-05-15.md.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  DEFAULT_GREEK_HEATMAP_TICKER,
  GREEK_HEATMAP_TICKER_UNIVERSE,
} from '../../constants/greekHeatmapUniverse';
import { useFollowedDate } from '../../hooks/useFollowedDate';
import { useGreekHeatmap } from '../../hooks/useGreekHeatmap';
import { DateInput } from '../ui/DateInput';
import { SectionBox } from '../ui/SectionBox';

import { DataAgeBadge } from './DataAgeBadge';
import { GreekHeatmapTable } from './GreekHeatmapTable';
import { MinuteScrubber } from './MinuteScrubber';
import { NetFlowRow } from './NetFlowRow';
import { PriceChip } from './PriceChip';
import { RegimeChip } from './RegimeChip';
import { RetryButton } from './RetryButton';
import { TopStrikesCallout } from './TopStrikesCallout';

const SELECT_CLASS =
  'rounded-md border border-neutral-800 bg-neutral-900/60 px-2 py-1 text-xs text-neutral-100 focus:border-neutral-600 focus:outline-none';

const DATE_INPUT_CLASS =
  'rounded-md border border-neutral-800 bg-neutral-900/60 px-2 py-1 font-mono text-xs text-neutral-100 focus:border-neutral-600 focus:outline-none';

// -1 sentinel = "All" (no slicing). Other values mean "N strikes each
// side of ATM" — index-based, not strike-dollar-based, because the
// chain's strike spacing varies by ticker (0.5, 1, 2.5, 5).
const STRIKE_RANGE_ALL = -1;
const STRIKE_RANGE_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 10, label: 'ATM ± 10' },
  { value: 20, label: 'ATM ± 20' },
  { value: 50, label: 'ATM ± 50' },
  { value: STRIKE_RANGE_ALL, label: 'All' },
];

interface GreekHeatmapSectionProps {
  marketOpen: boolean;
}

export function GreekHeatmapSection({ marketOpen }: GreekHeatmapSectionProps) {
  return (
    <SectionBox label="0DTE Greek Heatmap" collapsible>
      <GreekHeatmapBody marketOpen={marketOpen} />
    </SectionBox>
  );
}

function GreekHeatmapBody({ marketOpen }: GreekHeatmapSectionProps) {
  const [ticker, setTicker] = useState<string>(DEFAULT_GREEK_HEATMAP_TICKER);
  // The date follows today across ET midnight unless the owner picked another
  // one (the shared ET clock behind `useFollowedDate`). `today` is that same
  // clock, so the date and the live check turn together at the roll, and the
  // picker's `max` moves with it. This replaces a `today` re-read only on tab
  // refocus, which left an open tab on yesterday.
  const {
    date: selectedDate,
    setDate: setSelectedDate,
    today,
  } = useFollowedDate();
  // ISO 8601 UTC of the scrubbed minute, or null = LIVE (latest).
  // Default LIVE; the MinuteScrubber flips it when the user drags. The minute
  // is stored with the (ticker, date) it was set on and read only while that
  // pair is selected: indexed against another pair it would return empty or,
  // worse, look like it showed the new pair at that timestamp. A scrub for
  // another pair is dropped during render, with no effect, so no render pairs
  // the new ticker or date with the old minute (that would fetch it before the
  // clean request), and it cannot come back if the pair returns.
  const scrubScope = `${ticker}|${selectedDate}`;
  const [scrub, setScrub] = useState<{ scope: string; at: string } | null>(
    null,
  );
  if (scrub !== null && scrub.scope !== scrubScope) setScrub(null);
  const scrubbedAt =
    scrub !== null && scrub.scope === scrubScope ? scrub.at : null;
  const setScrubbedAt = useCallback(
    (at: string | null) =>
      setScrub(at === null ? null : { scope: scrubScope, at }),
    [scrubScope],
  );
  const [strikeRange, setStrikeRange] = useState<number>(10);
  const [highlightedStrike, setHighlightedStrike] = useState<number | null>(
    null,
  );
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const isViewingToday = selectedDate === today;
  const isLiveTip = scrubbedAt === null;
  // Date min/max bounds for the picker — 90-day floor matches the
  // backfill window. Both bounds come from `today`, the ET date from the
  // shared clock, so the picker can't drift one calendar day ahead of it after
  // the UTC midnight rollover (which fires at 19:00 ET — well before the user
  // goes home): without that, the user could pick a "future" ET date and
  // trigger the Historical badge for tomorrow. They move with it at ET
  // midnight. The floor is calendar arithmetic on `today` (noon UTC keeps it
  // clear of any day boundary).
  const dateBounds = useMemo(() => {
    const floor = new Date(`${today}T12:00:00Z`);
    floor.setUTCDate(floor.getUTCDate() - 90);
    return { min: floor.toISOString().slice(0, 10), max: today };
  }, [today]);

  const { data, loading, error, stale, transient, refresh } = useGreekHeatmap({
    ticker,
    date: isViewingToday ? undefined : selectedDate,
    at: scrubbedAt ?? undefined,
    // Polling only matters when viewing today AND tracking the live
    // tip (not scrubbed back). Historical dates and scrubbed minutes
    // fetch once and stop — the data they show doesn't change.
    enabled: marketOpen && isViewingToday && isLiveTip,
  });

  // Slice chainStrikes around ATM. Index-based (not strike-dollar
  // based) so ticker-specific strike spacing doesn't change the row
  // count. ATM not found → return full chain so the user still sees
  // something rather than an empty table.
  const visibleStrikes = useMemo(() => {
    if (data === null) return [];
    if (strikeRange === STRIKE_RANGE_ALL) return data.chainStrikes;
    if (data.atmStrike === null) return data.chainStrikes;
    const atmIdx = data.chainStrikes.findIndex(
      (s) => s.strike === data.atmStrike,
    );
    if (atmIdx === -1) return data.chainStrikes;
    const start = Math.max(0, atmIdx - strikeRange);
    const end = Math.min(data.chainStrikes.length, atmIdx + strikeRange + 1);
    return data.chainStrikes.slice(start, end);
  }, [data, strikeRange]);

  const onJumpToStrike = useCallback((strike: number) => {
    // ID must match the row id pattern in GreekHeatmapTable
    // (`strikeRowId`): `.` is replaced with `_` so the id is
    // querySelector-safe even though getElementById tolerates dots.
    const el = document.getElementById(
      `heatmap-strike-${String(strike).replace('.', '_')}`,
    );
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedStrike(strike);
    if (highlightTimeoutRef.current !== null) {
      clearTimeout(highlightTimeoutRef.current);
    }
    highlightTimeoutRef.current = setTimeout(() => {
      setHighlightedStrike(null);
      highlightTimeoutRef.current = null;
    }, 2000);
  }, []);

  useEffect(
    () => () => {
      if (highlightTimeoutRef.current !== null) {
        clearTimeout(highlightTimeoutRef.current);
      }
    },
    [],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-1.5 text-[11px] text-neutral-400">
          Ticker
          <select
            className={SELECT_CLASS}
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            aria-label="Heatmap ticker"
          >
            {GREEK_HEATMAP_TICKER_UNIVERSE.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-neutral-400">
          Date
          <DateInput
            value={selectedDate}
            min={dateBounds.min}
            max={dateBounds.max}
            onChange={setSelectedDate}
            label="Heatmap expiry date"
            labelVisible={false}
            className={DATE_INPUT_CLASS}
          />
        </span>
        <label className="inline-flex items-center gap-1.5 text-[11px] text-neutral-400">
          Strikes
          <select
            className={SELECT_CLASS}
            value={strikeRange}
            onChange={(e) => setStrikeRange(Number(e.target.value))}
            aria-label="Visible strike range around ATM"
          >
            {STRIKE_RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <PriceChip ticker={ticker} price={data?.underlyingPrice ?? null} />
        <RegimeChip
          regime={data?.regime ?? null}
          netGexK={data?.netGexK ?? null}
        />
        {!isViewingToday && (
          <span className="rounded-md border border-amber-500/60 bg-amber-950/40 px-2 py-0.5 text-[10px] tracking-wide text-amber-200 uppercase">
            Historical
          </span>
        )}
        <DataAgeBadge asOf={data?.asOf ?? null} />
      </div>

      {data !== null && (
        <MinuteScrubber
          range={data.intradayRange}
          at={scrubbedAt}
          dateStr={selectedDate}
          onChange={setScrubbedAt}
        />
      )}

      {data !== null && data.topStrikes.length > 0 && (
        <TopStrikesCallout
          topStrikes={data.topStrikes}
          onJumpToStrike={onJumpToStrike}
        />
      )}

      {loading && data === null && (
        <div className="rounded-md border border-neutral-800 bg-neutral-900/40 p-4 text-center text-xs text-neutral-500">
          Loading {ticker} {selectedDate} Greek snapshot…
        </div>
      )}

      {/* First-load failure (no last-good data to fall back on). A
          transient server state (HTTP 502/503/504 — 503 is the endpoint's
          retryable-Neon-timeout soft degrade) shows a muted, auto-retrying
          "Reconnecting" placeholder so an infra blip never surfaces as an
          alarming error card; the 30s poll silently recovers. A genuine
          failure (network, 500, bad shape) — or a sustained transient
          outage that the hook has escalated by flipping `transient` back to
          false — keeps the rose error banner. A transient poll failure that
          left us with stale-but-valid data renders the subtle stale badge
          below the grid instead. */}
      {error !== null && data === null && (
        <div
          className={
            transient
              ? 'flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-900/40 p-4 text-xs text-neutral-400'
              : 'flex items-center justify-between rounded-md border border-rose-800/70 bg-rose-950/30 p-3 text-xs text-rose-300'
          }
        >
          {transient ? (
            <span className="text-neutral-500">
              Reconnecting… auto-retrying
            </span>
          ) : (
            <span>Failed to load heatmap: {error}</span>
          )}
          <RetryButton
            onClick={() => refresh()}
            tone={transient ? 'neutral' : 'rose'}
          />
        </div>
      )}

      {data !== null && (
        <>
          {/* Stale affordance: the latest poll failed but we're still
              showing the prior good snapshot. Muted amber (matches the
              Historical badge) rather than the rose error banner, so the
              grid stays the focus. The failing error text is preserved in
              the title for hover/triage. */}
          {stale && (
            <div
              className="flex items-center justify-between rounded-md border border-amber-500/50 bg-amber-950/30 px-2 py-1 text-[10px] tracking-wide text-amber-200/90"
              title={error ?? undefined}
            >
              <span className="uppercase">
                ⚠ Stale — last good snapshot{data.asOf ? ` (${data.asOf})` : ''}
              </span>
              <RetryButton onClick={() => refresh()} tone="amber" />
            </div>
          )}
          <NetFlowRow netFlow={data.netFlow} />
          <div className="max-h-[60vh] overflow-y-auto">
            <GreekHeatmapTable
              chainStrikes={visibleStrikes}
              atmStrike={data.atmStrike}
              highlightedStrike={highlightedStrike}
            />
          </div>
          {data.chainStrikes.length === 0 && data.asOf === null && (
            <div className="text-center text-[11px] text-neutral-500">
              No Greek data for {ticker} on {selectedDate}
              {isViewingToday
                ? ' yet — likely a weekend, holiday, or the websocket subscription has not received its first tick.'
                : ' — either a weekend, holiday, or beyond the 90-day backfill window for this ticker.'}
            </div>
          )}
        </>
      )}
    </div>
  );
}
