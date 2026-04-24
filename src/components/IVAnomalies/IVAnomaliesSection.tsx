import { useState, type ReactElement } from 'react';
import { SectionBox } from '../ui';
import { useIVAnomalies } from '../../hooks/useIVAnomalies';
import {
  IV_ANOMALY_TICKERS,
  type ActiveAnomaly,
  type IVAnomalyTicker,
} from './types';
import { AnomalyRow } from './AnomalyRow';

/**
 * Standalone section that surfaces active IV anomalies aggregated by
 * compound key. Per-ticker tabs keep each symbol visually separate —
 * the detectors run on every ticker in `IV_ANOMALY_TICKERS` (indices +
 * macro/sector ETFs) but an owner is typically watching one at a time.
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
  const [activeTicker, setActiveTicker] = useState<IVAnomalyTicker>('SPX');
  const { anomalies, loading, error } = useIVAnomalies(true, marketOpen);

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
    body = (
      <div className="text-muted text-xs">
        No active IV anomalies for {activeTicker} right now. The detector runs
        every minute during market hours; entries drop off after 15 min of
        silence.
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-2">
        {rows.map((anomaly) => (
          <AnomalyRow key={anomaly.compoundKey} anomaly={anomaly} />
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
        <div className="flex items-center gap-2">
          {/*
            Horizontal-scroll rail: with 8 tickers the tab row overflows
            narrow viewports. Keeping the tabs on one line preserves the
            scan order (indices → ETFs) and matches the constant order.
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
