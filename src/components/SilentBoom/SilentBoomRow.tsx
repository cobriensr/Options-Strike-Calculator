import { memo, useMemo, useState } from 'react';
import { useContractTape } from '../../hooks/useContractTape.js';
import { useNetFlowHistory } from '../../hooks/useNetFlowHistory.js';
import { useTickerCandles } from '../../hooks/useTickerCandles.js';
import { ContractTapeChart } from '../LotteryFinder/ContractTapeChart.js';
import { TickerNetFlowChart } from '../LotteryFinder/TickerNetFlowChart.js';
import { TakeItScore } from '../TakeItScore/TakeItScore.js';
import {
  SILENT_BOOM_EXIT_POLICY_LABELS,
  SILENT_BOOM_EXIT_POLICY_TOOLTIPS,
  type SilentBoomAlert,
  type SilentBoomExitPolicy,
  type SilentBoomScoreTier,
} from './types.js';
import { formatPremiumAmount } from '../../utils/ticker-rollup-aggregates.js';
import { computeFlowMatch } from '../../utils/flow-match.js';
import type { TickerNetFlowSnapshot } from '../../hooks/useTickerNetFlowBatch.js';

interface SilentBoomRowProps {
  alert: SilentBoomAlert;
  /** Whether the parent's date is today (drives polling). */
  marketOpen: boolean;
  /** Which realized exit policy to surface as the primary % column. */
  exitPolicy: SilentBoomExitPolicy;
  /**
   * Live cumulative ticker net flow for this alert's underlying.
   * Optional so existing test fixtures continue to type-check;
   * production sites always pass it. Null before the first poll
   * resolves or when the ticker isn't yet on the WS subscription.
   */
  liveFlowSnapshot?: TickerNetFlowSnapshot | null;
}

const uwContractUrl = (alert: { optionChainId: string }): string =>
  `https://unusualwhales.com/flow/option_chains?chain=${encodeURIComponent(alert.optionChainId)}`;

const formatTimeCT = (iso: string): string => {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Chicago',
  });
};

const formatPct = (n: number | null): string => {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
};

const formatDollar = (n: number): string => {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
};

const formatExpiryShort = (iso: string): string => {
  const parts = iso.split('-');
  const m = parts[1];
  const d = parts[2];
  if (m == null || d == null) return iso;
  return `${Number.parseInt(m, 10)}/${Number.parseInt(d, 10)}`;
};

const formatExpiryFull = (iso: string): string => {
  const parts = iso.split('-');
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (y == null || m == null || d == null) return iso;
  return `${m}/${d}/${y}`;
};

const dteChipClass = (dte: number): string => {
  if (dte === 0) return 'border-rose-500/50 bg-rose-950/40 text-rose-200';
  if (dte <= 3) return 'border-amber-500/40 bg-amber-950/30 text-amber-200';
  return 'border-neutral-700 bg-neutral-900 text-neutral-300';
};

const formatVol = (n: number): string => {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
};

const formatPremium = (n: number): string => {
  const sign = n >= 0 ? '+' : '−';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
};

const pctClass = (n: number | null): string => {
  if (n == null) return 'text-neutral-500';
  if (n >= 50) return 'text-green-300';
  if (n >= 0) return 'text-green-400';
  if (n >= -25) return 'text-amber-300';
  return 'text-red-300';
};

const optionTypeBadge = (t: 'C' | 'P'): string =>
  t === 'C'
    ? 'border-green-500/40 bg-green-950/30 text-green-200'
    : 'border-red-500/40 bg-red-950/30 text-red-200';

const rowContainerClass = (t: 'C' | 'P'): string =>
  t === 'C'
    ? 'border-green-900/40 bg-green-950/20'
    : 'border-red-900/40 bg-red-950/20';

/**
 * Market Tide badge — display-only macro context. Same shape as
 * lottery's tideBadge: arrow + sign on the NCP - NPP value snapshotted
 * at the spike-bucket time. Per lottery's spec Appendix A this is
 * informational regime context, never a selection signal.
 */
