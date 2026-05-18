/**
 * LotteryFinderTickerGroup — collapsible per-ticker rollup wrapping
 * LotteryRow children. Header shows ticker, fire count, best realized
 * peak%, and a chevron. Mirrors SilentBoomTickerGroup.
 *
 * Phase 3 of docs/superpowers/specs/ticker-rollup-2026-05-14.md.
 */

import { memo, useCallback, useMemo } from 'react';
import type { ExitPolicy, LotteryFire } from './types.js';
import { LotteryRow } from './LotteryRow.js';
import type { TickerNetFlowSnapshot } from '../../hooks/useTickerNetFlowBatch.js';
import {
  BURST_STORM_BADGE_LABEL,
  BURST_STORM_INTENSITY_THRESHOLDS,
  computeRollupAggregates,
  formatBiasLabel,
  formatFlowLabel,
  formatPremiumAmount,
  formatSpreadDuration,
  formatTideLabel,
  HIGH_CONVICTION_BADGE_LABEL,
  isBurstStorm,
  isHighConviction,
  type Bias,
  type RollupAlertSummary,
  type TideAggregate,
} from '../../utils/ticker-rollup-aggregates.js';
import { deltaFromAtFire } from '../../utils/macro-badges.js';

/**
 * Macro Window badge — fires whose triggerTimeCt is in this hours-to-
 * next-high-impact-event window get a "MACRO Nh" pill.
 *
 * Retuned 2026-05-16 from the original 24-72h spec to **72-168h** (3-7
 * days before a high-impact event) after the EDA rerun on full data
 * (`ml/findings/eda-rerun-2026-05-16/`) showed:
 *   - 24-72h bucket: lift50 = 0.92×, lift100 = 0.87× (slightly anti-edge)
 *   - 72-168h bucket: lift50 = 1.19×, lift100 = 1.28× on N=57,533
 * The original EDA's 24-72h finding (claimed 1.32× / 1.56×) was based
 * on a smaller cohort; full-data re-validation flipped the winning
 * bucket. Display-only — not in the score.
 */
const LF_MACRO_WINDOW_LO_HOURS = 72;
const LF_MACRO_WINDOW_HI_HOURS = 168;

/**
 * NEW HIGH threshold — `rangePosAtTrigger` is clamped to [0, 1] in
 * `api/_lib/uw-stock-candles.ts`; values that hit the upper clamp
 * (≥1.0) indicate the spike's spot punched ABOVE the session high
 * mid-bar — a clean breakout-momentum tell.
 *
 * Retargeted 2026-05-16 from the original "top-10% TOP-RANGE" badge
 * (range_pos ≥ 0.90) after the EDA rerun showed top-10% has only
 * lift50 = 1.01× / lift100 = 1.11× (essentially baseline). The
 * saturated-1.0 sub-bucket (N=143) shows win50 = 55.9%, win100 = 46.9%
 * — a real ~2.4× win100 lift, but small N. Display-only; re-validate
 * scoring effect at N≥300 before adding any score weight.
 */
const LF_NEW_HIGH_THRESHOLD = 1.0;

