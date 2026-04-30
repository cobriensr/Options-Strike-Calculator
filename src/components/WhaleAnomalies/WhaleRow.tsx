import { memo } from 'react';
import type { WhaleAnomaly } from './types.js';
import { WHALE_TYPE_LABELS, WHALE_TYPE_DESCRIPTIONS } from './types.js';

interface WhaleRowProps {
  whale: WhaleAnomaly;
}

const formatPremium = (n: number): string => {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
};

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
  return `${(n * 100).toFixed(2)}%`;
};

const directionClasses = (direction: 'bullish' | 'bearish'): string =>
  direction === 'bullish'
    ? 'border-green-500/40 bg-green-950/30 text-green-200'
    : 'border-red-500/40 bg-red-950/30 text-red-200';

const sideClasses = (side: 'ASK' | 'BID'): string =>
  side === 'ASK'
    ? 'bg-amber-950/40 text-amber-200 border-amber-500/40'
    : 'bg-cyan-950/40 text-cyan-200 border-cyan-500/40';

export const WhaleRow = memo(function WhaleRow({ whale }: WhaleRowProps) {
  const cp = whale.option_type === 'call' ? 'C' : 'P';
  const dirIcon = whale.direction === 'bullish' ? '▲' : '▼';

  const resolutionLabel = (() => {
    if (whale.resolved_at == null) return 'pending';
    if (whale.hit_target === true) return 'hit';
    if (whale.hit_target === false) return 'miss';
    return 'pending';
  })();

  const resolutionClasses = (() => {
    if (resolutionLabel === 'hit')
      return 'bg-green-950/40 text-green-200 border-green-500/40';
    if (resolutionLabel === 'miss')
      return 'bg-red-950/40 text-red-200 border-red-500/40';
    return 'bg-neutral-900/60 text-neutral-400 border-neutral-700';
  })();

  return (
    <div
      className={`rounded-lg border p-3 transition ${directionClasses(whale.direction)}`}
      data-testid={`whale-row-${whale.id}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <a
          href={`https://unusualwhales.com/option-chain/${encodeURIComponent(whale.option_chain)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono font-semibold text-white hover:underline"
          data-testid="whale-row-contract-link"
        >
          {whale.ticker} {whale.strike.toFixed(0)}
          {cp}
        </a>

        <span className="text-neutral-400">
          {dirIcon} Type {whale.whale_type} —{' '}
          {WHALE_TYPE_LABELS[whale.whale_type]}
        </span>

        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${sideClasses(whale.side)}`}
          title={`Ask side ${formatPct(whale.ask_pct)}`}
        >
          {whale.side}
        </span>

        {whale.pairing_status === 'sequential' && (
          <span
            className="rounded border border-yellow-500/40 bg-yellow-950/40 px-1.5 py-0.5 text-[10px] font-semibold text-yellow-200"
            title="Position roll detected — opposite-side leg traded sequentially (not synthetic)"
          >
            ROLL
          </span>
        )}

        {whale.source === 'eod_backfill' && (
          <span
            className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-400"
            title="Loaded from end-of-day archive — historical record, not live"
          >
            EOD
          </span>
        )}

        <span className="ml-auto font-mono text-xs text-neutral-300">
          {formatTimeCT(whale.first_ts)} CT
        </span>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4">
        <div>
          <span className="text-neutral-500">Premium: </span>
          <span className="font-mono text-white">
            {formatPremium(whale.total_premium)}
          </span>
        </div>
        <div>
          <span className="text-neutral-500">Trades: </span>
          <span className="font-mono text-white">{whale.trade_count}</span>
        </div>
        <div>
          <span className="text-neutral-500">Vol/OI: </span>
          <span className="font-mono text-white">
            {whale.vol_oi_ratio != null
              ? `${whale.vol_oi_ratio.toFixed(1)}×`
              : '—'}
          </span>
        </div>
        <div>
          <span className="text-neutral-500">DTE: </span>
          <span className="font-mono text-white">{whale.dte}d</span>
        </div>
        <div>
          <span className="text-neutral-500">Spot @ print: </span>
          <span className="font-mono text-white">
            {whale.underlying_price != null
              ? whale.underlying_price.toFixed(2)
              : '—'}
          </span>
        </div>
        <div>
          <span className="text-neutral-500">Moneyness: </span>
          <span className="font-mono text-white">
            {formatPct(whale.moneyness)}
          </span>
        </div>
        <div>
          <span className="text-neutral-500">Expiry: </span>
          <span className="font-mono text-white">{whale.expiry}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-neutral-500">Result: </span>
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase ${resolutionClasses}`}
          >
            {resolutionLabel}
          </span>
          {whale.pct_to_target != null && (
            <span className="font-mono text-[10px] text-neutral-300">
              {(whale.pct_to_target * 100).toFixed(2)}%
            </span>
          )}
        </div>
      </div>

      <div
        className="mt-1 text-[10px] italic text-neutral-500"
        title={WHALE_TYPE_DESCRIPTIONS[whale.whale_type]}
      >
        {WHALE_TYPE_DESCRIPTIONS[whale.whale_type]}
      </div>
    </div>
  );
});
