import { memo, useMemo, useState } from 'react';
import { useContractTape } from '../../hooks/useContractTape.js';
import { useNetFlowHistory } from '../../hooks/useNetFlowHistory.js';
import { useTickerCandles } from '../../hooks/useTickerCandles.js';
import { ContractTapeChart } from './ContractTapeChart.js';
import { TickerNetFlowChart } from './TickerNetFlowChart.js';
import type {
  ExitPolicy,
  LotteryFire,
  LotteryScoreTier,
  LotteryTickerStats,
} from './types.js';
import { EXIT_POLICY_LABELS, EXIT_POLICY_TOOLTIPS } from './types.js';

interface LotteryRowProps {
  fire: LotteryFire;
  /** Which realized exit policy to surface as the primary number. */
  exitPolicy: ExitPolicy;
  /** Whether the parent's date is today (drives polling). */
  marketOpen: boolean;
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

/** Compact $ formatter for net premium tallies (signed). */
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
    tooltip: `Market Tide NCP - NPP at fire time = ${diff.toFixed(0)}. Display-only; not a selection signal (see spec Appendix A).`,
  };
};

export const LotteryRow = memo(function LotteryRow({
  fire,
  exitPolicy,
  marketOpen,
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
  const tier = tierBadge(fire.scoreTier, fire.score);
  const ci = ciIndicator(fire.tickerStats, fire.underlyingSymbol);

  // Expand state — when true, the per-fire panel renders below the
  // summary lines and the two hooks fetch their data. Collapsed by
  // default so we don't burn network on rows the user hasn't looked at.
  const [expanded, setExpanded] = useState(false);

  const tape = useContractTape({
    chain: fire.optionChainId,
    date: fire.date,
    enabled: expanded,
    marketOpen,
  });
  const netFlow = useNetFlowHistory({
    ticker: fire.underlyingSymbol,
    date: fire.date,
    enabled: expanded,
    marketOpen,
  });
  const tickerCandles = useTickerCandles({
    ticker: fire.underlyingSymbol,
    date: fire.date,
    enabled: expanded,
    marketOpen,
  });

  /**
   * Aggregate side-volume + vol-weighted avg fill across the tape
   * series. Mirrors the totals UW shows above their contract chart
   * (Bid Vol / Mid Vol / Ask Vol / Avg Fill) so the user gets the
   * day's fill mix at a glance without staring at the bars.
   */
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

  /** Latest cumulative NCP / NPP plus signed call-minus-put divergence. */
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
      className={`rounded border p-3 text-sm ${rowContainerClass(fire.optionType)}`}
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
        {fire.tags.reload && (
          <span
            className="rounded border border-amber-500/40 bg-amber-950/30 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200"
            title="RE-LOAD: this fire's burst is ≥2× the prior fire on the same chain AND entry price dropped ≥30% since prior. 9.1% historical lottery rate vs 1.4% non-RE-LOAD."
          >
            RE-LOAD
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
            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${tide.cls}`}
            title={tide.tooltip}
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
        <span>
          spot{' '}
          <span className="font-mono text-neutral-300">
            {fire.entry.spotAtFirst.toFixed(2)}
          </span>
        </span>
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
            {/* Side-volume + avg-fill stats strip — UW-style tally. */}
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
                markerTs={fire.triggerTimeCt}
                ariaLabel={`${fire.optionChainId} per-minute tape`}
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
                  {fire.underlyingSymbol}
                </span>
                <span className="text-[10px] text-neutral-500">
                  cumulative · session-to-date
                </span>
              </div>
              <span className="text-[10px] tracking-wide text-neutral-600 uppercase">
                price · NCP · NPP · net vol
              </span>
            </div>
            {/* Latest cum NCP / NPP / divergence + last spot strip. */}
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
                markerTs={fire.triggerTimeCt}
                ariaLabel={`${fire.underlyingSymbol} cumulative net call/put premium with stock price overlay`}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
});