interface LotteryFinderTickerGroupProps {
  ticker: string;
  fires: LotteryFire[];
  expanded: boolean;
  onToggle: (ticker: string) => void;
  marketOpen: boolean;
  exitPolicy: ExitPolicy;
  /**
   * Live cumulative ticker NCP/NPP from useTickerNetFlowBatch. Null
   * before the first poll resolves or when the ticker isn't yet in the
   * WS subscription. Optional so existing test fixtures continue to
   * type-check; production sites always pass it. Forwarded to each
   * LotteryRow so the Flow Match / Inverted badges can render.
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
  liveFlowSnapshot,
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

  const agg = useMemo(
    () =>
      computeRollupAggregates(
        fires.map<RollupAlertSummary>((f) => ({
          optionType: f.optionType,
          mktTideDiff: f.macro.mktTideDiff,
          directionGated: f.directionGated,
          triggeredAt: f.triggerTimeCt,
          strike: f.strike,
          tickerNetFlowAtFire: deltaFromAtFire(
            f.macro.tickerCumNcpAtFire,
            f.macro.tickerCumNppAtFire,
          ),
          // Trigger-window premium spent on this chain — the size×price
          // signature the alert pipeline saw when it fired. windowSize
          // is total contracts in the burst window; ×100 lifts contract
          // count to share-equivalents for $ display.
          premium: f.entry.price * f.trigger.windowSize * 100,
          // Per-chain fireCount drives the burst-storm "intensity" arm
          // for Lottery (a chain firing many times in a day is what
          // "loud" looks like in this panel — analogous to SilentBoom's
          // spikeRatio).
          intensity: f.fireCount,
        })),
      ),
    [fires],
  );

  const showConvictionBadge = isHighConviction(agg, fires.length);
  const showStormBadge = isBurstStorm(
    agg,
    fires.length,
    BURST_STORM_INTENSITY_THRESHOLDS.lottery,
  );

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
          <span
            className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-neutral-200"
            title="Number of distinct (chain × day) triggers for this ticker today. The feed collapses repeat fires on the same chain to the most recent row, so this count is unique chains, not raw alert hits."
          >
            {count} fire{count === 1 ? '' : 's'}
          </span>
          {showConvictionBadge && (
            <span
              className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[11px] font-bold text-amber-300 ring-1 ring-amber-400/60"
              title="≥3 fires, single direction, multi-strike, within 15 min"
              data-testid={`lottery-ticker-conviction-${ticker}`}
            >
              {HIGH_CONVICTION_BADGE_LABEL}
            </span>
          )}
          {showStormBadge && (
            <span
              className="rounded bg-rose-500/20 px-1.5 py-0.5 font-mono text-[11px] font-bold text-rose-300 ring-1 ring-rose-400/60"
              title="≥8 fires OR a chain with ≥20 re-triggers OR ≥$500K total premium"
              data-testid={`lottery-ticker-storm-${ticker}`}
            >
              {BURST_STORM_BADGE_LABEL}
            </span>
          )}
          {strikesWithSpread && (
            <span
              className="font-mono text-[11px] text-neutral-400"
              title="Distinct (strike, side) pairs hit by alerts in this group. Up to 3 shown then '+N more'; the trailing (Npt) is the strike-range spread in points between min and max."
              data-testid={`lottery-ticker-strikes-${ticker}`}
            >
              {strikesWithSpread}
            </span>
          )}
          {agg.bias && (
            <span
              className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${biasChipClass(agg.bias)}`}
              title="Net call vs put bias across this ticker's alerts. ↑ bull = calls dominate, ↓ bear = puts dominate, ~ mixed = both sides present without a clear lean."
              data-testid={`lottery-ticker-bias-${ticker}`}
            >
              {formatBiasLabel(agg.bias)}
            </span>
          )}
          <span
            className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${alignChipClass(agg.tide.align)}`}
            title="Does Market Tide (NCP − NPP) direction agree with this ticker's bias? aligned = same direction (tape is on the bet's side), counter = opposite (tape fighting), mixed = inconsistent across alerts, unknown = no tide data."
            data-testid={`lottery-ticker-tide-${ticker}`}
          >
            {formatTideLabel(agg.tide)}
          </span>
          <span
            className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${alignChipClass(agg.flow.align)}`}
            title="Does per-ticker net flow (cumNcpAtFire − cumNppAtFire) direction agree with this ticker's bias? aligned = same direction; counter = opposite (tape fighting the bet); mixed = inconsistent across alerts; unknown = no fire-time snapshot."
            data-testid={`lottery-ticker-flow-${ticker}`}
          >
            {formatFlowLabel(agg.flow)}
          </span>
          {agg.spreadMinutes != null && (
            <span
              className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-neutral-300"
              title="Time span from first to last alert in this group. Short Δ (minutes) = burst; long Δ (hours) = sustained interest spread across the session."
              data-testid={`lottery-ticker-density-${ticker}`}
            >
              {formatSpreadDuration(agg.spreadMinutes)}
            </span>
          )}
          {agg.totalPremium != null && (
            <span
              className="rounded bg-sky-950/40 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-sky-300"
              title="Sum of trigger-window premium across this ticker's fires"
              data-testid={`lottery-ticker-premium-${ticker}`}
            >
              prem {formatPremiumAmount(agg.totalPremium)}
            </span>
          )}
          {agg.gatedCount > 0 && (
            <span
              className="rounded bg-amber-950/40 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-amber-400"
              title="Number of alerts in this group that were demoted to tier3 by the OTM Market Tide direction gate (counter-trend at fire time, T=±150M on mkt_tide_otm_diff). Score is preserved on each row; only the displayed tier is forced down."
              data-testid={`lottery-ticker-gated-${ticker}`}
            >
              {agg.gatedCount} gated
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          <span
            className="text-neutral-500"
            title="Most recent alert trigger time (CT) for this ticker today."
            data-testid={`lottery-ticker-last-${ticker}`}
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
        {fires.map((f) => {
          // Macro Window badge — fires 24-72h before a high-impact
          // macro event (FOMC/CPI/PCE/JOBS) show 1.32×/1.56× lift per
          // the 2026-05-15 cross-section EDA. Display-only. Rendered
          // here (rather than inside LotteryRow) so the row component
          // is untouched while this badge is being rolled out.
          const hrs = f.hoursToNextMacroEvent;
          const inMacroWindow =
            hrs != null &&
            hrs >= LF_MACRO_WINDOW_LO_HOURS &&
            hrs <= LF_MACRO_WINDOW_HI_HOURS;
          // NEW HIGH badge — fires whose underlying spot punched ABOVE
          // the session high mid-bar at trigger time (rangePosAtTrigger
          // saturated to its clamp at ≥1.0). 2026-05-16 EDA rerun found
          // 55.9% win50 / 46.9% win100 on N=143 — a real ~2.4× win100
          // lift, small N. Display-only until N≥300 re-validation.
          // Retargeted from the original top-10% TOP-RANGE badge after
          // the rerun showed only 1.01×/1.11× lift on top-10%.
          const rangePos = f.rangePosAtTrigger;
          const isNewHigh =
            rangePos != null && rangePos >= LF_NEW_HIGH_THRESHOLD;
          // Key by chain (server response is chain-day-deduped to one
          // row per chain, so optionChainId is unique within the
          // group). Matches the existing LotteryFinderSection key.
          return (
            <div key={f.optionChainId} className="relative">
              {inMacroWindow && (
                <span
                  data-testid="lottery-macro-window-badge"
                  className="absolute top-2 right-2 z-10 rounded border border-purple-500/60 bg-purple-950/60 px-1.5 py-0.5 text-[10px] font-semibold text-purple-200"
                  title={`Trigger fires ${Math.round(hrs)}h before the next high-impact economic event (FOMC/CPI/PCE/JOBS). 2026-05-16 EDA rerun found 1.19× win50 / 1.28× win100 lift on fires in the 72-168h window. Display-only.`}
                >
                  📅 MACRO {Math.round(hrs)}h
                </span>
              )}
              {isNewHigh && (
                <span
                  data-testid="lottery-new-high-badge"
                  className={`absolute z-10 rounded border border-emerald-500/60 bg-emerald-950/60 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-200 ${
                    inMacroWindow ? 'top-8 right-2' : 'top-2 right-2'
                  }`}
                  title={`Underlying spot punched above session high during the spike (range_pos clamped to ${rangePos.toFixed(2)} from a value ≥1). 2026-05-16 EDA rerun found 2.4× win100 lift on this cohort (N=143). Display-only; re-validate at N≥300.`}
                >
                  🔺 NEW HIGH
                </span>
              )}
              <LotteryRow
                fire={f}
                marketOpen={marketOpen}
                exitPolicy={exitPolicy}
                liveFlowSnapshot={liveFlowSnapshot}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const LotteryFinderTickerGroup = memo(LotteryFinderTickerGroupBase);
