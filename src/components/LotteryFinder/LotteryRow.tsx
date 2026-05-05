import { memo, useState } from 'react';
import { useContractTape } from '../../hooks/useContractTape.js';
import { useNetFlowHistory } from '../../hooks/useNetFlowHistory.js';
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

  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 p-3 text-sm">
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
        <span
          className="text-neutral-500"
          title={tier.tooltip}
        >
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

      {/* Expanded panel — twin charts. Lazy-loaded via the hooks'
          `enabled` gate; collapsed rows do zero network. */}
      {expanded && (
        <div className="mt-3 grid gap-3 border-t border-neutral-800 pt-3 md:grid-cols-2">
          <div>
            <div className="mb-1 flex items-baseline justify-between text-[10px] tracking-wide text-neutral-500 uppercase">
              <span>Contract Tape</span>
              <span className="text-neutral-600">
                bid · ask · mid stack + VWAP
              </span>
            </div>
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
          <div>
            <div className="mb-1 flex items-baseline justify-between text-[10px] tracking-wide text-neutral-500 uppercase">
              <span>{fire.underlyingSymbol} Net Flow</span>
              <span className="text-neutral-600">
                cum NCP (green) · cum NPP (red)
              </span>
            </div>
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
                markerTs={fire.triggerTimeCt}
                ariaLabel={`${fire.underlyingSymbol} cumulative net call/put premium`}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
});
