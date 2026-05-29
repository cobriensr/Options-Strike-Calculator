import { memo, useCallback, useMemo, useState } from 'react';
import { useContractTape } from '../../hooks/useContractTape.js';
import { useNetFlowHistory } from '../../hooks/useNetFlowHistory.js';
import { useTickerCandles } from '../../hooks/useTickerCandles.js';
import { SiblingAssetConfirmationBar } from '../Gexbot/SiblingAssetConfirmationBar.js';
import { TakeItScore } from '../TakeItScore/TakeItScore.js';
import { ContractTapeChart } from '../charts/ContractTapeChart.js';
import { TickerNetFlowChart } from '../charts/TickerNetFlowChart.js';
import type {
  ExitPolicy,
  LotteryFire,
  LotteryScoreTier,
  LotteryTickerStats,
} from './types.js';
import { EXIT_POLICY_LABELS, EXIT_POLICY_TOOLTIPS } from './types.js';
import { formatPremiumAmount } from '../../utils/ticker-rollup-aggregates.js';
import {
  deltaFromAtFire,
  flowBadge,
  tideBadge,
} from '../../utils/macro-badges.js';
import { computeFlowMatch } from '../../utils/flow-match.js';
import { computeFlowInverted } from '../../utils/flow-inverted.js';
import { computeExitNow } from '../../utils/exit-now.js';
import { gexbotBadge } from '../../utils/gexbot-badge.js';
import { CohortCountdown } from '../ui/CohortCountdown.js';
import { computeCountdownRemaining } from '../ui/cohort-countdown-utils.js';
import { useNowMinute } from '../../hooks/useNowMinute.js';
import type { TickerNetFlowSnapshot } from '../../hooks/useTickerNetFlowBatch.js';

interface LotteryRowProps {
  fire: LotteryFire;
  /** Which realized exit policy to surface as the primary number. */
  exitPolicy: ExitPolicy;
  /** Whether the parent's date is today (drives polling). */
  marketOpen: boolean;
  /**
   * Live cumulative ticker net flow for this fire's underlying.
   * Optional so existing test fixtures continue to type-check;
   * production sites always pass it. Null before the first poll
   * resolves or when the ticker isn't yet on the WS subscription.
   */
  liveFlowSnapshot?: TickerNetFlowSnapshot | null;
}

/**
 * UW per-contract Contract Lookup deep-link. Verified URL pattern:
 *   https://unusualwhales.com/flow/option_chains?chain=<OCC>
 * The `?chain=` (not `?contract=`) param is the right key — drops
 * the user on UW's full Contract Lookup view (charts, historical
 * volume / OI, RBLX-style stats) pre-loaded with the OCC symbol.
 */
const uwContractUrl = (fire: { optionChainId: string }): string =>
  `https://unusualwhales.com/flow/option_chains?chain=${encodeURIComponent(fire.optionChainId)}`;

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

/**
 * Whole-percent delta with sign-explicit, U+2212 minus for negatives.
 * Used by the RELOAD badge (see reload-deltas spec 2026-05-21). When the
 * rounded magnitude is 0, we emit '0%' with no sign to avoid the visually
 * wrong '−0%' (e.g. -0.4 → '0%', not '−0%').
 */
const formatDeltaWhole = (n: number): string => {
  const rounded = Math.round(Math.abs(n));
  if (rounded === 0) return '0%';
  const sign = n >= 0 ? '+' : '−';
  return `${sign}${rounded}%`;
};

const formatDollar = (n: number): string => {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
};

/**
 * Compact MM/DD form for the row chip (e.g. "5/6"). Strips the year
 * and any zero-padding so the chip stays tight.
 */
const formatExpiryShort = (iso: string): string => {
  const parts = iso.split('-');
  const m = parts[1];
  const d = parts[2];
  if (m == null || d == null) return iso;
  return `${Number.parseInt(m, 10)}/${Number.parseInt(d, 10)}`;
};

/** Full MM/DD/YYYY form for the expand-panel header. */
const formatExpiryFull = (iso: string): string => {
  const parts = iso.split('-');
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (y == null || m == null || d == null) return iso;
  return `${m}/${d}/${y}`;
};

/**
 * DTE chip class — rose for 0DTE (the user's primary trade), amber
 * for 1-3D, neutral for the long tail. Same accent language as the
 * conviction chips so the visual hierarchy is consistent.
 */
const dteChipClass = (dte: number): string => {
  if (dte === 0) return 'border-rose-500/50 bg-rose-950/40 text-rose-200';
  if (dte <= 3) return 'border-amber-500/40 bg-amber-950/30 text-amber-200';
  return 'border-neutral-700 bg-neutral-900 text-neutral-300';
};

