/**
 * 0DTE Greek Heatmap section — sits between Lottery Finder and Silent
 * Boom in the app shell.
 *
 * Lets the trader pick any ticker in the alerts universe and see, for
 * today's 0DTE expiry:
 *   - underlying price chip + Long Γ / Short Γ regime chip
 *   - top 5 strikes by |net gamma OI| with per-strike gamma/charm/vanna
 *   - the row closest to spot highlighted as ATM
 *   - session-cumulative net flow (NCP / NPP / Total)
 *
 * Data comes from `/api/greek-heatmap`. Polls every 30s while the
 * section is expanded AND the market is open.
 *
 * The hook lives in the inner `GreekHeatmapBody` so polling tracks
 * SectionBox's expanded state automatically — collapsed = body
 * unmounts = hook tears down = no further fetches. No SectionBox API
 * extension needed.
 *
 * See docs/superpowers/specs/per-ticker-greek-heatmap-2026-05-15.md.
 */

import { useState } from 'react';

import {
  DEFAULT_GREEK_HEATMAP_TICKER,
  GREEK_HEATMAP_TICKER_UNIVERSE,
} from '../../constants/greekHeatmapUniverse';
import { useGreekHeatmap } from '../../hooks/useGreekHeatmap';
import { SectionBox } from '../ui/SectionBox';

import { GreekHeatmapTable } from './GreekHeatmapTable';
import { NetFlowRow } from './NetFlowRow';
import { PriceChip } from './PriceChip';
import { RegimeChip } from './RegimeChip';

const CHIP_BASE =
  'inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors tabular-nums';
const CHIP_INACTIVE =
  'border-neutral-800 bg-neutral-900/60 text-neutral-400 hover:border-neutral-700 hover:text-neutral-100';
const CHIP_ACTIVE = 'border-emerald-500/70 bg-emerald-950/40 text-emerald-200';

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

  const { data, loading, error, refetch } = useGreekHeatmap({
    ticker,
    enabled: marketOpen,
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <PriceChip ticker={ticker} price={data?.underlyingPrice ?? null} />
        <RegimeChip
          regime={data?.regime ?? null}
          netGexK={data?.netGexK ?? null}
        />
      </div>

      <div
        role="radiogroup"
        aria-label="Select ticker for Greek heatmap"
        className="flex flex-wrap gap-1.5"
      >
        {GREEK_HEATMAP_TICKER_UNIVERSE.map((t) => {
          const active = t === ticker;
          return (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setTicker(t)}
              className={`${CHIP_BASE} ${active ? CHIP_ACTIVE : CHIP_INACTIVE}`}
            >
              {t}
            </button>
          );
        })}
      </div>

      {loading && data === null && (
        <div className="rounded-md border border-neutral-800 bg-neutral-900/40 p-4 text-center text-xs text-neutral-500">
          Loading {ticker} 0DTE Greek snapshot…
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
          <GreekHeatmapTable
            topStrikes={data.topStrikes}
            atmStrike={data.atmStrike}
          />
          {data.topStrikes.length === 0 && data.asOf === null && (
            <div className="text-center text-[11px] text-neutral-500">
              No 0DTE expiry data for {ticker} today — likely a weekend,
              holiday, or the websocket subscription has not received its first
              tick yet.
            </div>
          )}
        </>
      )}
    </div>
  );
}
