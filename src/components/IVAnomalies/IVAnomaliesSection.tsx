import { useState, type ReactElement } from 'react';
import { SectionBox } from '../ui';
import { useIVAnomalies } from '../../hooks/useIVAnomalies';
import { useAnomalyCrossAsset } from '../../hooks/useAnomalyCrossAsset';
import {
  IV_ANOMALY_TICKERS,
  type ActiveAnomaly,
  type IVAnomalyTicker,
} from './types';
import { AnomalyRow } from './AnomalyRow';

/**
 * Standalone section that surfaces active IV anomalies aggregated by
 * compound key. Per-ticker tabs keep each symbol visually separate —
 * the detectors run on every ticker in `IV_ANOMALY_TICKERS` (SPXW, NDXP,
 * SPY, QQQ, IWM + single-name tech NVDA / SNDK as of the 2026-04-24
 * expansion) but an owner is typically watching one at a time.
 *
 * The list is one entry per active compound key (not one per raw detector
 * firing) so a strike that's firing every minute during a 90-min event
 * stays as ONE row that updates in place. Eviction happens in the hook
 * once the strike goes silent for ≥ ANOMALY_SILENCE_MS.
 *
 * Owner-only: the wrapping `useIVAnomalies` hook returns empty for public
 * visitors (401 from the endpoint). The caller is responsible for only
 * mounting this section behind `useIsOwner()` + marketOpen gating, but
 * this component also degrades gracefully if called prematurely.
 */
export function IVAnomaliesSection({
  marketOpen,
}: {
  readonly marketOpen: boolean;
}) {
  const [activeTicker, setActiveTicker] = useState<IVAnomalyTicker>('SPXW');
  const {
    anomalies,
    loading,
    error,
    selectedDate,
    setSelectedDate,
    scrubTime,
    isLive,
    isScrubbed,
    canScrubPrev,
    canScrubNext,
    scrubPrev,
    scrubNext,
    scrubLive,
  } = useIVAnomalies(true, marketOpen);

  // Phase F: cross-asset confluence context per active key. Polled in
  // parallel with the anomalies list; falls back to empty on error so the
  // pills render gray rather than blocking the row. Strictly visual.
  const { contexts: crossAssetContexts } = useAnomalyCrossAsset(
    anomalies,
    marketOpen,
  );

  const rowsByTicker = groupByTicker(anomalies);
  const rows = rowsByTicker[activeTicker];

  let body: ReactElement;
  if (loading && anomalies.length === 0) {
    body = <div className="text-muted text-xs">Loading IV anomaly feed…</div>;
  } else if (error && anomalies.length === 0) {
    body = (
      <div className="text-xs text-rose-400">
        IV anomaly feed unavailable ({error})
      </div>
    );
  } else if (rows.length === 0) {
    body = isLive ? (
      <div className="text-muted text-xs">
        No active IV anomalies for {activeTicker} right now. The detector runs
        every minute during market hours; entries drop off after 15 min of
        silence.
      </div>
    ) : (
      <div className="text-muted text-xs">
        No active IV anomalies for {activeTicker} at {scrubTime ?? '15:00'} CT
        on {selectedDate}. Try a different time slot or jump back to live.
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-2">
        {rows.map((anomaly) => (
          <AnomalyRow
            key={anomaly.compoundKey}
            anomaly={anomaly}
            crossAsset={crossAssetContexts[anomaly.compoundKey]}
          />
        ))}
      </div>
    );
  }

  const tabCounts = IV_ANOMALY_TICKERS.map((t) => ({
    ticker: t,
    count: rowsByTicker[t].length,
  }));

  return (
    <SectionBox label="Strike IV Anomalies" collapsible>
      <div className="flex flex-col gap-3">
        {/*
          Replay scrubber (Phase 3). Date input + 5-min time scrubber
          mirroring the dark-pool levels widget so the trader has one
          mental model across sections. Live mode (today + no scrubTime)
          shows a "scrubbing not active" affordance via the Live
          button being inert; scrubbed mode shows the active timestamp
          and a Live escape hatch.
        */}
        <div
          className="flex flex-wrap items-center gap-2 text-[11px]"
          role="toolbar"
          aria-label="Replay date and time controls"
        >
          <label className="text-muted flex items-center gap-1.5 font-mono">
            date
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="border-edge bg-surface-alt text-primary rounded-md border px-2 py-0.5 font-mono text-[11px]"
            />
          </label>
          <button
            type="button"
            onClick={scrubPrev}
            disabled={!canScrubPrev}
            className="border-edge bg-surface-alt text-muted hover:text-primary rounded-md border px-2 py-0.5 font-mono disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Step scrubber back 5 minutes"
          >
            ◀
          </button>
          <span
            className={`min-w-[60px] text-center font-mono ${
              isScrubbed ? 'text-amber-300' : 'text-muted'
            }`}
          >
            {scrubTime ?? (isLive ? 'live' : 'close')}
          </span>
          <button
            type="button"
            onClick={scrubNext}
            disabled={!canScrubNext}
            className="border-edge bg-surface-alt text-muted hover:text-primary rounded-md border px-2 py-0.5 font-mono disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Step scrubber forward 5 minutes"
          >
            ▶
          </button>
          <button
            type="button"
            onClick={scrubLive}
            disabled={isLive}
            className={`rounded-md border px-2 py-0.5 font-mono transition-colors ${
              isLive
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300/80'
                : 'border-edge bg-surface-alt text-muted hover:text-primary'
            }`}
            aria-label="Return to live"
          >
            Live
          </button>
          {isScrubbed && (
            <span className="text-muted ml-1 italic">
              showing alerts active at {scrubTime} CT on {selectedDate}
            </span>
          )}
          {!isLive && !isScrubbed && (
            <span className="text-muted ml-1 italic">
              showing alerts active at session close ({selectedDate})
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/*
            Horizontal-scroll rail: with 7 tickers (post 2026-04-24
            NVDA/SNDK expansion) the row may overflow on narrower
            desktops. overflow-scroll keeps tabs on one line and
            preserves the scan order (weekly-index roots → ETFs →
            single-name tech), matching the constant order.
          */}
          <div
            className="-mx-1 flex flex-1 gap-2 overflow-x-auto px-1 whitespace-nowrap"
            role="tablist"
          >
            {tabCounts.map(({ ticker, count }) => {
              const active = ticker === activeTicker;
              return (
                <button
                  key={ticker}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveTicker(ticker)}
                  className={
                    'shrink-0 rounded-md px-3 py-1 font-mono text-xs transition-colors ' +
                    (active
                      ? 'bg-accent-bg text-accent border-accent border'
                      : 'border-edge bg-surface-alt text-muted hover:text-primary border')
                  }
                >
                  {ticker}
                  {count > 0 && (
                    <span className="ml-2 font-semibold">{count}</span>
                  )}
                </button>
              );
            })}
          </div>
          {error && anomalies.length > 0 && (
            <span className="shrink-0 text-[11px] text-amber-400">{error}</span>
          )}
        </div>
        {body}
      </div>
    </SectionBox>
  );
}

function groupByTicker(
  anomalies: readonly ActiveAnomaly[],
): Record<IVAnomalyTicker, ActiveAnomaly[]> {
  const out = Object.fromEntries(
    IV_ANOMALY_TICKERS.map((t) => [t, [] as ActiveAnomaly[]]),
  ) as Record<IVAnomalyTicker, ActiveAnomaly[]>;
  for (const a of anomalies) {
    out[a.ticker].push(a);
  }
  return out;
}
