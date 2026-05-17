/**
 * ArchiveStats — summary card above the Archive tab. Computes:
 *   - Win rate: % of closed rows where the trade direction was correct
 *     (long: closed_price > entry_price; short: closed_price < entry_price).
 *   - Average hold days: closed_at - created_at, mean over closed rows.
 *   - Total PnL: sum across rows of (per-contract delta × quantity × 100).
 *
 * Expired rows without `closed_price` are excluded from win rate and PnL
 * but counted in hold-days (`closed_at` defaults to NULL on auto-expiry
 * in this codebase, so they're effectively skipped — see helpers).
 */

import { memo, useMemo } from 'react';

import { computeClosedPnl } from './helpers.js';
import type { TrackerContract } from './types.js';

interface Props {
  contracts: TrackerContract[];
}

interface Stats {
  total: number;
  withOutcome: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  avgHoldDays: number | null;
  totalPnlDollars: number;
}

function computeStats(contracts: TrackerContract[]): Stats {
  let wins = 0;
  let losses = 0;
  let withOutcome = 0;
  let holdDaysSum = 0;
  let holdDaysCount = 0;
  let pnl = 0;

  for (const c of contracts) {
    const { deltaDollar, deltaPct } = computeClosedPnl(c);
    if (deltaDollar != null && deltaPct != null) {
      withOutcome += 1;
      if (deltaPct > 0) wins += 1;
      else if (deltaPct < 0) losses += 1;
      // 1 options contract == 100 underlying shares
      pnl += deltaDollar * c.quantity * 100;
    }
    if (c.closed_at) {
      const created = new Date(c.created_at).getTime();
      const closed = new Date(c.closed_at).getTime();
      if (
        Number.isFinite(created) &&
        Number.isFinite(closed) &&
        closed > created
      ) {
        holdDaysSum += (closed - created) / 86_400_000;
        holdDaysCount += 1;
      }
    }
  }
  return {
    total: contracts.length,
    withOutcome,
    wins,
    losses,
    winRatePct: withOutcome > 0 ? (wins / withOutcome) * 100 : null,
    avgHoldDays: holdDaysCount > 0 ? holdDaysSum / holdDaysCount : null,
    totalPnlDollars: pnl,
  };
}

function formatPnl(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  return `${sign}$${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export const ArchiveStats = memo(function ArchiveStats({ contracts }: Props) {
  const stats = useMemo(() => computeStats(contracts), [contracts]);

  return (
    <div className="bg-surface-alt border-edge mb-4 grid grid-cols-2 gap-3 rounded-lg border p-3 sm:grid-cols-4">
      <Stat
        label="Closed"
        value={String(stats.total)}
        hint={`${String(stats.withOutcome)} with outcome`}
      />
      <Stat
        label="Win rate"
        value={
          stats.winRatePct != null ? `${stats.winRatePct.toFixed(0)}%` : '—'
        }
        hint={`${String(stats.wins)}W / ${String(stats.losses)}L`}
      />
      <Stat
        label="Avg hold"
        value={
          stats.avgHoldDays != null ? `${stats.avgHoldDays.toFixed(1)}d` : '—'
        }
      />
      <Stat
        label="Total PnL"
        value={formatPnl(stats.totalPnlDollars)}
        accent={
          stats.totalPnlDollars > 0
            ? 'success'
            : stats.totalPnlDollars < 0
              ? 'danger'
              : 'neutral'
        }
      />
    </div>
  );
});

interface StatProps {
  label: string;
  value: string;
  hint?: string;
  accent?: 'success' | 'danger' | 'neutral';
}

function Stat({ label, value, hint, accent = 'neutral' }: StatProps) {
  const color =
    accent === 'success'
      ? 'text-success'
      : accent === 'danger'
        ? 'text-danger'
        : 'text-primary';
  return (
    <div>
      <div className="text-tertiary font-sans text-[10px] font-semibold uppercase">
        {label}
      </div>
      <div className={'font-mono text-base font-bold ' + color}>{value}</div>
      {hint && (
        <div className="text-tertiary mt-0.5 font-mono text-[10px]">{hint}</div>
      )}
    </div>
  );
}
