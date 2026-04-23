import { useState, type ReactElement } from 'react';
import { SectionBox } from '../ui';
import { useIVAnomalies } from '../../hooks/useIVAnomalies';
import {
  IV_ANOMALY_TICKERS,
  type IVAnomalyTicker,
  type IVAnomalyRow,
} from './types';
import { AnomalyRow } from './AnomalyRow';

/**
 * Standalone section that surfaces recent IV anomalies detected by the
 * Phase 1-2 pipeline. Per-ticker tabs (SPX / SPY / QQQ) keep each index
 * visually separate — the detectors run on all three but an owner is
 * typically watching one at a time.
 *
 * Owner-only: the wrapping `useIVAnomalies` hook returns null for public
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

  const rows: IVAnomalyRow[] = anomalies?.history[activeTicker] ?? [];

  let body: ReactElement;
  if (loading && !anomalies) {
    body = <div className="text-muted text-xs">Loading IV anomaly feed…</div>;
  } else if (error && !anomalies) {
    body = (
      <div className="text-xs text-rose-400">
        IV anomaly feed unavailable ({error})
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <div className="text-muted text-xs">
        No IV anomalies recorded for {activeTicker} yet today. The detector runs
        every minute during market hours.
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-2">
        {rows.map((anomaly) => (
          <AnomalyRow key={anomaly.id} anomaly={anomaly} />
        ))}
      </div>
    );
  }

  const tabCounts = IV_ANOMALY_TICKERS.map((t) => ({
    ticker: t,
    count: anomalies?.history[t]?.length ?? 0,
  }));

  return (
    <SectionBox label="Strike IV Anomalies" collapsible>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2" role="tablist">
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
                  'rounded-md px-3 py-1 font-mono text-xs transition-colors ' +
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
          {error && anomalies && (
            <span className="ml-auto text-[11px] text-amber-400">{error}</span>
          )}
        </div>
        {body}
      </div>
    </SectionBox>
  );
}
