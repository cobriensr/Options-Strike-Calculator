/**
 * Session-cumulative net flow display for the Greek Heatmap.
 *
 * Three rows: NCP (net call premium), NPP (net put premium), Total
 * (NCP + NPP). Total is green when positive (net buying premium across
 * the session), red when negative (net selling). NCP and NPP render
 * neutral — the trader reads the magnitudes themselves rather than
 * relying on a sign-based color cue.
 *
 * Values come from `ws_net_flow_per_ticker` summed at read time (the
 * table stores per-tick deltas, not running totals; see
 * `api/_lib/db-greek-heatmap.ts` for the SUM(...) OVER query).
 */

import type { GreekHeatmapNetFlow } from '../../hooks/useGreekHeatmap';
import { formatPremiumShort } from '../../utils/format-magnitude';

interface NetFlowRowProps {
  netFlow: GreekHeatmapNetFlow | null;
}

function formatVol(value: number): string {
  return value.toLocaleString();
}

export function NetFlowRow({ netFlow }: NetFlowRowProps) {
  if (netFlow === null) {
    return (
      <div className="rounded-md border border-neutral-800 bg-neutral-900/40 p-3 text-xs text-neutral-500">
        No net-flow data for this date.
      </div>
    );
  }
  const total = netFlow.cumulativeCallPrem + netFlow.cumulativePutPrem;
  const totalClass =
    total > 0
      ? 'text-emerald-400'
      : total < 0
        ? 'text-rose-400'
        : 'text-neutral-300';
  return (
    <div className="grid grid-cols-3 gap-3 rounded-md border border-neutral-800 bg-neutral-900/40 p-3 text-xs">
      <div className="flex flex-col">
        <span className="text-[10px] tracking-wide text-neutral-500 uppercase">
          NCP
        </span>
        <span
          className="text-sm font-medium text-neutral-200 tabular-nums"
          title={`Net call premium · ${formatVol(netFlow.cumulativeCallVol)} contracts`}
        >
          {formatPremiumShort(netFlow.cumulativeCallPrem)}
        </span>
      </div>
      <div className="flex flex-col">
        <span className="text-[10px] tracking-wide text-neutral-500 uppercase">
          NPP
        </span>
        <span
          className="text-sm font-medium text-neutral-200 tabular-nums"
          title={`Net put premium · ${formatVol(netFlow.cumulativePutVol)} contracts`}
        >
          {formatPremiumShort(netFlow.cumulativePutPrem)}
        </span>
      </div>
      <div className="flex flex-col">
        <span className="text-[10px] tracking-wide text-neutral-500 uppercase">
          Total
        </span>
        <span
          className={`text-sm font-semibold tabular-nums ${totalClass}`}
          title="NCP + NPP"
        >
          {formatPremiumShort(total)}
        </span>
      </div>
    </div>
  );
}