const tideBadge = (
  diff: number | null,
): { label: string; cls: string; tooltip: string } | null => {
  if (diff == null) return null;
  const arrow = diff > 0 ? '⬆' : diff < 0 ? '⬇' : '→';
  const cls =
    diff > 0
      ? 'border-green-500/40 bg-green-950/30 text-green-200'
      : diff < 0
        ? 'border-red-500/40 bg-red-950/30 text-red-200'
        : 'border-neutral-700 bg-neutral-900 text-neutral-300';
  return {
    label: `Tide ${arrow}`,
    cls,
    tooltip: `Market Tide NCP - NPP at the spike-bucket time = ${diff.toFixed(0)}. Display-only macro context, not a selection signal.`,
  };
};

/**
 * Tier badge — fire-emoji conviction signal mirroring LotteryRow's
 * pattern. Tier 1 (~5% of fires) historically lands ~56% high-peak;
 * Tier 3 ~8%. See api/_lib/silent-boom-score.ts for calibration.
 */
const tierBadge = (
  tier: SilentBoomScoreTier | null,
  score: number | null,
): { label: string; cls: string; tooltip: string } => {
  if (tier === 'tier1') {
    return {
      label: '🔥🔥🔥',
      cls: 'border-rose-500/50 bg-rose-950/40 text-rose-200',
      tooltip: `Tier 1 (score ${score ?? '?'} ≥ 21): high conviction — ~56% of historical Tier 1 fires hit ≥50% peak return (vs 16% baseline).`,
    };
  }
  if (tier === 'tier2') {
    return {
      label: '🔥🔥',
      cls: 'border-amber-500/40 bg-amber-950/30 text-amber-200',
      tooltip: `Tier 2 (score ${score ?? '?'} = 8-20): solid setup — ~37% of historical Tier 2 fires hit ≥50% peak return.`,
    };
  }
  return {
    label: '🔥',
    cls: 'border-neutral-700 bg-neutral-900 text-neutral-400',
    tooltip: `Tier 3 (score ${score ?? '?'} < 8): low conviction — ~8% of historical Tier 3 fires hit ≥50% peak return.`,
  };
};

/**
 * Direction-gated pill — Phase 4 (spec:
 * silent-boom-direction-gate-and-trail-ui-2026-05-14.md). Surfaced
 * next to the tier badge when the alert was counter-trend per Market
 * Tide at fire time. The detector already demoted score_tier to
 * 'tier3' on insert; the pill explains the demote so the user knows
 * it isn't a noisy score but a deliberate macro gate.
 */
const gatedPill = (): { label: string; cls: string; tooltip: string } => ({
  label: 'Gated',
  cls: 'border-amber-500/60 bg-amber-950/40 text-amber-200',
  tooltip:
    'Counter-trend per Market Tide at fire time — demoted to tier3 by the direction gate (T=±100M on mkt_tide_diff). Score is preserved on the row; only the displayed tier is forced down.',
});

/**
 * Flow Match / Flow Mismatch badge — does the ticker's current
 * cumulative net flow agree with this alert's option type? Green when
 * NCP > NPP for a call (or NPP > NCP for a put); red on the inverse.
 * No badge when the snapshot is missing (cold start) or flat.
 */
