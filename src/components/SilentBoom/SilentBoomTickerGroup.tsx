/**
 * SilentBoomTickerGroup — collapsible per-ticker rollup wrapping
 * SilentBoomRow children. The header summarises the ticker's day:
 * total alert count, best realized peak%, and a chevron. Click
 * anywhere on the header to toggle.
 *
 * Phase 2 of docs/superpowers/specs/ticker-rollup-2026-05-14.md.
 */

import { memo, useCallback, useMemo } from 'react';
import type { SilentBoomAlert, SilentBoomExitPolicy } from './types.js';
import { SilentBoomRow } from './SilentBoomRow.js';
import type { TickerNetFlowSnapshot } from '../../hooks/useTickerNetFlowBatch.js';
import {
  BURST_STORM_BADGE_LABEL,
  computeRollupAggregates,
  formatBiasLabel,
  formatFlowLabel,
  formatPremiumAmount,
  formatSpreadDuration,
  formatTideLabel,
  HIGH_CONVICTION_BADGE_LABEL,
  type Bias,
  type RollupAlertSummary,
  type TideAggregate,
} from '../../utils/ticker-rollup-aggregates.js';
import { deltaFromAtFire } from '../../utils/macro-badges.js';

interface SilentBoomTickerGroupProps {
  ticker: string;
  alerts: SilentBoomAlert[];
  expanded: boolean;
  onToggle: (ticker: string) => void;
  marketOpen: boolean;
  exitPolicy: SilentBoomExitPolicy;
  /**
   * Conviction / storm flags computed by `useTickerGrouping` against
   * the UNFILTERED full-day alert set, so chip filters don't silently
   * erase the badges. Defaults to false when omitted (legacy/test
   * fixtures).
   */
  conviction?: boolean;
  storm?: boolean;
  /**
   * Live cumulative ticker NCP/NPP from useTickerNetFlowBatch. Null
   * before the first poll resolves or when the ticker isn't yet in the
   * WS subscription. Optional so existing test fixtures continue to
   * type-check; production sites always pass it. Forwarded to each
   * SilentBoomRow so the Flow Match / Inverted badges can render.
   */
  liveFlowSnapshot?: TickerNetFlowSnapshot | null;
}

