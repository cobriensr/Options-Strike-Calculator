/**
 * ConvexityMatrix — 4×4 grid of mini-sparklines, one per ticker,
 * each showing the 60-minute zcvr trend. Answers "is SPX's call-heavy
 * convexity confirmed by QQQ + IWM, or is SPX divergent?" in 3 seconds.
 *
 * Color heat-map (v0 thresholds, recalibrate after first week):
 *   zcvr ≥ 1.2  emerald (call-heavy)
 *   zcvr ≤ 0.8  rose (put-heavy)
 *   else        slate (balanced)
 *
 * Spec: docs/superpowers/specs/gexbot-frontend-2026-05-16.md
 */

import { memo, useMemo } from 'react';

import { useGexbotData, type ConvexityTrendRow } from '../../hooks/useGexbotData';
import { Sparkline } from './Sparkline';

interface ConvexityMatrixProps {
  marketOpen: boolean;
}

interface CellData {
  ticker: string;
  values: number[];
  latest: number | null;
  tone: 'call' | 'put' | 'neutral';
}

const SPEC = { view: 'convexity-trend' as const };
const TICKER_ORDER = [
  // Indexes
  'SPX',
  'ES_SPX',
  'NDX',
  'NQ_NDX',
  'RUT',
  'VIX',
  // ETFs
  'SPY',
  'QQQ',
  'IWM',
  'TLT',
  'GLD',
  'USO',
  'TQQQ',
  'UVXY',
  'HYG',
  'SLV',
] as const;

function classifyTone(latest: number | null): CellData['tone'] {
  if (latest == null) return 'neutral';
  if (latest >= 1.2) return 'call';
  if (latest <= 0.8) return 'put';
  return 'neutral';
}

function toneStyles(tone: CellData['tone']): {
  border: string;
  bg: string;
  text: string;
  stroke: string;
} {
  if (tone === 'call') {
    return {
      border: 'border-emerald-500/30',
      bg: 'bg-emerald-500/5',
      text: 'text-emerald-300',
      stroke: 'text-emerald-300',
    };
  }
  if (tone === 'put') {
    return {
      border: 'border-rose-500/30',
      bg: 'bg-rose-500/5',
      text: 'text-rose-300',
      stroke: 'text-rose-300',
    };
  }
  return {
    border: 'border-white/10',
    bg: 'bg-white/[0.02]',
    text: 'text-secondary',
    stroke: 'text-tertiary',
  };
}

function ConvexityMatrixInner({ marketOpen }: ConvexityMatrixProps) {
  const { rows, loading, error } = useGexbotData(SPEC, marketOpen);

  const cells = useMemo<CellData[]>(() => {
    const byTicker = new Map(
      rows.map((r: ConvexityTrendRow) => [r.ticker, r] as const),
    );
    return TICKER_ORDER.map((ticker) => {
      const row = byTicker.get(ticker);
      const values = row?.series.map(([, v]) => v) ?? [];
      const latest = values.at(-1) ?? null;
      return { ticker, values, latest, tone: classifyTone(latest) };
    });
  }, [rows]);

  const hasAnyData = cells.some((c) => c.values.length > 0);

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="convexity-matrix-loading"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        Convexity Matrix — loading…
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="convexity-matrix-error"
        className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/80"
      >
        Convexity Matrix — {error}
      </div>
    );
  }

  if (!hasAnyData) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="convexity-matrix-empty"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        Convexity Matrix — awaiting first GEXBot tick
      </div>
    );
  }

  return (
    <div
      data-testid="convexity-matrix"
      className="rounded-md border border-white/5 bg-white/[0.02]"
    >
      <div className="text-tertiary border-b border-white/5 px-3 py-2 text-[10px] uppercase tracking-wide">
        Cross-Asset Convexity (0DTE zcvr, 60-min trend) — green = call-heavy,
        red = put-heavy
      </div>
      <div className="grid grid-cols-4 gap-2 p-2">
        {cells.map((cell) => {
          const styles = toneStyles(cell.tone);
          return (
            <div
              key={cell.ticker}
              data-testid={`convexity-cell-${cell.ticker}`}
              className={`flex flex-col rounded-sm border ${styles.border} ${styles.bg} px-2 py-1.5`}
            >
              <div className="flex items-baseline justify-between">
                <span className={`text-[11px] font-semibold ${styles.text}`}>
                  {cell.ticker}
                </span>
                <span className="text-tertiary text-[10px] tabular-nums">
                  {cell.latest != null ? cell.latest.toFixed(2) : '—'}
                </span>
              </div>
              <div className={styles.stroke}>
                <Sparkline values={cell.values} width={80} height={20} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const ConvexityMatrix = memo(ConvexityMatrixInner);
