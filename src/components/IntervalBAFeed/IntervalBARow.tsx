/**
 * IntervalBARow — single row in the IntervalBAFeed table.
 *
 * Renders the dominant ask-side print details + a click-through to UW's
 * per-contract page. Severity drives a left-edge color stripe matching
 * the live banner's tinting (extreme = red pulse-class, critical =
 * red mute, warning = caution).
 */

import type { IntervalBAFeedAlert } from '../../hooks/useIntervalBAFeed';

interface IntervalBARowProps {
  alert: IntervalBAFeedAlert;
}

const uwContractUrl = (chain: string): string =>
  `https://unusualwhales.com/flow/option_chains?chain=${encodeURIComponent(chain)}`;

const formatTimeCT = (iso: string): string =>
  new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'America/Chicago',
  });

const formatPremium = (n: number): string => {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1000)}K`;
  return `$${n.toFixed(0)}`;
};

const formatStrike = (n: number): string =>
  Number.isInteger(n) ? n.toString() : n.toFixed(0);

const SEVERITY_STYLES: Record<
  IntervalBAFeedAlert['severity'],
  { stripe: string; badge: string; label: string; tooltip: string }
> = {
  extreme: {
    stripe: 'border-l-rose-400',
    badge: 'bg-rose-500/20 text-rose-200 border border-rose-500/40',
    label: 'EXTREME',
    tooltip:
      'EXTREME — bucket total premium ≥ $1M. The highest tier; an aggregate this large in a 5-min ask-side bucket is structurally rare for SPX/SPXW/SPY/QQQ.',
  },
  critical: {
    stripe: 'border-l-orange-400',
    badge: 'bg-orange-500/20 text-orange-200 border border-orange-500/40',
    label: 'CRITICAL',
    tooltip:
      'CRITICAL — bucket total premium $500K–$1M. Above the noise floor; meaningful concentration of ask-side buying.',
  },
  warning: {
    stripe: 'border-l-amber-400',
    badge: 'bg-amber-500/20 text-amber-200 border border-amber-500/40',
    label: 'WARNING',
    tooltip:
      'WARNING — bucket total premium $250K–$500K. Cleared the $250K floor + ≥75% ask ratio, but smaller-tier conviction than CRITICAL/EXTREME.',
  },
};

export function IntervalBARow({ alert }: Readonly<IntervalBARowProps>) {
  const sev = SEVERITY_STYLES[alert.severity];
  const isCall = alert.option_type === 'C';
  const sideBadge = isCall
    ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/40'
    : 'bg-rose-500/20 text-rose-200 border border-rose-500/40';
  const flags: string[] = [];
  if (alert.top_trade_is_sweep) flags.push('sweep');
  if (alert.top_trade_is_floor) flags.push('floor');

  return (
    <div
      className={`flex items-center gap-3 rounded-md border border-l-4 border-neutral-800 bg-neutral-950/40 px-3 py-2 font-mono text-xs ${sev.stripe}`}
    >
      {/* Time CT */}
      <span className="text-neutral-400">{formatTimeCT(alert.fired_at)}</span>

      {/* Severity pill */}
      <span
        title={sev.tooltip}
        className={`cursor-help rounded px-1.5 py-0.5 font-sans text-[9px] font-bold ${sev.badge}`}
      >
        {sev.label}
      </span>

      {/* Contract — ticker + strike + type pill */}
      <span className="flex items-center gap-1.5">
        <span className="font-sans text-[10px] font-semibold text-neutral-300">
          {alert.ticker}
        </span>
        <span className="text-neutral-100">{formatStrike(alert.strike)}</span>
        <span
          title={
            isCall
              ? 'CALL — ask-side buyers paid up for upside calls. Bullish directional bet.'
              : 'PUT — ask-side buyers paid up for downside puts. Bearish directional bet.'
          }
          className={`cursor-help rounded px-1.5 py-0.5 font-sans text-[10px] font-bold ${sideBadge}`}
        >
          {isCall ? 'CALL' : 'PUT'}
        </span>
      </span>

      {/* Confluence partners pill — only render when populated. Sorted
          for deterministic display; the server sorts but be defensive. */}
      {alert.confluence_tickers.length > 0 && (
        <span
          title={`Cross-symbol confluence — ${alert.confluence_tickers.join(' + ')} fired same-direction within ~90s of this alert. CALL hit-rate lifts from 53% solo to 61% with at least one partner (per 2026-05-12 backfill analysis).`}
          className="cursor-help inline-flex items-center gap-0.5 rounded border border-sky-500/40 bg-sky-500/15 px-1.5 py-0.5 font-sans text-[10px] font-bold text-sky-200"
        >
          {[...alert.confluence_tickers]
            .sort()
            .map((t) => `+${t}`)
            .join(' ')}
        </span>
      )}

      {/* Ratio */}
      <span
        title="Ask-side premium ÷ total bucket premium. ≥75% is the structural-anomaly threshold for SPX/SPY/QQQ — informed-flow conviction signature."
        className="ml-auto flex cursor-help flex-col items-end"
      >
        <span className="text-neutral-100">{alert.ratio_pct.toFixed(0)}%</span>
        <span className="text-[10px] text-neutral-500">ratio</span>
      </span>

      {/* Total premium */}
      <span className="flex flex-col items-end">
        <span className="text-neutral-100">
          {formatPremium(alert.total_premium)}
        </span>
        <span className="text-[10px] text-neutral-500">
          {alert.trade_count} {alert.trade_count === 1 ? 'trade' : 'trades'}
        </span>
      </span>

      {/* Top trade */}
      {alert.top_trade_premium != null && (
        <span className="flex flex-col items-end">
          <span className="text-neutral-100">
            {formatPremium(alert.top_trade_premium)}
          </span>
          <span className="text-[10px] text-neutral-500">
            top{flags.length > 0 ? ` · ${flags.join(' ')}` : ''}
          </span>
        </span>
      )}

      {/* Underlying spot */}
      {alert.underlying_price != null && (
        <span className="flex flex-col items-end text-neutral-400">
          <span>{alert.underlying_price.toFixed(0)}</span>
          <span className="text-[10px] text-neutral-500">spx</span>
        </span>
      )}

      {/* UW contract link */}
      <a
        href={uwContractUrl(alert.option_chain)}
        target="_blank"
        rel="noopener noreferrer"
        title="Open on Unusual Whales"
        className="rounded p-1 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white"
        aria-label={`Open ${alert.option_chain} on Unusual Whales`}
      >
        ↗
      </a>
    </div>
  );
}
