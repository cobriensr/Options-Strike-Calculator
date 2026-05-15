/**
 * SilentBoomTickerGroup — collapsible per-ticker rollup wrapping
 * SilentBoomRow children. The header summarises the ticker's day:
 * total alert count, best realized peak%, and a chevron. Click
 * anywhere on the header to toggle.
 *
 * Phase 2 of docs/superpowers/specs/ticker-rollup-2026-05-14.md.
 */

import { memo, useCallback } from 'react';
import type { SilentBoomAlert, SilentBoomExitPolicy } from './types.js';
import { SilentBoomRow } from './SilentBoomRow.js';

interface SilentBoomTickerGroupProps {
  ticker: string;
  alerts: SilentBoomAlert[];
  expanded: boolean;
  onToggle: (ticker: string) => void;
  marketOpen: boolean;
  exitPolicy: SilentBoomExitPolicy;
}

function formatPeakPct(v: number | null): string {
  if (v == null) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

function peakColorClass(v: number | null): string {
  if (v == null) return 'text-neutral-500';
  if (v >= 100) return 'text-emerald-300';
  if (v >= 50) return 'text-emerald-400';
  if (v >= 20) return 'text-emerald-500';
  if (v > 0) return 'text-neutral-300';
  return 'text-red-400';
}

const CT_TIME_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Returns HH:MM CT for the latest bucketCt across the group. */
function formatLastHitCt(alerts: SilentBoomAlert[]): string {
  let maxMs = 0;
  for (const a of alerts) {
    const t = Date.parse(a.bucketCt);
    if (Number.isFinite(t) && t > maxMs) maxMs = t;
  }
  if (maxMs === 0) return '—';
  return CT_TIME_FMT.format(new Date(maxMs));
}

/**
 * Dedupes (strike, optionType) pairs across the alert list, preserves
 * input order (so the user's sortMode survives), shows up to 3, then
 * "+N more" if the rest were truncated. Strikes are formatted with
 * their option type suffix so the chain is unambiguous in the header.
 */
function formatStrikesSummary(alerts: SilentBoomAlert[]): string {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const a of alerts) {
    const key = `${a.strike}${a.optionType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(key);
  }
  if (labels.length === 0) return '';
  const visible = labels.slice(0, 3).join(', ');
  const extra = labels.length - 3;
  return extra > 0 ? `${visible} +${extra} more` : visible;
}

function SilentBoomTickerGroupBase({
  ticker,
  alerts,
  expanded,
  onToggle,
  marketOpen,
  exitPolicy,
}: SilentBoomTickerGroupProps) {
  const handleToggle = useCallback(() => onToggle(ticker), [onToggle, ticker]);

  // Best peak across all alerts for this ticker. Null when every
  // alert is still un-enriched (no peak_ceiling_pct yet).
  const peakBest = alerts.reduce<number | null>((best, a) => {
    const p = a.outcomes.peakCeilingPct;
    if (p == null) return best;
    if (best == null) return p;
    return Math.max(best, p);
  }, null);

  const count = alerts.length;
  const strikesSummary = formatStrikesSummary(alerts);
  const lastHitCt = formatLastHitCt(alerts);

  return (
    <div className="overflow-hidden rounded border border-neutral-800 bg-neutral-950/40">
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={expanded}
        aria-controls={`silent-boom-ticker-group-${ticker}`}
        className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-left transition hover:bg-neutral-900"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span
            className="text-neutral-500"
            aria-hidden="true"
            style={{ display: 'inline-block', width: '0.75rem' }}
          >
            {expanded ? '▾' : '▸'}
          </span>
          <span className="font-mono text-sm font-bold tracking-wide text-white">
            {ticker}
          </span>
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-neutral-200">
            {count} alert{count === 1 ? '' : 's'}
          </span>
          {strikesSummary && (
            <span
              className="font-mono text-[11px] text-neutral-400"
              data-testid={`silent-boom-ticker-strikes-${ticker}`}
            >
              {strikesSummary}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          <span
            className="text-neutral-500"
            data-testid={`silent-boom-ticker-last-${ticker}`}
          >
            last <span className="font-mono text-neutral-300">{lastHitCt}</span>{' '}
            CT
          </span>
          <span className="text-neutral-500">best peak</span>
          <span
            className={`font-mono font-semibold ${peakColorClass(peakBest)}`}
          >
            {formatPeakPct(peakBest)}
          </span>
        </div>
      </button>
      {/*
        Body is always rendered so `aria-controls` resolves to a live
        node and so per-row chart-expand state is preserved across
        ticker-group toggles. Visibility is toggled via the HTML
        `hidden` attribute (universally honored, including in jsdom
        tests). Rows fetch nothing while collapsed — SilentBoomRow's
        tape/net-flow/candle hooks are gated on the row's OWN expand
        flag, not on group visibility.
      */}
      <div
        id={`silent-boom-ticker-group-${ticker}`}
        hidden={!expanded}
        className="space-y-2 border-t border-neutral-800 bg-neutral-950 p-2"
      >
        {alerts.map((a) => (
          <SilentBoomRow
            key={`${a.optionChainId}|${a.bucketCt}`}
            alert={a}
            marketOpen={marketOpen}
            exitPolicy={exitPolicy}
          />
        ))}
      </div>
    </div>
  );
}

export const SilentBoomTickerGroup = memo(SilentBoomTickerGroupBase);
