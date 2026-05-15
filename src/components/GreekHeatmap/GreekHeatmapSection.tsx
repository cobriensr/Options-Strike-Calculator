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
import { useGreekHeatmap } from '../../hooks/useGreekHeatmap';
import { getETDateStr } from '../../utils/timezone';
import { SectionBox } from '../ui/SectionBox';

import { GreekHeatmapTable } from './GreekHeatmapTable';
import { NetFlowRow } from './NetFlowRow';
import { PriceChip } from './PriceChip';
import { RegimeChip } from './RegimeChip';
import { TopStrikesCallout } from './TopStrikesCallout';

const SELECT_CLASS =
  'rounded-md border border-neutral-800 bg-neutral-900/60 px-2 py-1 text-xs text-neutral-100 focus:border-neutral-600 focus:outline-none';

const DATE_INPUT_CLASS =
  'rounded-md border border-neutral-800 bg-neutral-900/60 px-2 py-1 font-mono text-xs text-neutral-100 focus:border-neutral-600 focus:outline-none';

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
  const [selectedDate, setSelectedDate] = useState<string>(() =>
    getETDateStr(new Date()),
  );
  const [highlightedStrike, setHighlightedStrike] = useState<number | null>(
    null,
  );
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const today = useMemo(() => getETDateStr(new Date()), []);
  const isViewingToday = selectedDate === today;
  // Date min/max bounds for the picker — 90-day floor matches the
  // backfill window. min/max are inclusive.
  const dateBounds = useMemo(() => {
    const todayDate = new Date();
    const oldest = new Date();
    oldest.setUTCDate(oldest.getUTCDate() - 90);
    return {
      min: oldest.toISOString().slice(0, 10),
      max: todayDate.toISOString().slice(0, 10),
    };
  }, []);

  const { data, loading, error, refetch } = useGreekHeatmap({
    ticker,
    date: isViewingToday ? undefined : selectedDate,
    // Polling only matters when viewing today. Historical dates fetch
    // once on date/ticker change and stop.
    enabled: marketOpen && isViewingToday,
  });

  const onJumpToStrike = useCallback((strike: number) => {
    const el = document.getElementById(`heatmap-strike-${strike}`);
    // jsdom and some older browsers don't implement scrollIntoView —
    // gate so the click handler never throws (the highlight state
    // below would otherwise never get set in test environments).
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
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
        <label className="inline-flex items-center gap-1.5 text-[11px] text-neutral-400">
          Date
          <input
            type="date"
            className={DATE_INPUT_CLASS}
            value={selectedDate}
            min={dateBounds.min}
            max={dateBounds.max}
            onChange={(e) => setSelectedDate(e.target.value || today)}
            aria-label="Heatmap expiry date"
          />
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
      </div>

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

      {error !== null && (
        <div className="flex items-center justify-between rounded-md border border-rose-800/70 bg-rose-950/30 p-3 text-xs text-rose-300">
          <span>Failed to load heatmap: {error}</span>
          <button
            type="button"
            onClick={() => refetch()}
            className="rounded border border-rose-700/70 px-2 py-0.5 text-[11px] hover:bg-rose-900/40"
          >
            Retry
          </button>
        </div>
      )}

      {data !== null && (
        <>
          <NetFlowRow netFlow={data.netFlow} />
          <div className="max-h-[60vh] overflow-y-auto">
            <GreekHeatmapTable
              chainStrikes={data.chainStrikes}
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
