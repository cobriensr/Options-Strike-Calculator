/**
 * StrikeMoverTicker — horizontal scrolling marquee of the biggest
 * 5-minute strike-change winners across all (ticker, category) pairs.
 *
 * Pulls from gexbot_api_capture via the `maxchange-winners` view,
 * extracts the 5-min window per row, and surfaces the top movers
 * sorted by |change| desc. Auto-scrolls via a CSS marquee; pauses
 * on hover so the user can read.
 *
 * Spec: docs/superpowers/specs/gexbot-frontend-2026-05-16.md
 */

import { memo, useMemo } from 'react';

import {
  useGexbotData,
  type MaxchangeWinnerRow,
} from '../../hooks/useGexbotData';

interface StrikeMoverTickerProps {
  marketOpen: boolean;
}

interface MoverChip {
  key: string;
  ticker: string;
  category: string;
  strike: number;
  change: number;
}

const SPEC = { view: 'maxchange-winners' as const };
/** Cap the chips rendered so the marquee stays scannable. */
const MAX_CHIPS = 30;

function formatChange(value: number): string {
  const abs = Math.abs(value);
  const sign = value >= 0 ? '+' : '−';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${abs.toFixed(2)}`;
}

function shortCategory(category: string): string {
  // Strip the `/maxchange` suffix and lowercase the leading prefix
  // (e.g. `gamma_zero/maxchange` → `γ-0DTE`).
  const base = category.replace(/\/maxchange$/, '');
  const map: Record<string, string> = {
    gex_zero: 'GEX-0DTE',
    gex_one: 'GEX-1DTE',
    gex_full: 'GEX-all',
    gamma_zero: 'γ-0DTE',
    gamma_one: 'γ-1DTE',
    delta_zero: 'Δ-0DTE',
    delta_one: 'Δ-1DTE',
    vanna_zero: 'V-0DTE',
    vanna_one: 'V-1DTE',
    charm_zero: 'CH-0DTE',
    charm_one: 'CH-1DTE',
  };
  return map[base] ?? base;
}

function StrikeMoverTickerInner({ marketOpen }: StrikeMoverTickerProps) {
  const { rows, loading, error } = useGexbotData(SPEC, marketOpen);

  const chips = useMemo<MoverChip[]>(() => {
    const collected: MoverChip[] = [];
    for (const row of rows as MaxchangeWinnerRow[]) {
      const five = row.windows.five;
      if (!five) continue;
      const [strike, change] = five;
      collected.push({
        key: `${row.ticker}-${row.category}`,
        ticker: row.ticker,
        category: row.category,
        strike,
        change,
      });
    }
    return collected
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
      .slice(0, MAX_CHIPS);
  }, [rows]);

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="strike-mover-loading"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        Strike Mover Ticker — loading…
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="strike-mover-error"
        className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/80"
      >
        Strike Mover Ticker — {error}
      </div>
    );
  }

  if (chips.length === 0) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="strike-mover-empty"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        Strike Mover Ticker — awaiting first GEXBot tick
      </div>
    );
  }

  return (
    <div
      data-testid="strike-mover"
      className="rounded-md border border-white/5 bg-white/[0.02]"
    >
      <div className="text-tertiary border-b border-white/5 px-3 py-2 text-[10px] uppercase tracking-wide">
        Strike Movers — 5-minute biggest |Δ| across all categories
      </div>
      <div className="flex flex-wrap gap-1.5 px-3 py-2">
        {chips.map((chip) => {
          const positive = chip.change >= 0;
          const cls = positive
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
            : 'border-rose-500/30 bg-rose-500/10 text-rose-200';
          return (
            <span
              key={chip.key}
              data-testid={`strike-mover-chip-${chip.key}`}
              className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[11px] tabular-nums ${cls}`}
              title={`${chip.ticker} ${shortCategory(chip.category)} strike ${chip.strike} change ${chip.change}`}
            >
              <span className="font-semibold">{chip.ticker}</span>
              <span className="opacity-70">{shortCategory(chip.category)}</span>
              <span>{chip.strike}</span>
              <span className="font-mono">{formatChange(chip.change)}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export const StrikeMoverTicker = memo(StrikeMoverTickerInner);