function formatPeakPct(v: number | null): string {
  if (v == null) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

function biasChipClass(bias: Bias): string {
  if (bias === 'bull') return 'bg-emerald-950/40 text-emerald-400';
  if (bias === 'bear') return 'bg-red-950/40 text-red-400';
  return 'bg-neutral-800 text-neutral-300';
}

function alignChipClass(align: TideAggregate['align']): string {
  if (align === 'aligned') return 'bg-emerald-950/40 text-emerald-400';
  if (align === 'counter') return 'bg-red-950/40 text-red-400';
  if (align === 'unknown') return 'bg-neutral-900 text-neutral-500';
  return 'bg-neutral-800 text-neutral-300';
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
  conviction = false,
  storm = false,
  liveFlowSnapshot,
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

  const agg = useMemo(
    () =>
      computeRollupAggregates(
        alerts.map<RollupAlertSummary>((a) => ({
          optionType: a.optionType,
          mktTideDiff: a.mktTideDiff,
          directionGated: a.directionGated,
          triggeredAt: a.bucketCt,
          strike: a.strike,
          tickerNetFlowAtFire: deltaFromAtFire(
            a.tickerCumNcpAtFire,
            a.tickerCumNppAtFire,
          ),
          // Spike-bucket premium spent — what the detector saw fire.
          // spikeVolume is contracts in the burst minute; ×100 lifts
          // to share-equivalents for $ display.
          premium: a.entryPrice * a.spikeVolume * 100,
          // spikeRatio (multiple of preceding 4-bucket baseline) is
          // the burst-storm "intensity" arm for SilentBoom — a single
          // ×100+ outlier is the textbook "look at me" footprint.
          intensity: a.spikeRatio,
        })),
      ),
    [alerts],
  );

  // Badge state comes from the parent (useTickerGrouping), which
  // computes it against the UNFILTERED full-day set so chip filters
  // don't silently erase a ticker's true-footprint badges.
  const showConvictionBadge = conviction;
  const showStormBadge = storm;

  const strikesWithSpread =
    agg.strikeRange != null && strikesSummary
      ? `${strikesSummary} (${agg.strikeRange.spreadPts}pt)`
      : strikesSummary;

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
          <span
            className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-neutral-200"
            title="Number of distinct (chain × spike-bucket) silent-boom alerts for this ticker today. Each spike bucket counts once per chain even if the same contract spikes again later in the session."
          >
            {count} alert{count === 1 ? '' : 's'}
          </span>
          {showConvictionBadge && (
            <span
              className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[11px] font-bold text-amber-300 ring-1 ring-amber-400/60"
              title="≥3 alerts, single direction, multi-strike, within 15 min"
              data-testid={`silent-boom-ticker-conviction-${ticker}`}
            >
              {HIGH_CONVICTION_BADGE_LABEL}
            </span>
          )}
          {showStormBadge && (
            <span
              className="rounded bg-rose-500/20 px-1.5 py-0.5 font-mono text-[11px] font-bold text-rose-300 ring-1 ring-rose-400/60"
              title="≥8 alerts OR a ×100+ spike OR ≥$500K total premium"
              data-testid={`silent-boom-ticker-storm-${ticker}`}
            >
              {BURST_STORM_BADGE_LABEL}
            </span>
          )}
          {strikesWithSpread && (
            <span
              className="font-mono text-[11px] text-neutral-400"
              title="Distinct (strike, side) pairs hit by alerts in this group. Up to 3 shown then '+N more'; the trailing (Npt) is the strike-range spread in points between min and max."
              data-testid={`silent-boom-ticker-strikes-${ticker}`}
            >
              {strikesWithSpread}
            </span>
          )}
          {agg.bias && (
            <span
              className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${biasChipClass(agg.bias)}`}
              title="Net call vs put bias across this ticker's alerts. ↑ bull = calls dominate, ↓ bear = puts dominate, ~ mixed = both sides present without a clear lean."
              data-testid={`silent-boom-ticker-bias-${ticker}`}
            >
              {formatBiasLabel(agg.bias)}
            </span>
          )}
          <span
            className={`rounded px-1.5 py-0.5 font-mono text-[11px] leading-none font-semibold ${alignChipClass(agg.tide.align)}`}
            title="Does Market Tide (NCP − NPP) direction agree with this ticker's bias? aligned = same direction (tape is on the bet's side), counter = opposite (tape fighting), mixed = inconsistent across alerts, unknown = no tide data."
            aria-label="Does Market Tide direction agree with this ticker's bias?"
            data-testid={`silent-boom-ticker-tide-${ticker}`}
          >
            {formatTideLabel(agg.tide)}
          </span>
          <span
            className={`rounded px-1.5 py-0.5 font-mono text-[11px] leading-none font-semibold ${alignChipClass(agg.flow.align)}`}
            title="Does per-ticker net flow (cumNcpAtFire − cumNppAtFire) direction agree with this ticker's bias? Unlike Market Tide (which is the full-tape market-wide aggregate), this is restricted to cumulative flow on this ticker's options at fire time. aligned = same direction; counter = opposite (tape fighting the bet); mixed = inconsistent across alerts; unknown = no fire-time snapshot."
            aria-label="Does per-ticker net flow direction at fire time agree with this ticker's bias?"
            data-testid={`silent-boom-ticker-flow-${ticker}`}
          >
            {formatFlowLabel(agg.flow)}
          </span>
          {agg.spreadMinutes != null && (
            <span
              className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-neutral-300"
              title="Time span from first to last alert in this group. Short Δ (minutes) = burst; long Δ (hours) = sustained interest spread across the session."
              data-testid={`silent-boom-ticker-density-${ticker}`}
            >
              {formatSpreadDuration(agg.spreadMinutes)}
            </span>
          )}
          {agg.totalPremium != null && (
            <span
              className="rounded bg-sky-950/40 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-sky-300"
              title="Sum of spike-bucket premium across this ticker's alerts"
              data-testid={`silent-boom-ticker-premium-${ticker}`}
            >
              prem {formatPremiumAmount(agg.totalPremium)}
            </span>
          )}
          {agg.gatedCount > 0 && (
            <span
              className="rounded bg-amber-950/40 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-amber-400"
              title="Number of alerts in this group that were demoted to tier3 by the Market Tide direction gate (counter-trend at fire time, T=±100M on mkt_tide_diff). Score is preserved on each row; only the displayed tier is forced down."
              data-testid={`silent-boom-ticker-gated-${ticker}`}
            >
              {agg.gatedCount} gated
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          <span
            className="text-neutral-500"
            title="Most recent alert spike-bucket time (CT) for this ticker today."
            data-testid={`silent-boom-ticker-last-${ticker}`}
          >
            last <span className="font-mono text-neutral-300">{lastHitCt}</span>{' '}
            CT
          </span>
          <span
            className="text-neutral-500"
            title="Best peak return across every alert for this ticker today. Look-ahead reference (not tradeable) — expand the row to see realized exits per the selected policy."
          >
            best peak
          </span>
          <span
            className={`font-mono font-semibold ${peakColorClass(peakBest)}`}
            title="Best peak return across every alert for this ticker today. Look-ahead reference (not tradeable)."
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
            liveFlowSnapshot={liveFlowSnapshot}
          />
        ))}
      </div>
    </div>
  );
}

export const SilentBoomTickerGroup = memo(SilentBoomTickerGroupBase);
