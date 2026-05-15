/**
 * LotteryFinderTickerGroup — collapsible per-ticker rollup wrapping
 * LotteryRow children. Header shows ticker, fire count, best realized
 * peak%, and a chevron. Mirrors SilentBoomTickerGroup.
 *
 * Phase 3 of docs/superpowers/specs/ticker-rollup-2026-05-14.md.
 */

import { memo, useCallback } from 'react';
import type { ExitPolicy, LotteryFire } from './types.js';
import { LotteryRow } from './LotteryRow.js';

interface LotteryFinderTickerGroupProps {
  ticker: string;
  fires: LotteryFire[];
  expanded: boolean;
  onToggle: (ticker: string) => void;
  marketOpen: boolean;
  exitPolicy: ExitPolicy;
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

/** Returns HH:MM CT for the latest triggerTimeCt across the group. */
function formatLastHitCt(fires: LotteryFire[]): string {
  let maxMs = 0;
  for (const f of fires) {
    const t = Date.parse(f.triggerTimeCt);
    if (Number.isFinite(t) && t > maxMs) maxMs = t;
  }
  if (maxMs === 0) return '—';
  return CT_TIME_FMT.format(new Date(maxMs));
}

/**
 * Dedupes (strike, optionType) pairs across the fire list, preserves
 * input order (so the user's sortMode survives), shows up to 3, then
 * "+N more" if the rest were truncated.
 */
function formatStrikesSummary(fires: LotteryFire[]): string {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const f of fires) {
    const key = `${f.strike}${f.optionType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(key);
  }
  if (labels.length === 0) return '';
  const visible = labels.slice(0, 3).join(', ');
  const extra = labels.length - 3;
  return extra > 0 ? `${visible} +${extra} more` : visible;
}

function LotteryFinderTickerGroupBase({
  ticker,
  fires,
  expanded,
  onToggle,
  marketOpen,
  exitPolicy,
}: LotteryFinderTickerGroupProps) {
  const handleToggle = useCallback(() => onToggle(ticker), [onToggle, ticker]);

  // Best peak across all fires for this ticker. Null when every fire
  // is still un-enriched.
  const peakBest = fires.reduce<number | null>((best, f) => {
    const p = f.outcomes.peakCeilingPct;
    if (p == null) return best;
    if (best == null) return p;
    return Math.max(best, p);
  }, null);

  const count = fires.length;
  const strikesSummary = formatStrikesSummary(fires);
  const lastHitCt = formatLastHitCt(fires);

  return (
    <div className="overflow-hidden rounded border border-neutral-800 bg-neutral-950/40">
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={expanded}
        aria-controls={`lottery-ticker-group-${ticker}`}
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
            {count} fire{count === 1 ? '' : 's'}
          </span>
          {strikesSummary && (
            <span
              className="font-mono text-[11px] text-neutral-400"
              data-testid={`lottery-ticker-strikes-${ticker}`}
            >
              {strikesSummary}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          <span
            className="text-neutral-500"
            data-testid={`lottery-ticker-last-${ticker}`}
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
        node and per-row chart-expand state is preserved across
        ticker-group toggles. Visibility toggled via the HTML `hidden`
        attribute. Per-row tape/net-flow/candle fetches are gated on
        each row's OWN expand flag, not on group visibility.
      */}
      <div
        id={`lottery-ticker-group-${ticker}`}
        hidden={!expanded}
        className="space-y-2 border-t border-neutral-800 bg-neutral-950 p-2"
      >
        {fires.map((f) => (
          // Key by chain (server response is chain-day-deduped to one
          // row per chain, so optionChainId is unique within the
          // group). Matches the existing LotteryFinderSection key.
          <LotteryRow
            key={f.optionChainId}
            fire={f}
            marketOpen={marketOpen}
            exitPolicy={exitPolicy}
          />
        ))}
      </div>
    </div>
  );
}

export const LotteryFinderTickerGroup = memo(LotteryFinderTickerGroupBase);