/** Compact thousands/millions formatter for volume tallies. */
const formatVol = (n: number): string => {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
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

const todBadge = (tod: string): string => {
  switch (tod) {
    case 'AM_open':
      return 'border-amber-500/40 bg-amber-950/30 text-amber-200';
    case 'MID':
      return 'border-blue-500/40 bg-blue-950/30 text-blue-200';
    case 'LUNCH':
      return 'border-neutral-700 bg-neutral-900 text-neutral-300';
    case 'PM':
      return 'border-purple-500/40 bg-purple-950/30 text-purple-200';
    default:
      return 'border-neutral-700 bg-neutral-900 text-neutral-300';
  }
};

/**
 * Inversion-quality quintile chip palette (Phase 4 — spec
 * lottery-inversion-quality-filter-2026-05-19.md). Lower quintile = worse
 * per-ticker inversion-win rate; Q1/Q2 are the cohort filtered server-side
 * by default. Colour gradient runs red (Q1) → amber (Q2) → neutral (Q3)
 * → emerald (Q4/Q5).
 */
const quintileChipClass = (quintile: number): string => {
  if (quintile === 1) return 'bg-red-900/40 text-red-300';
  if (quintile === 2) return 'bg-amber-900/40 text-amber-300';
  if (quintile === 3) return 'bg-neutral-800 text-neutral-400';
  if (quintile === 4) return 'bg-emerald-900/40 text-emerald-300';
  return 'bg-emerald-800 text-emerald-200';
};

/**
 * Quintile-chip tooltip body. When `inversionBlend` is populated, surface
 * the Wilson 95% LCB as a percentage plus the 21d/90d sample sizes. When
 * it's null (no sample passed the N>=10 floor) we fall back to a quintile-
 * only label so the chip still explains itself.
 */
const quintileChipTooltip = (
  fire: Pick<
    LotteryFire,
    'inversionQuintile' | 'inversionBlend' | 'inversionN21d' | 'inversionN90d'
  >,
): string => {
  if (fire.inversionBlend == null) {
    return `Q${fire.inversionQuintile} ticker — no sample-size data`;
  }
  const pct = (fire.inversionBlend * 100).toFixed(1);
  const n21 = fire.inversionN21d ?? 0;
  const n90 = fire.inversionN90d ?? 0;
  return `Inversion-win rate: ${pct}% (Wilson 95% LCB)\nSample: n=${n21} (21d) / n=${n90} (90d)`;
};

/**
 * Tier badge: fire emojis sized to convey conviction. Tier 1 = 🔥🔥🔥
 * (top ~5/day, ~80% high-peak rate), Tier 2 = 🔥🔥 (the bulk of the
 * day, ~63% high-peak rate), Tier 3 = 🔥 (long tail, ~32%).
 */
const tierBadge = (
  tier: LotteryScoreTier,
  score: number | null,
): { label: string; cls: string; tooltip: string } => {
  if (tier === 'tier1') {
    return {
      label: '🔥🔥🔥',
      cls: 'border-rose-500/50 bg-rose-950/40 text-rose-200',
      tooltip: `Tier 1 (score ${score ?? '?'} ≥ 18): high conviction — ~80% of historical Tier 1 fires hit ≥50% peak return.`,
    };
  }
  if (tier === 'tier2') {
    return {
      label: '🔥🔥',
      cls: 'border-amber-500/40 bg-amber-950/30 text-amber-200',
      tooltip: `Tier 2 (score ${score ?? '?'} = 12-17): solid setup — ~63% of historical Tier 2 fires hit ≥50% peak return.`,
    };
  }
  return {
    label: '🔥',
    cls: 'border-neutral-700 bg-neutral-900 text-neutral-400',
    tooltip: `Tier 3 (score ${score ?? '?'} < 12): low conviction — ~32% of historical Tier 3 fires hit ≥50% peak return.`,
  };
};

/**
 * Reliability indicator: ✓ when CI <10pp (tight enough to trust the
 * point estimate), ⚠️ when CI >15pp (sample too small / variance too
 * high), nothing in the middle band. Hidden when stats are missing.
 */
const ciIndicator = (
  stats: LotteryTickerStats | null,
  ticker: string,
): { label: string; cls: string; tooltip: string } | null => {
  if (stats == null) return null;
  const tooltip = `${ticker}: ${stats.nFires.toLocaleString()} fires, ${stats.highPeakRate.toFixed(1)}% high-peak rate (95% CI ${stats.ciLower.toFixed(1)}–${stats.ciUpper.toFixed(1)}%, width ${stats.ciWidth.toFixed(1)}pp)`;
  if (stats.tier === 'reliable') {
    return {
      label: '✓',
      cls: 'text-green-400',
      tooltip: `${tooltip} — CI ≤10pp, point estimate is trustworthy.`,
    };
  }
  if (stats.tier === 'uncertain') {
    return {
      label: '⚠️',
      cls: 'text-yellow-400',
      tooltip: `${tooltip} — CI >15pp, small sample; treat the point estimate as noisy.`,
    };
  }
  return null;
};

/**
 * Direction-gated pill — Phase 4 (spec:
 * silent-boom-direction-gate-and-trail-ui-2026-05-14.md). Surfaced
 * next to the tier badge when the fire was counter-trend per OTM
 * Market Tide at fire time (T=±150M on mkt_tide_otm_diff). The feed
 * already forces `scoreTier` to 'tier3' on these rows; the pill
 * explains the demote so the user knows it isn't a noisy score but a
 * deliberate macro gate.
 */
const gatedPill = (): { label: string; cls: string; tooltip: string } => ({
  label: 'Gated',
  cls: 'border-amber-500/60 bg-amber-950/40 text-amber-200',
  tooltip:
    'Counter-trend per OTM Market Tide at fire time — demoted to tier3 by the direction gate (T=±150M on mkt_tide_otm_diff). Score is preserved on the row; only the displayed tier is forced down.',
});

/**
 * Flow Match / Flow Mismatch badge — does the ticker's current
 * cumulative net flow agree with this alert's option type? Green when
 * the side that owns the tape (NCP for a call, NPP for a put) is
 * winning; red when the opposite is winning. No badge when the
 * snapshot is missing (cold start) or flat — the row stays clean
 * rather than displaying a meaningless chip.
 */
const flowMatchBadge = (
  optionType: 'C' | 'P',
  liveFlowSnapshot: Pick<TickerNetFlowSnapshot, 'cumNcp' | 'cumNpp'> | null,
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
 * Flow Inverted badge — amber. Fires only when the alert had a flow
 * tailwind at trigger time and that tailwind has since reversed. Per
 * the lottery-net-flow-eda simulation this is the single highest-edge
 * exit signal we surface: when the matched side stops winning, the
 * trade has typically passed its peak. We deliberately do NOT light
 * up Inverted for alerts that fired against the tape — those never
 * had a tailwind, so its reversal isn't actionable.
 */
const flowInvertedBadge = (
  optionType: 'C' | 'P',
  fireTimeCumNcp: number | null,
  fireTimeCumNpp: number | null,
  liveFlowSnapshot: Pick<TickerNetFlowSnapshot, 'cumNcp' | 'cumNpp'> | null,
): { label: string; cls: string; tooltip: string } | null => {
  const state = computeFlowInverted({
    optionType,
    fireTimeCumNcp,
    fireTimeCumNpp,
    currentCumNcp: liveFlowSnapshot?.cumNcp,
    currentCumNpp: liveFlowSnapshot?.cumNpp,
  });
  if (state !== 'inverted') return null;
  return {
    label: 'Flow Inverted ⚠',
    cls: 'border-amber-500/70 bg-amber-950/40 text-amber-200',
    tooltip:
      'Ticker net flow agreed with this alert at fire time but no longer does. Per the lottery-net-flow-eda simulation, this is the strongest documented exit signal — the matched side has stopped winning.',
  };
};

export const LotteryRow = memo(function LotteryRow({
  fire,
  exitPolicy,
  marketOpen,
  liveFlowSnapshot,
}: LotteryRowProps) {
  const realized = fire.outcomes[exitPolicy];
  const peak = fire.outcomes.peakCeilingPct;
  // Fallback for when the selected exit policy returns null (most often
  // realizedFlowInversionPct on late-PM 0DTE fires that don't have ≥5min
  // of post-trigger flow data, or on early/insufficient-window cases).
  // We surface realized_eod_pct as a secondary number so the row isn't
  // just an em-dash — the option still expired or got marked-to-close,
  // and the user wants to know what actually happened.
  const eodFallback = fire.outcomes.realizedEodPct;
  const showEodFallback =
    realized == null &&
    eodFallback != null &&
    exitPolicy !== ('realizedEodPct' as ExitPolicy);
  const tide = tideBadge(fire.macro.mktTideDiff);
  const flow = flowBadge(
    deltaFromAtFire(
      fire.macro.tickerCumNcpAtFire,
      fire.macro.tickerCumNppAtFire,
    ),
  );
  const tier = tierBadge(fire.scoreTier, fire.score);
  const ci = ciIndicator(fire.tickerStats, fire.underlyingSymbol);
  const gated = fire.directionGated ? gatedPill() : null;
  const gexbot = gexbotBadge(fire.gex);
  const flowMatch = flowMatchBadge(fire.optionType, liveFlowSnapshot ?? null);
  const flowInverted = flowInvertedBadge(
    fire.optionType,
    fire.macro.tickerCumNcpAtFire,
    fire.macro.tickerCumNppAtFire,
    liveFlowSnapshot ?? null,
  );
  // EXIT chip composition. Reuse the per-minute clock to derive
  // remainingMin without spawning a second interval per row.
  const nowMs = useNowMinute();
  const remainingMin =
    fire.avgHoldMinutes != null
      ? computeCountdownRemaining(
          fire.triggerTimeCt,
          fire.avgHoldMinutes,
          nowMs,
        )
      : null;
  const exitNow = computeExitNow({
    remainingMin,
    flowInverted: flowInverted != null,
  });

  // Expand state — when true, the per-fire panel renders below the
  // summary lines and the two hooks fetch their data. Collapsed by
  // default so we don't burn network on rows the user hasn't looked at.
  const [expanded, setExpanded] = useState(false);
  /**
   * Cross-panel hover sync: lifted to LotteryRow so both children can
   * read each other's cursor position. The value is a UTC second
   * timestamp (matches lightweight-charts' UTCTimestamp + the bar `ts`
   * second-resolution). `null` when neither chart is being hovered.
   *
   * Owner ergonomics: hovering the CONTRACT bars shows a synced
   * vertical line on the NET FLOW chart at the same minute — and vice
   * versa — so "what was the underlying doing when this contract
   * spiked?" is one glance instead of two.
   */
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  /** Stable identity callback so memoized children don't re-render on every parent tick. */
  const onHoverTimeChange = useCallback((t: number | null) => {
    setHoverTime(t);
  }, []);

  const tape = useContractTape({
    chain: fire.optionChainId,
    date: fire.date,
    enabled: expanded,
    marketOpen,
  });
  // Memo for stable identity — `tapeStats` lists `tapeSeries` as a
  // useMemo dep, so a fresh `[]` per render would force re-computation.
  const tapeSeries = useMemo(() => tape.data?.series ?? [], [tape.data]);
  const netFlow = useNetFlowHistory({
    ticker: fire.underlyingSymbol,
    date: fire.date,
    enabled: expanded,
    marketOpen,
  });
  // Memo for stable identity — `netFlowSeries` is passed to
  // TickerNetFlowChart (a memoized child), so a fresh `[]` per render
  // would defeat its memo. Same pattern as the `candles` memo below.
  const netFlowSeries = useMemo(
    () => netFlow.data?.series ?? [],
    [netFlow.data],
  );
  const tickerCandles = useTickerCandles({
    ticker: fire.underlyingSymbol,
    date: fire.date,
    enabled: expanded,
    marketOpen,
  });
  // Memo so `candles` keeps a stable reference across renders while
  // `tickerCandles.data` is null — `liveSpot` (below) lists it as a
  // useMemo dep, so a fresh `[]` per render would force re-computation.
  const candles = useMemo(
    () => tickerCandles.data?.candles ?? [],
    [tickerCandles.data],
  );
  const previousClose = tickerCandles.data?.previousClose ?? null;

  /**
   * Aggregate side-volume + vol-weighted avg fill across the tape
   * series. Mirrors the totals UW shows above their contract chart
   * (Bid Vol / Mid Vol / Ask Vol / Avg Fill) so the user gets the
   * day's fill mix at a glance without staring at the bars.
   */
  const tapeStats = useMemo(() => {
    if (tapeSeries.length === 0) return null;
    let bid = 0;
    let ask = 0;
    let mid = 0;
    let noSide = 0;
    let priceVolSum = 0;
    let volSum = 0;
    for (const r of tapeSeries) {
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
  }, [tapeSeries]);

  /**
   * Spot at fire time — frozen snapshot, not live. Prefers
   * `spotAtTrigger` (this specific fire) and falls back to
   * `spotAtFirst` for pre-#176 legacy rows. Drives the visible spot
   * field and the %OTM chips (both visible footer and expanded
   * detail), so the moneyness shown is what it was when the alert
   * fired — not what it is right now.
   */
  const fireSpot = useMemo<number | null>(() => {
    if (
      fire.entry.spotAtTrigger != null &&
      Number.isFinite(fire.entry.spotAtTrigger) &&
      fire.entry.spotAtTrigger > 0
    ) {
      return fire.entry.spotAtTrigger;
    }
    if (Number.isFinite(fire.entry.spotAtFirst)) return fire.entry.spotAtFirst;
    return null;
  }, [fire.entry.spotAtTrigger, fire.entry.spotAtFirst]);

  /**
   * Distance-from-spot in percent, signed so the reader can tell ITM
   * vs OTM at a glance. Call OTM: strike > spot → positive. Put OTM:
   * strike < spot → positive. Sign flipped to negative for ITM.
   * Result is null when spot is unavailable.
   */
  const otmPct = useMemo<number | null>(() => {
    if (fireSpot == null || fireSpot <= 0) return null;
    const raw = (fire.strike - fireSpot) / fireSpot;
    return fire.optionType === 'C' ? raw : -raw;
  }, [fireSpot, fire.strike, fire.optionType]);

  /**
   * Total premium $ across the contract tape. Each contract represents
   * 100 shares, so dollars = volume × avg fill × 100. Used in the
   * CONTRACT header as the day's total $ traded on this chain.
   */
  const tapeTotalPremium = useMemo<number | null>(() => {
    if (tapeStats == null || tapeStats.avgFill == null) return null;
    return tapeStats.total * tapeStats.avgFill * 100;
  }, [tapeStats]);

  /**
   * Reload deltas vs the FIRST fire on this chain today.
   * `historicalFires` is oldest → newest and EXCLUDES the latest fire
   * (the row itself), so `[0]` is the first-ever fire of the chain-day.
   * Returns null on the first fire of a chain so downstream rendering
   * can short-circuit. `underlyingDeltaPct` degrades to null when either
   * end of the spot pair is missing (pre-#176 rows).
   * Spec: docs/superpowers/specs/lottery-reload-deltas-2026-05-21.md
   */
  const reloadDelta = useMemo<{
    firstFireTimeCt: string;
    optionDeltaPct: number;
    underlyingDeltaPct: number | null;
  } | null>(() => {
    if (fire.entry.alertSeq <= 1) return null;
    const firstFire = fire.historicalFires?.[0] ?? null;
    if (firstFire == null) return null;
    if (!Number.isFinite(firstFire.entryPrice) || firstFire.entryPrice <= 0) {
      return null;
    }
    const optionDeltaPct =
      ((fire.entry.price - firstFire.entryPrice) / firstFire.entryPrice) * 100;
    const underlyingDeltaPct =
      firstFire.spotAtTrigger != null &&
      firstFire.spotAtTrigger > 0 &&
      fire.entry.spotAtTrigger != null
        ? ((fire.entry.spotAtTrigger - firstFire.spotAtTrigger) /
            firstFire.spotAtTrigger) *
          100
        : null;
    return {
      firstFireTimeCt: firstFire.triggerTimeCt,
      optionDeltaPct,
      underlyingDeltaPct,
    };
  }, [
    fire.entry.alertSeq,
    fire.entry.price,
    fire.entry.spotAtTrigger,
    fire.historicalFires,
  ]);

  /**
   * Display-ready reload-badge derived state — null when suppressed
   * (first fire, no historical fires, option Δ >= 0, or rounded option Δ
   * is 0 — i.e. within ±1% of first fire, no reload opportunity to
   * surface). Tiers:
   *   strict  → green  (fire.tags.reload === true; backend cohort gate)
   *   soft    → amber  (opt ≤ -15%)
   *   neutral → gray   (opt < 0)
   *
   * Important: fire.tags.reload is the backend's validated cohort gate
   * (computed vs IMMEDIATELY PRIOR fire), while optPct is the display
   * delta vs FIRST fire of the day. These can legitimately diverge — a
   * late-day re-fire can pass the backend gate but only be -20% vs
   * first fire. The strict tag always wins regardless of optPct.
   */
  const reloadBadge = useMemo<{
    label: string;
    className: string;
    title: string;
  } | null>(() => {
    if (reloadDelta == null) return null;
    const { optionDeltaPct: optPct, underlyingDeltaPct: spxPct } = reloadDelta;
    if (optPct >= 0) return null;
    // Suppress when rounded magnitude < 1 (within ±1% of first fire —
    // no reload opportunity to surface and the label would read "0%").
    if (Math.round(Math.abs(optPct)) === 0) return null;
    const strict = fire.tags.reload === true;
    const soft = !strict && optPct <= -15;
    const className = strict
      ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-200'
      : soft
        ? 'border-amber-500/40 bg-amber-950/30 text-amber-200'
        : 'border-neutral-600/50 bg-neutral-900/40 text-neutral-300';
    const firstFireCt = formatTimeCT(reloadDelta.firstFireTimeCt);
    const optStr = formatDeltaWhole(optPct);
    const spxStr = spxPct == null ? null : formatDeltaWhole(spxPct);
    const label =
      spxStr == null
        ? `RELOAD opt ${optStr}`
        : `RELOAD opt ${optStr} · spx ${spxStr}`;
    const deltaSentence =
      spxStr == null
        ? `option ${optStr} vs first fire at ${firstFireCt} CT (no underlying spot)`
        : `option ${optStr}, underlying ${spxStr} vs first fire at ${firstFireCt} CT`;
    const title = strict
      ? `RE-LOAD cohort (backend tag): this fire's burst is ≥2× the prior fire AND entry price dropped ≥30% since prior. 9.1% historical lottery rate vs 1.4% non-RE-LOAD. Display delta below is vs first fire today (${firstFireCt} CT), distinct from the backend gate's reference. ${deltaSentence}.`
      : soft
        ? `Soft reload — option is meaningfully cheaper since first fire on this chain today. Display-only; not yet validated as a score input. ${deltaSentence}.`
        : `Cheaper than first fire on this chain — small option-price drop. ${deltaSentence}.`;
    return { label, className, title };
  }, [reloadDelta, fire.tags.reload]);

  const roundTripDeduct = fire.roundTripScoreDeduct ?? 0;
  const isRoundTripped = roundTripDeduct < 0;

  return (
    <div
      data-testid="lottery-row"
      data-round-tripped={isRoundTripped ? 'true' : undefined}
      className={`rounded border p-3 text-sm ${rowContainerClass(fire.optionType)} ${isRoundTripped ? 'opacity-60' : ''}`}
    >
      {isRoundTripped && (
        <div
          data-testid="lottery-row-round-tripped-pill"
          className="mb-1.5 inline-flex items-center gap-1 rounded border border-amber-500/50 bg-amber-950/40 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber-200 uppercase"
          title={`Post-fire flow turned bid-dominated (60-min window). Score deduct ${roundTripDeduct}. EDA: deducted fires had +11.4pp trail-loss rate vs baseline — treat as lower-EV.`}
        >
          round-tripped {roundTripDeduct}
        </div>
      )}
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
        {/* Inversion-quality quintile chip (Phase 4 — spec
            lottery-inversion-quality-filter-2026-05-19.md). Q1=worst /
            Q5=best per-ticker Wilson LCB on flow-inversion-win rate;
            hidden for cold-start tickers (NULL quintile). Tooltip
            surfaces the blended LCB + 21d/90d sample sizes so the user
            can sanity-check small-n cases. The Q1/Q2 cohort is filtered
            out server-side by default; the chip is mostly a Q3-Q5
            ranking surface unless the "Show filtered tickers" toggle is
            on. */}
        {fire.inversionQuintile != null && (
          <span
            data-testid="lottery-quintile-chip"
            className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] leading-none font-medium ${quintileChipClass(fire.inversionQuintile)}`}
            title={quintileChipTooltip(fire)}
            aria-label={quintileChipTooltip(fire)}
          >
            Q{fire.inversionQuintile}
          </span>
        )}
        {/* Phase 4 direction-gate pill — surfaces the demote reason
            so the user can distinguish "low score" from "counter-trend
            macro context flagged it down." Sits right after the tier
            badge so the two read as a unit. */}
        {gated && (
          <span
            data-testid="lottery-gated-pill"
            className={`rounded border px-1.5 py-0.5 text-[10px] leading-none font-semibold ${gated.cls}`}
            title={gated.tooltip}
            aria-label={gated.tooltip}
          >
            {gated.label}
          </span>
        )}
        {/* Per-ticker flow at fire time — frozen snapshot. Sits
            immediately before the live Flow Match badge so the
            fire-time and live per-ticker signals read together. */}
        {flow && (
          <span
            data-testid="lottery-row-flow-chip"
            className={`rounded border px-1.5 py-0.5 text-[10px] leading-none font-semibold ${flow.cls}`}
            title={flow.tooltip}
            aria-label={flow.tooltip}
          >
            {flow.label}
          </span>
        )}
        {/* Flow Match / Mismatch — does the ticker's live cum NCP/NPP
            delta agree with this alert's option type? Green when the
            tape is on the bet's side, red when fighting it. */}
        {flowMatch && (
          <span
            data-testid="lottery-flow-match-badge"
            className={`rounded border px-1.5 py-0.5 text-[10px] leading-none font-semibold ${flowMatch.cls}`}
            title={flowMatch.tooltip}
            aria-label={flowMatch.tooltip}
          >
            {flowMatch.label}
          </span>
        )}
        {/* Flow Inverted — strongest documented exit signal: tailwind
            at fire time has reversed. Amber, eye-catching. */}
        {flowInverted && (
          <span
            data-testid="lottery-flow-inverted-badge"
            className={`rounded border px-1.5 py-0.5 text-[10px] leading-none font-semibold ${flowInverted.cls}`}
            title={flowInverted.tooltip}
            aria-label={flowInverted.tooltip}
          >
            {flowInverted.label}
          </span>
        )}
        {/* Take-It score tile (Phase 4 of takeit-phase3-production-scoring-
            2026-05-16.md). Calibrated XGBoost prob + SHAP top-K flags. Sits
            after the gated pill so it reads as part of the conviction
            cluster. Hides itself when fire.takeitProb is null (rare; means
            the bundle was unreachable at detect time). */}
        <TakeItScore
          prob={fire.takeitProb}
          topFeatures={fire.takeitTopFeatures}
          expanded
        />
        {/* Sibling-asset confirmation bar (gexbot-frontend spec Phase 4).
            Renders cross-asset confirm/contradict pills inline next to
            TakeItScore. Empty when GEXBot data hasn't landed yet. */}
        <SiblingAssetConfirmationBar
          ticker={fire.underlyingSymbol}
          side={fire.optionType === 'C' ? 'call' : 'put'}
          marketOpen={marketOpen}
        />
        {/* GexBot context badge — snapshot of the top probe signals
            (1DTE+ cvroflow + net put DEX + 1DTE+ gexoflow) at fire
            time. Informational only until enough data accumulates for
            the nightly takeit retrain to pick up the new feature
            columns. Spec: docs/superpowers/specs/silent-boom-gexbot-instrumentation-2026-05-26.md. */}
        {gexbot && (
          <span
            data-testid="lottery-gex-badge"
            className={`rounded border px-1.5 py-0.5 text-[10px] leading-none font-semibold ${gexbot.cls}`}
            title={gexbot.tooltip}
            aria-label={gexbot.ariaLabel}
          >
            {gexbot.label}
          </span>
        )}
        {/* Avg-hold-minutes hint — historical P75 minutes-to-peak among
            winners for this (tier, ticker) cohort. Tells the user "if
            this fire is going to work, expect it to peak around this
            many minutes from entry." Sourced from the cohort lookup
            in api/_lib/lottery-hold.ts.

            Note: lottery's tier1 P75 (~219min) is LONGER than tier2's
            (~160min) because tier1 over-indexes on tail-blasters
            (SNDK, RKLB) that hold for hours. The tooltip surfaces this
            so a long tier1 number doesn't read as a typo. */}
        <span
          className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 font-mono text-[10px] leading-none text-neutral-300"
          title={
            fire.scoreTier === 'tier1'
              ? `Cohort avg hold ~${fire.avgHoldMinutes} minutes — historical P75 of minutes-to-peak among winners (peak ≥ 50%) for tier 1 ${fire.underlyingSymbol} fires. Tier 1 winners often run on slow tail moves so this is typically LONGER than tier 2's. Use as a typical exit-window expectation, not a hard rule.`
              : `Cohort avg hold ~${fire.avgHoldMinutes} minutes — historical P75 of minutes-to-peak among winners (peak ≥ 50%) for ${fire.scoreTier} ${fire.underlyingSymbol} fires. Use as a typical exit-window expectation, not a hard rule.`
          }
        >
          ~{fire.avgHoldMinutes}min
        </span>
        {/* Live countdown vs. the cohort P75 hold time. Ticks every
            minute, goes amber at ≤15m and red on expiry. Pairs with
            the static ~Nmin hint above (which shows the cohort's
            full window). */}
        <CohortCountdown
          triggerTimeCt={fire.triggerTimeCt}
          p75MinutesToPeak={fire.avgHoldMinutes}
        />

        {/* Force the ticker onto its own line so the visual hierarchy
            stays consistent regardless of how wide the conviction
            cluster grew (TakeItScore + SHAP pills + sibling bar make
            tier1 rows wider than tier3). Without this the ticker
            sometimes wraps to the right edge of line 1 on tier1 and to
            the left of line 2 on tier3 — same data, different position. */}
        <div className="basis-full" aria-hidden />
        {/* Ticker + strike + side — the whole block links to UW's
            per-contract flow page so the user can pivot from the row
            to the canonical context with one click. */}
        <a
          href={uwContractUrl(fire)}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-baseline gap-2 hover:underline"
          title={`Open ${fire.optionChainId} on Unusual Whales`}
        >
          <span className="font-mono text-base font-semibold text-white group-hover:text-blue-300">
            {fire.underlyingSymbol}
          </span>
          {ci && (
            <span
              className={`text-xs leading-none font-bold ${ci.cls}`}
              title={ci.tooltip}
              aria-label={ci.tooltip}
            >
              {ci.label}
            </span>
          )}
          <span className="font-mono text-base text-neutral-200 group-hover:text-blue-200">
            {fire.strike}
          </span>
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${optionTypeBadge(fire.optionType)}`}
            title={fire.optionType === 'C' ? 'Call' : 'Put'}
          >
            {fire.optionType}
          </span>
          {/* Expiry + DTE — 0DTE highlighted in rose so it's
              scannable at a glance. The user trades 0DTE only, so
              this chip is also a sanity check that the row isn't a
              multi-day contract that slipped past the mode filter. */}
          <span
            className={`rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none ${dteChipClass(fire.dte)}`}
            title={`Expires ${formatExpiryFull(fire.expiry)} — ${
              fire.dte === 0
                ? '0DTE (same day)'
                : `${fire.dte} day${fire.dte === 1 ? '' : 's'} to expiry`
            }`}
          >
            {formatExpiryShort(fire.expiry)} · {fire.dte}D
          </span>
          <span
            className="text-[10px] text-neutral-600 group-hover:text-blue-400"
            aria-hidden
          >
            ↗
          </span>
        </a>

        {/* Time of trigger */}
        <span className="font-mono text-xs text-neutral-400">
          {formatTimeCT(fire.triggerTimeCt)} CT
        </span>

        {/* Alert seq + RE-LOAD + cheap-call-PM badges */}
        <span className="text-[11px] text-neutral-400">
          fire #{fire.entry.alertSeq}
        </span>
        {/* Chain-day cluster: shown only when the API collapsed >1
            fires on this chain (ticker × strike × type × expiry) into a
            single row for `date`. Carries the count + first-fire time
            so the user sees the burst span at a glance. */}
        {fire.fireCount > 1 && (
          <span
            className="rounded border border-orange-500/40 bg-orange-950/30 px-1.5 py-0.5 text-[10px] font-semibold text-orange-200"
            title={`${fire.fireCount} fires on this chain since ${formatTimeCT(fire.firstFireTimeCt)} CT — collapsed to the latest. Hot chains routinely trigger 50-300+ times in a session; this row carries the freshest macro / score / exit-policy.`}
          >
            ×{fire.fireCount} · since {formatTimeCT(fire.firstFireTimeCt)}
          </span>
        )}
        {/* REIGNITED chip — chain matches the daily top-N reignition
            pattern (multi-fire chain that went quiet ≥30 min, then had
            ≥2 post-gap fires). Same row also renders in the pinned
            "Hot Right Now" section above the ticker groups. Phase 3 of
            lottery-reignition-ui-2026-05-17. */}
        {fire.reignited === true && (
          <span
            className="inline-flex items-center gap-1 rounded border border-orange-400/60 bg-orange-900/40 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-orange-100 uppercase"
            title="REIGNITION: chain fired 3+ times, went quiet ≥30 min, then re-ignited with ≥2 post-gap fires. Daily top 5 by post-gap intensity. 70% precision on outlier-peak winners (vs 40% baseline); median realized trail30/10 +18%."
          >
            <span aria-hidden="true">🔥</span>
            REIGNITED
          </span>
        )}
        {/* MEGA-CLUSTER chip — this fire landed in a CT minute where
            ≥12 distinct tickers fired simultaneously. Cross-ticker
            minute concentration is a separate-axis signal; the 5/15
            cluster analysis (docs/tmp/cluster-2026-05-15-1205ct-findings.md)
            measured +16.3% median realized trail on this cohort vs
            +6-7% in the 5-11 middle. */}
        {fire.megaCluster === true && (
          <span
            className="inline-flex items-center gap-1 rounded border border-sky-400/60 bg-sky-900/40 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-sky-100 uppercase"
            title={
              fire.megaClusterSize != null
                ? `MEGA CLUSTER: ${fire.megaClusterSize} distinct tickers fired in this CT minute. Cohort lift: +16.3% median realized trail30/10 vs +6-7% baseline (5/15 cluster analysis on 93-day fires).`
                : 'MEGA CLUSTER: ≥12 distinct tickers fired in this CT minute. +16.3% median realized trail30/10 vs +6-7% baseline.'
            }
          >
            <span aria-hidden="true">🌐</span>
            {fire.megaClusterSize != null
              ? `CLUSTER ×${fire.megaClusterSize}`
              : 'MEGA CLUSTER'}
          </span>
        )}
        {/* DUAL-FLAG chip — chain appears in BOTH lottery_finder_fires
            AND silent_boom_alerts for the same date. Highest-conviction
            cohort in the alert stack: 81% best-fire win rate / 64%
            median best peak (vs 72% / 35% for LF-only). Empirical
            basis: docs/tmp/lf-vs-sb-backtest-findings-2026-05-17.md. */}
        {fire.dualFlag === true && (
          <span
            className="inline-flex items-center gap-1 rounded border border-emerald-400/60 bg-emerald-900/40 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-100 uppercase"
            title="DUAL FLAG: this chain fired on BOTH Lottery Finder AND Silent Boom today. Highest-conviction cohort — 81% win rate on best fire / median best peak 64% (vs 72% / 35% LF-only) on the 25-day backtest. ~39 chain-days/day on average."
          >
            <span aria-hidden="true">⚑⚑</span>
            DUAL FLAG
          </span>
        )}
        {/* HIGH-Γ chip — fire's trigger-window gamma ≥ 0.025 AND
            ticker is NOT in the excluded set (SPY/USO reverse the
            signal in the data). Empirical lift: LF +4.8pp / SB +10.7pp
            on top-decile gamma. Gated by gammaScoreAdjustment so the
            tooltip is in lock-step with the actual +1 bonus folded
            into `score`. */}
        {fire.gammaScoreAdjustment != null && fire.gammaScoreAdjustment > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded border border-violet-400/60 bg-violet-900/40 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-violet-100 uppercase"
            title={
              fire.gammaAtTrigger != null
                ? `HIGH-Γ bonus +1: trigger-window gamma = ${fire.gammaAtTrigger.toFixed(4)} ≥ 0.025 threshold. Empirical lift: +4.8pp (LF) / +10.7pp (SB) on trail30/10 winrate. SPY + USO are excluded because the signal reverses on those tickers.`
                : 'HIGH-Γ bonus +1: gamma at trigger ≥ 0.025 (non-excluded ticker).'
            }
          >
            <span aria-hidden="true">Γ↑</span>
            HIGH-Γ
          </span>
        )}
        {/* "Still hot" indicator — only when market is open and the
            latest fire is within the last 10 minutes. Polling refresh
            (~30s) keeps this honest without per-row timers. */}
        {marketOpen &&
          Date.now() - new Date(fire.triggerTimeCt).getTime() < 10 * 60_000 && (
            <span
              className="inline-flex items-center gap-1 rounded border border-red-500/50 bg-red-950/40 px-1.5 py-0.5 text-[10px] font-semibold text-red-200"
              title="Latest fire on this chain was within the last 10 minutes — chain is still hot."
            >
              <span
                className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-red-400"
                aria-hidden
              />
              hot
            </span>
          )}
        {reloadBadge != null && (
          <span
            data-testid="lottery-row-reload-delta"
            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${reloadBadge.className}`}
            title={reloadBadge.title}
            aria-label={reloadBadge.title}
          >
            {reloadBadge.label}
          </span>
        )}
        {fire.tags.cheapCallPm && (
          <span
            className="rounded border border-fuchsia-500/40 bg-fuchsia-950/30 px-1.5 py-0.5 text-[10px] font-semibold text-fuchsia-200"
            title="Cheap-call-PM: entry < $1, call, PM session. The selection rule from the 15-day backtest — 18.9% lottery rate vs 9.1% RE-LOAD baseline. Caveat: edge concentrated in 1-2 outlier days/15."
          >
            cheap-call-PM
          </span>
        )}

        {/* Time-of-day badge */}
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${todBadge(fire.tags.tod)}`}
          title="Time-of-day bucket — AM_open / MID / LUNCH / PM"
        >
          {fire.tags.tod}
        </span>

        {/* Macro context: only Market Tide today (compact). */}
        {tide && (
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] leading-none font-semibold ${tide.cls}`}
            title={tide.tooltip}
            aria-label={tide.tooltip}
          >
            {tide.label}
          </span>
        )}

        {/* Spacer pushes the realized number to the right */}
        <span className="flex-1" />

        {/* Realized return under the selected policy + peak ceiling */}
        <div className="flex items-baseline gap-3">
          <span
            className={`font-mono text-lg font-bold ${pctClass(realized)}`}
            title={EXIT_POLICY_TOOLTIPS[exitPolicy]}
          >
            {formatPct(realized)}
          </span>
          {/* EOD fallback — only when the selected policy returned null
              and we can show the user what the option actually did at
              session close. The italic + smaller font signals "this
              isn't your selected policy result, it's a fallback so the
              row is informative instead of showing just em-dash". */}
          {showEodFallback && (
            <span
              className={`font-mono text-xs italic ${pctClass(eodFallback)}`}
              title={`Selected policy (${EXIT_POLICY_LABELS[exitPolicy]}) returned no exit for this fire. Showing realized end-of-session return as a fallback so the row remains informative. Most common cause: late-PM trigger leaves <5 min of post-trigger flow data for the inversion algorithm to detect.`}
            >
              {formatPct(eodFallback)}{' '}
              <span className="not-italic opacity-60">eod</span>
            </span>
          )}
          <span
            className="text-[10px] text-neutral-500"
            title="Best-case peak return — % gain at the highest post-entry print. Look-ahead reference, not tradeable."
          >
            peak {formatPct(peak)}
          </span>
        </div>
      </div>

      {/* Second row: entry + flow + trigger */}
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-neutral-400">
        <span>
          entry{' '}
          <span className="font-mono text-neutral-200">
            {formatDollar(fire.entry.price)}
          </span>
        </span>
        <span title="Trigger-window premium: entry price × window contracts × 100">
          prem{' '}
          <span
            className="font-mono text-sky-300"
            data-testid={`lottery-row-premium-${fire.optionChainId}`}
          >
            {formatPremiumAmount(
              fire.entry.price * fire.trigger.windowSize * 100,
            )}
          </span>
        </span>
        <span title="Underlying spot at the moment this fire triggered (frozen snapshot — does not track intraday drift).">
          spot{' '}
          <span className="font-mono text-neutral-300">
            {(fireSpot ?? fire.entry.spotAtFirst).toFixed(2)}
          </span>
        </span>
        {otmPct != null && (
          <span
            data-testid={`lottery-row-otm-pct-${fire.optionChainId}`}
            title={
              otmPct >= 0
                ? `Strike was ${(otmPct * 100).toFixed(1)}% out of the money at fire time.`
                : `Strike was ${(Math.abs(otmPct) * 100).toFixed(1)}% in the money at fire time.`
            }
          >
            %OTM{' '}
            <span
              className={`font-mono ${
                otmPct >= 0 ? 'text-neutral-300' : 'text-amber-300'
              }`}
            >
              {(otmPct * 100).toFixed(1)}%
            </span>
          </span>
        )}
        <span>
          IV{' '}
          <span className="font-mono text-neutral-300">
            {(fire.trigger.iv * 100).toFixed(0)}%
          </span>
        </span>
        <span>
          Δ{' '}
          <span className="font-mono text-neutral-300">
            {fire.trigger.delta.toFixed(2)}
          </span>
        </span>
        <span>
          ask%{' '}
          <span className="font-mono text-neutral-300">
            {(fire.trigger.askPct * 100).toFixed(0)}%
          </span>
        </span>
        <span>
          win-vol/OI{' '}
          <span className="font-mono text-neutral-300">
            {(fire.trigger.volToOiWindow * 100).toFixed(0)}%
          </span>
        </span>
        <span className="text-neutral-500" title={tier.tooltip}>
          predicted peak{' '}
          <span className="font-mono text-neutral-300">
            {fire.forecastHighPeakPct}
          </span>
        </span>
        <span className="ml-auto text-neutral-500">
          {EXIT_POLICY_LABELS[exitPolicy]}
        </span>
        {/* EXIT — pulsing red chip. Composes the cohort countdown +
            flow-inversion signals into a single high-visibility
            indicator that fires when either rule has triggered. Placed
            at the far right so it's the first thing the eye lands on
            when scrolling the list. */}
        {exitNow.active && (
          <span
            data-testid="lottery-exit-now-badge"
            className="ml-2 inline-flex animate-pulse items-center rounded border border-red-500/70 bg-red-950/60 px-1.5 py-0.5 text-[10px] leading-none font-bold tracking-wide text-red-100"
            title={
              exitNow.reason === 'expired'
                ? 'Cohort P75 hold elapsed — historical median peak has passed.'
                : exitNow.reason === 'inverted'
                  ? 'Ticker net flow inverted — strongest documented exit signal.'
                  : 'Hold expired + flow inverted — both exit rules fired.'
            }
            aria-label={`Exit signal active: ${exitNow.reason}`}
          >
            EXIT
          </span>
        )}
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

      {/* Expanded panel — twin UW-style chart panels. Lazy-loaded via
          the hooks' `enabled` gate; collapsed rows do zero network.
          Each panel renders a contract identifier, a side-volume
          stats strip, and the chart, mirroring UW's Contract Lookup
          layout so the user can pivot between this row and UW's
          page without context-switching. */}
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
                  {fire.underlyingSymbol}
                </span>
                <span className="font-mono text-xs text-neutral-300">
                  {fire.strike}
                </span>
                <span
                  className={`rounded border px-1 py-px text-[10px] leading-none font-bold ${optionTypeBadge(fire.optionType)}`}
                  title={fire.optionType === 'C' ? 'Call' : 'Put'}
                >
                  {fire.optionType}
                </span>
                <span className="text-neutral-600">·</span>
                <span className="font-mono text-xs text-neutral-300">
                  {formatExpiryFull(fire.expiry)}
                </span>
                <span
                  className={`rounded border px-1 py-px font-mono text-[10px] leading-none ${dteChipClass(fire.dte)}`}
                >
                  {fire.dte}D
                </span>
              </div>
              <span className="text-[10px] tracking-wide text-neutral-600 uppercase">
                bid · ask · mid + VWAP
              </span>
            </div>
            {/* Side-volume + avg-fill stats strip — UW-style tally.
                Carries OI / Premium / %OTM in the same strip so the
                reader gets the entire "what is this contract worth
                today" snapshot in one row. Colored swatches before
                Bid / Mid / Ask map directly to the bar colors so the
                chart's legend is self-evident. */}
            {tapeStats != null && tapeStats.total > 0 && (
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-neutral-400">
                <span className="inline-flex items-center gap-1">
                  <span
                    aria-hidden
                    className="inline-block h-1.5 w-1.5 rounded-sm bg-red-400"
                  />
                  <span className="text-red-300">Bid</span>{' '}
                  <span className="text-neutral-200">
                    {formatVol(tapeStats.bid)}
                  </span>
                </span>
                <span className="inline-flex items-center gap-1">
                  <span
                    aria-hidden
                    className="inline-block h-1.5 w-1.5 rounded-sm bg-blue-400"
                  />
                  <span className="text-blue-300">Mid</span>{' '}
                  <span className="text-neutral-200">
                    {formatVol(tapeStats.mid)}
                  </span>
                </span>
                <span className="inline-flex items-center gap-1">
                  <span
                    aria-hidden
                    className="inline-block h-1.5 w-1.5 rounded-sm bg-green-400"
                  />
                  <span className="text-green-300">Ask</span>{' '}
                  <span className="text-neutral-200">
                    {formatVol(tapeStats.ask)}
                  </span>
                </span>
                {tapeStats.avgFill != null && (
                  <span title="Volume-weighted avg fill across the session">
                    Avg fill{' '}
                    <span className="text-neutral-200">
                      {formatDollar(tapeStats.avgFill)}
                    </span>
                  </span>
                )}
                <span title="Open interest at fire time">
                  OI{' '}
                  <span className="text-neutral-200">
                    {formatVol(fire.entry.openInterest)}
                  </span>
                </span>
                {tapeTotalPremium != null && (
                  <span title="Total premium traded today = totalVol × avgFill × 100">
                    Prem{' '}
                    <span className="text-neutral-200">
                      {formatPremiumAmount(tapeTotalPremium)}
                    </span>
                  </span>
                )}
                {otmPct != null && (
                  <span
                    title={
                      otmPct >= 0
                        ? `${(otmPct * 100).toFixed(1)}% out of the money`
                        : `${(Math.abs(otmPct) * 100).toFixed(1)}% in the money`
                    }
                  >
                    %OTM{' '}
                    <span
                      className={
                        otmPct >= 0 ? 'text-neutral-200' : 'text-amber-300'
                      }
                    >
                      {(otmPct * 100).toFixed(1)}%
                    </span>
                  </span>
                )}
                <span className="ml-auto text-neutral-500">
                  total {formatVol(tapeStats.total)}
                </span>
              </div>
            )}
            {tape.loading && tapeSeries.length === 0 ? (
              <div className="text-[10px] text-neutral-500">Loading tape…</div>
            ) : tape.error ? (
              <div className="text-[10px] text-red-300">
                tape error: {tape.error}
              </div>
            ) : (
              <ContractTapeChart
                series={tapeSeries}
                markerTs={fire.triggerTimeCt}
                historicalFires={fire.historicalFires}
                syncHoverTime={hoverTime}
                onHoverTime={onHoverTimeChange}
                ariaLabel={`${fire.optionChainId} per-minute tape`}
              />
            )}
          </div>

          {/* NET FLOW PANEL — header (symbol · spot · Vol · NPP · NCP) and
              pane titles are rendered by TickerNetFlowChart itself. */}
          <div className="rounded-md border border-neutral-800/80 bg-neutral-950/40 p-2.5">
            {netFlow.loading && netFlowSeries.length === 0 ? (
              <div className="text-[10px] text-neutral-500">
                Loading net flow…
              </div>
            ) : netFlow.error ? (
              <div className="text-[10px] text-red-300">
                net flow error: {netFlow.error}
              </div>
            ) : (
              <TickerNetFlowChart
                series={netFlowSeries}
                candles={candles}
                previousClose={previousClose}
                markerTs={fire.triggerTimeCt}
                date={fire.date}
                symbol={fire.underlyingSymbol}
                syncHoverTime={hoverTime}
                onHoverTime={onHoverTimeChange}
                ariaLabel={`${fire.underlyingSymbol} cumulative net call/put premium with stock price overlay`}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
});