const flowMatchBadge = (
  optionType: 'C' | 'P',
  liveFlowSnapshot: { cumNcp: number; cumNpp: number } | null,
): { label: string; cls: string; tooltip: string } | null => {
  const state = computeFlowMatch(
    optionType,
    liveFlowSnapshot?.cumNcp,
    liveFlowSnapshot?.cumNpp,
  );
  if (state === 'unknown' || state === 'flat') return null;
  const delta =
    liveFlowSnapshot != null
      ? liveFlowSnapshot.cumNcp - liveFlowSnapshot.cumNpp
      : 0;
  const deltaStr = `${delta >= 0 ? '+' : ''}$${(delta / 1_000_000).toFixed(1)}M`;
  if (state === 'match') {
    return {
      label: 'Flow Match',
      cls: 'border-emerald-500/60 bg-emerald-950/40 text-emerald-200',
      tooltip: `Ticker cum NCP − NPP = ${deltaStr}. Same direction as this ${optionType === 'C' ? 'call' : 'put'} alert — the dominant side of the tape agrees with the bet.`,
    };
  }
  return {
    label: 'Flow Mismatch',
    cls: 'border-red-500/60 bg-red-950/40 text-red-200',
    tooltip: `Ticker cum NCP − NPP = ${deltaStr}. Opposite direction from this ${optionType === 'C' ? 'call' : 'put'} alert — the dominant side of the tape is fighting the bet.`,
  };
};

/**
 * Multi-leg share sweet-spot — 10–50% spread legs is the "spread-
 * confirmed" cohort with 2.08× win50 and 2.73× win100 lift per the
 * 2026-05-15 cross-section EDA. Below 10% is single-leg-dominated
 * (baseline behavior); 50–70% is mixed; 70%+ is dealer-hedge dump
 * with 0.64× lift (actively bad). Display-only badge for now — N=217
 * in the sweet spot is too small to justify scoring per the EDA caveat.
 */
const SB_SPREAD_CONFIRMED_LO = 0.1;
const SB_SPREAD_CONFIRMED_HI = 0.5;

/**
 * Returns a badge spec when the alert falls in the spread-confirmed
 * sweet spot, null otherwise. Rows with no attribution
 * (multi_leg_share IS NULL on pre-#146 rows) get no badge.
 */
const spreadConfirmedBadge = (
  multiLegShare: number | null,
): { label: string; cls: string; tooltip: string } | null => {
  if (multiLegShare == null) return null;
  if (
    multiLegShare < SB_SPREAD_CONFIRMED_LO ||
    multiLegShare > SB_SPREAD_CONFIRMED_HI
  ) {
    return null;
  }
  const pct = Math.round(multiLegShare * 100);
  return {
    label: 'Spread-Confirmed',
    cls: 'border-emerald-500/60 bg-emerald-950/40 text-emerald-200',
    tooltip: `Multi-leg share ${pct}% — in the 10-50% sweet spot where institutional spread positioning confirms the spike. Historical lift: 2.08× win50, 2.73× win100 (EDA 2026-05-15). Display-only badge.`,
  };
};

/**
 * Spike-ratio badge — gives the eye an at-a-glance read on how
 * extreme the burst was vs the contract's own preceding 4-bucket
 * baseline. Detector min is 5x; tiers above that flag genuinely
 * outlier prints.
 */
const spikeBadge = (
  ratio: number,
): { label: string; cls: string; tooltip: string } => {
  if (ratio >= 50) {
    return {
      label: `×${ratio.toFixed(0)}`,
      cls: 'border-rose-500/50 bg-rose-950/40 text-rose-200',
      tooltip: `Spike ${ratio.toFixed(0)}× the preceding 4-bucket baseline — extreme outlier.`,
    };
  }
  if (ratio >= 20) {
    return {
      label: `×${ratio.toFixed(0)}`,
      cls: 'border-amber-500/40 bg-amber-950/30 text-amber-200',
      tooltip: `Spike ${ratio.toFixed(0)}× the preceding 4-bucket baseline.`,
    };
  }
  return {
    label: `×${ratio.toFixed(0)}`,
    cls: 'border-neutral-700 bg-neutral-900 text-neutral-300',
    tooltip: `Spike ${ratio.toFixed(0)}× the preceding 4-bucket baseline (detector floor 5×).`,
  };
};

/**
 * Custom equality: re-render only when something visible changed.
 * The `alert` object identity flips on every 30s poll because it's
 * spread fresh from the API JSON, so default shallow `memo` would
 * re-render every row tree (including the `useMemo` blocks) on every
 * tick. Compare the fields the row actually renders.
 */
function areRowsEqual(prev: SilentBoomRowProps, next: SilentBoomRowProps) {
  if (prev.marketOpen !== next.marketOpen) return false;
  if (prev.exitPolicy !== next.exitPolicy) return false;
  const a = prev.alert;
  const b = next.alert;
  if (a.id !== b.id) return false;
  if (a.score !== b.score) return false;
  if (a.scoreTier !== b.scoreTier) return false;
  if (a.directionGated !== b.directionGated) return false;
  if (a.multiLegShare !== b.multiLegShare) return false;
  if (a.mktTideDiff !== b.mktTideDiff) return false;
  if (a.avgHoldMinutes !== b.avgHoldMinutes) return false;
  if (a.outcomes.enrichedAt !== b.outcomes.enrichedAt) return false;
  if (a.outcomes.peakCeilingPct !== b.outcomes.peakCeilingPct) return false;
  if (a.outcomes.minutesToPeak !== b.outcomes.minutesToPeak) return false;
  if (a.outcomes.realized30mPct !== b.outcomes.realized30mPct) return false;
  if (a.outcomes.realized60mPct !== b.outcomes.realized60mPct) return false;
  if (a.outcomes.realized120mPct !== b.outcomes.realized120mPct) return false;
  if (a.outcomes.realizedEodPct !== b.outcomes.realizedEodPct) return false;
  if (a.outcomes.realizedTrail3010Pct !== b.outcomes.realizedTrail3010Pct) {
    return false;
  }
  return true;
}

export const SilentBoomRow = memo(function SilentBoomRow({
  alert,
  marketOpen,
  exitPolicy,
  liveFlowSnapshot,
}: SilentBoomRowProps) {
  const peak = alert.outcomes.peakCeilingPct;
  const realizedEod = alert.outcomes.realizedEodPct;
  const realizedTrail = alert.outcomes.realizedTrail3010Pct;
  const mtp = alert.outcomes.minutesToPeak;
  // Selected exit policy drives the primary big number on the row.
  // 'peak' is special-cased: it lives on the row already as a separate
  // small reference, so when active it just becomes the primary too.
  const primaryValue: number | null = alert.outcomes[exitPolicy];
  const primaryLabel = SILENT_BOOM_EXIT_POLICY_LABELS[exitPolicy];
  const primaryTooltip = SILENT_BOOM_EXIT_POLICY_TOOLTIPS[exitPolicy];
  const spike = spikeBadge(alert.spikeRatio);
  const tier = tierBadge(alert.scoreTier, alert.score);
  const tide = tideBadge(alert.mktTideDiff);
  const gated = alert.directionGated ? gatedPill() : null;
  const spreadConfirmed = spreadConfirmedBadge(alert.multiLegShare);
  const flowMatch = flowMatchBadge(alert.optionType, liveFlowSnapshot ?? null);

  const [expanded, setExpanded] = useState(false);

  const tape = useContractTape({
    chain: alert.optionChainId,
    date: alert.date,
    enabled: expanded,
    marketOpen,
  });
  const netFlow = useNetFlowHistory({
    ticker: alert.underlyingSymbol,
    date: alert.date,
    enabled: expanded,
    marketOpen,
  });
  const tickerCandles = useTickerCandles({
    ticker: alert.underlyingSymbol,
    date: alert.date,
    enabled: expanded,
    marketOpen,
  });

  const tapeStats = useMemo(() => {
    if (tape.series.length === 0) return null;
    let bid = 0;
    let ask = 0;
    let mid = 0;
    let noSide = 0;
    let priceVolSum = 0;
    let volSum = 0;
    for (const r of tape.series) {
      bid += r.bidVol;
      ask += r.askVol;
      mid += r.midVol;
      noSide += r.noSideVol;
      if (r.avgPrice != null && Number.isFinite(r.avgPrice) && r.totalVol > 0) {
        priceVolSum += r.avgPrice * r.totalVol;
        volSum += r.totalVol;
      }
    }
    return {
      bid,
      ask,
      mid,
      noSide,
      total: bid + ask + mid + noSide,
      avgFill: volSum > 0 ? priceVolSum / volSum : null,
    };
  }, [tape.series]);

  const flowStats = useMemo(() => {
    if (netFlow.series.length === 0) return null;
    const last = netFlow.series.at(-1);
    if (last == null) return null;
    return {
      cumNcp: last.cumNcp,
      cumNpp: last.cumNpp,
      diff: last.cumNcp - last.cumNpp,
    };
  }, [netFlow.series]);

  return (
    <div
      className={`rounded border p-3 text-sm ${rowContainerClass(alert.optionType)}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* Tier badge — peak-potential at a glance. Sits before the
            ticker so the user's eye lands on conviction first. */}
        <span
          className={`rounded border px-1.5 py-0.5 text-[11px] leading-none font-semibold ${tier.cls}`}
          title={tier.tooltip}
          aria-label={tier.tooltip}
        >
          {tier.label}
        </span>
        {/* Phase 4 direction-gate pill — surfaces the demote reason
            so the user can distinguish "low score" from "counter-trend
            macro context flagged it down." Sits right after the tier
            badge so the two read as a unit. */}
        {gated && (
          <span
            data-testid="silent-boom-gated-pill"
            className={`rounded border px-1.5 py-0.5 text-[10px] leading-none font-semibold ${gated.cls}`}
            title={gated.tooltip}
            aria-label={gated.tooltip}
          >
            {gated.label}
          </span>
        )}
        {/* Flow Match / Mismatch — does the ticker's live cum NCP/NPP
            delta agree with this alert's option type? Green when the
            tape is on the bet's side, red when fighting it. */}
        {flowMatch && (
          <span
            data-testid="silent-boom-flow-match-badge"
            className={`rounded border px-1.5 py-0.5 text-[10px] leading-none font-semibold ${flowMatch.cls}`}
            title={flowMatch.tooltip}
            aria-label={flowMatch.tooltip}
          >
            {flowMatch.label}
          </span>
        )}
        {/* Take-It score tile (Phase 4 of takeit-phase3-production-scoring-
            2026-05-16.md). Calibrated XGBoost prob + SHAP top-K flags.
            Sits after the gated pill so it reads as part of the conviction
            cluster, before the spread-confirmed and spike badges. */}
        <TakeItScore
          prob={alert.takeitProb}
          topFeatures={alert.takeitTopFeatures}
          expanded
        />
        {/* Spread-Confirmed badge — surfaces alerts in the 10-50%
            multi-leg share sweet spot (2.08×/2.73× lift per the
            2026-05-15 cross-section EDA). Display-only; no score
            impact until the sweet-spot N grows past 500. */}
        {spreadConfirmed && (
          <span
            data-testid="silent-boom-spread-confirmed-badge"
            className={`rounded border px-1.5 py-0.5 text-[10px] leading-none font-semibold ${spreadConfirmed.cls}`}
            title={spreadConfirmed.tooltip}
            aria-label={spreadConfirmed.tooltip}
          >
            {spreadConfirmed.label}
          </span>
        )}
        {/* Avg-hold-minutes hint — historical P75 minutes-to-peak among
            winners for this (tier, ticker) cohort. Tells the user "if
            this alert is going to work, expect it to peak around this
            many minutes after the spike." Sourced from the cohort
            lookup in api/_lib/silent-boom-hold.ts. */}
        <span
          className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 font-mono text-[10px] leading-none text-neutral-300"
          title={`Cohort avg hold ~${alert.avgHoldMinutes} minutes — historical P75 of minutes-to-peak among winners (peak ≥ 50%) for ${alert.scoreTier ?? 'tier3'} alerts on ${alert.underlyingSymbol}. Use as a typical exit-window expectation, not a hard rule.`}
        >
          ~{alert.avgHoldMinutes}min
        </span>
        <a
          href={uwContractUrl(alert)}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-baseline gap-2 hover:underline"
          title={`Open ${alert.optionChainId} on Unusual Whales`}
        >
          <span className="font-mono text-base font-semibold text-white group-hover:text-blue-300">
            {alert.underlyingSymbol}
          </span>
          <span className="font-mono text-base text-neutral-200 group-hover:text-blue-200">
            {alert.strike}
          </span>
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${optionTypeBadge(alert.optionType)}`}
            title={alert.optionType === 'C' ? 'Call' : 'Put'}
          >
            {alert.optionType}
          </span>
          <span
            className={`rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none ${dteChipClass(alert.dte)}`}
            title={`Expires ${formatExpiryFull(alert.expiry)} — ${
              alert.dte === 0
                ? '0DTE (same day)'
                : `${alert.dte} day${alert.dte === 1 ? '' : 's'} to expiry`
            }`}
          >
            {formatExpiryShort(alert.expiry)} · {alert.dte}D
          </span>
          <span
            className="text-[10px] text-neutral-600 group-hover:text-blue-400"
            aria-hidden
          >
            ↗
          </span>
        </a>

        <span className="font-mono text-xs text-neutral-400">
          {formatTimeCT(alert.bucketCt)} CT
        </span>

        {/* "Still hot" pulse — only when market is open and the
            alert's spike bucket is within the last 10 minutes. The
            polling refresh (~30s) keeps this honest without per-row
            timers. Mirrors LotteryRow. */}
        {marketOpen &&
          Date.now() - new Date(alert.bucketCt).getTime() < 10 * 60_000 && (
            <span
              className="inline-flex items-center gap-1 rounded border border-red-500/50 bg-red-950/40 px-1.5 py-0.5 text-[10px] font-semibold text-red-200"
              title="Spike bucket fired within the last 10 minutes — alert is still hot."
            >
              <span
                className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-red-400"
                aria-hidden
              />
              hot
            </span>
          )}

        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] leading-none font-semibold ${spike.cls}`}
          title={spike.tooltip}
        >
          {spike.label} burst
        </span>

        <span
          className="text-[11px] text-neutral-300"
          title="Vol/OI in the spike bucket — share of the whole open interest that traded in 5 minutes."
        >
          vol/OI{' '}
          <span className="font-mono text-neutral-100">
            {(alert.volOi * 100).toFixed(0)}%
          </span>
        </span>

        <span
          className="text-[11px] text-neutral-300"
          title="Ask-side share of the spike bucket. ≥70% → directional buy pressure."
        >
          ask%{' '}
          <span className="font-mono text-neutral-100">
            {(alert.askPct * 100).toFixed(0)}%
          </span>
        </span>

        {/* Market Tide context — display-only. */}
        {tide && (
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${tide.cls}`}
            title={tide.tooltip}
          >
            {tide.label}
          </span>
        )}

        <span className="flex-1" />

        <div className="flex items-baseline gap-3">
          <span
            className={`font-mono text-lg font-bold ${pctClass(primaryValue)}`}
            title={primaryTooltip}
          >
            {formatPct(primaryValue)}
          </span>
          <span
            className="text-[10px] tracking-wide text-neutral-500 uppercase"
            title={primaryTooltip}
          >
            {primaryLabel}
          </span>
          {/* When peak is not the primary, show it as a small reference
              chip so the look-ahead ceiling is always visible. When
              peak IS primary, surface t+Nm to-peak time instead. */}
          {exitPolicy !== 'peakCeilingPct' && peak != null && (
            <span
              className={`font-mono text-xs ${pctClass(peak)}`}
              title="Peak ceiling — best-case % gain. Look-ahead reference, not tradeable."
            >
              peak {formatPct(peak)}
            </span>
          )}
          {exitPolicy === 'peakCeilingPct' &&
            mtp != null &&
            peak != null &&
            peak > 0 && (
              <span
                className="text-[10px] text-neutral-500"
                title="Minutes from spike bucket start to the peak print."
              >
                t+{mtp.toFixed(0)}m
              </span>
            )}
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-neutral-400">
        <span>
          entry{' '}
          <span className="font-mono text-neutral-200">
            {formatDollar(alert.entryPrice)}
          </span>
        </span>
        <span title="Spike-bucket premium: entry price × spike volume × 100">
          prem{' '}
          <span
            className="font-mono text-sky-300"
            data-testid={`silent-boom-row-premium-${alert.optionChainId}-${alert.bucketCt}`}
          >
            {formatPremiumAmount(alert.entryPrice * alert.spikeVolume * 100)}
          </span>
        </span>
        <span>
          spike vol{' '}
          <span className="font-mono text-neutral-200">
            {formatVol(alert.spikeVolume)}
          </span>
        </span>
        <span title="Median per-bucket volume in the 4 buckets preceding the spike — the baseline the multiplier was measured against.">
          baseline{' '}
          <span className="font-mono text-neutral-300">
            {formatVol(alert.baselineVolume)}
          </span>
        </span>
        <span>
          OI{' '}
          <span className="font-mono text-neutral-300">
            {formatVol(alert.openInterest)}
          </span>
        </span>
        <span
          className={`font-mono ${pctClass(realizedEod)}`}
          title="Realized return at the last tick of the session."
        >
          eod {formatPct(realizedEod)}
        </span>
        {/* Phase 2 trail-30/10 exit — recommended exit policy. Activate
            trailing stop at +30%, exit at 10pp giveback from running
            peak; if peak never crosses +30%, hold to EoD. Smaller font
            than eod so it reads as a secondary metric, em-dash when
            null (legacy rows pre-#150 / pending enrich). */}
        <span
          data-testid="silent-boom-trail3010"
          className={`font-mono text-[10px] ${pctClass(realizedTrail)}`}
          title="Trail-30/10 exit: activate trailing stop at +30% from entry, exit at 10pp giveback from running peak; hold to EoD if peak never crosses +30%. Recommended exit policy."
        >
          trail30 {formatPct(realizedTrail)}
        </span>
        <span className="ml-auto text-neutral-500">
          {alert.outcomes.enrichedAt ? 'enriched' : 'pending enrich'}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="ml-2 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-400 hover:text-white"
          title={
            expanded
              ? 'Collapse contract + net-flow charts'
              : 'Expand to show contract tape and ticker net-flow charts'
          }
          aria-expanded={expanded}
        >
          {expanded ? '▾ collapse' : '▸ expand'}
        </button>
      </div>

      {expanded && (
        <div className="mt-3 grid gap-3 border-t border-neutral-800 pt-3 md:grid-cols-2">
          {/* CONTRACT TAPE PANEL */}
          <div className="rounded-md border border-neutral-800/80 bg-neutral-950/40 p-2.5">
            <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[10px] font-semibold tracking-[0.08em] text-neutral-500 uppercase">
                  contract
                </span>
                <span className="font-mono text-xs font-semibold text-neutral-100">
                  {alert.underlyingSymbol}
                </span>
                <span className="font-mono text-xs text-neutral-300">
                  {alert.strike}
                </span>
                <span
                  className={`rounded border px-1 py-px text-[10px] leading-none font-bold ${optionTypeBadge(alert.optionType)}`}
                  title={alert.optionType === 'C' ? 'Call' : 'Put'}
                >
                  {alert.optionType}
                </span>
                <span className="text-neutral-600">·</span>
                <span className="font-mono text-xs text-neutral-300">
                  {formatExpiryFull(alert.expiry)}
                </span>
                <span
                  className={`rounded border px-1 py-px font-mono text-[10px] leading-none ${dteChipClass(alert.dte)}`}
                >
                  {alert.dte}D
                </span>
              </div>
              <span className="text-[10px] tracking-wide text-neutral-600 uppercase">
                bid · ask · mid + VWAP
              </span>
            </div>
            {tapeStats != null && tapeStats.total > 0 && (
              <div className="mb-2 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-neutral-400">
                <span>
                  <span className="text-red-300">Bid</span>{' '}
                  <span className="text-neutral-200">
                    {formatVol(tapeStats.bid)}
                  </span>
                </span>
                <span>
                  <span className="text-blue-300">Mid</span>{' '}
                  <span className="text-neutral-200">
                    {formatVol(tapeStats.mid)}
                  </span>
                </span>
                <span>
                  <span className="text-green-300">Ask</span>{' '}
                  <span className="text-neutral-200">
                    {formatVol(tapeStats.ask)}
                  </span>
                </span>
                {tapeStats.avgFill != null && (
                  <span>
                    Avg fill{' '}
                    <span className="text-neutral-200">
                      {formatDollar(tapeStats.avgFill)}
                    </span>
                  </span>
                )}
                <span className="ml-auto text-neutral-500">
                  total {formatVol(tapeStats.total)}
                </span>
              </div>
            )}
            {tape.loading && tape.series.length === 0 ? (
              <div className="text-[10px] text-neutral-500">Loading tape…</div>
            ) : tape.error ? (
              <div className="text-[10px] text-red-300">
                tape error: {tape.error}
              </div>
            ) : (
              <ContractTapeChart
                series={tape.series}
                markerTs={alert.bucketCt}
                ariaLabel={`${alert.optionChainId} per-minute tape`}
              />
            )}
          </div>

          {/* NET FLOW PANEL */}
          <div className="rounded-md border border-neutral-800/80 bg-neutral-950/40 p-2.5">
            <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[10px] font-semibold tracking-[0.08em] text-neutral-500 uppercase">
                  net flow
                </span>
                <span className="font-mono text-xs font-semibold text-neutral-100">
                  {alert.underlyingSymbol}
                </span>
                <span className="text-[10px] text-neutral-500">
                  cumulative · session-to-date
                </span>
              </div>
              <span className="text-[10px] tracking-wide text-neutral-600 uppercase">
                price · NCP · NPP · net vol
              </span>
            </div>
            {flowStats != null && (
              <div className="mb-2 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-neutral-400">
                {tickerCandles.candles.length > 0 && (
                  <span>
                    <span className="text-amber-300">spot</span>{' '}
                    <span className="text-neutral-200">
                      {tickerCandles.candles.at(-1)!.close.toFixed(2)}
                    </span>
                  </span>
                )}
                <span>
                  <span className="text-green-300">NCP</span>{' '}
                  <span className="text-neutral-200">
                    {formatPremium(flowStats.cumNcp)}
                  </span>
                </span>
                <span>
                  <span className="text-red-300">NPP</span>{' '}
                  <span className="text-neutral-200">
                    {formatPremium(flowStats.cumNpp)}
                  </span>
                </span>
                <span>
                  Δ{' '}
                  <span
                    className={
                      flowStats.diff >= 0 ? 'text-green-300' : 'text-red-300'
                    }
                  >
                    {formatPremium(flowStats.diff)}
                  </span>
                </span>
              </div>
            )}
            {netFlow.loading && netFlow.series.length === 0 ? (
              <div className="text-[10px] text-neutral-500">
                Loading net flow…
              </div>
            ) : netFlow.error ? (
              <div className="text-[10px] text-red-300">
                net flow error: {netFlow.error}
              </div>
            ) : (
              <TickerNetFlowChart
                series={netFlow.series}
                candles={tickerCandles.candles}
                previousClose={tickerCandles.previousClose}
                markerTs={alert.bucketCt}
                ariaLabel={`${alert.underlyingSymbol} cumulative net call/put premium with stock price overlay`}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}, areRowsEqual);
