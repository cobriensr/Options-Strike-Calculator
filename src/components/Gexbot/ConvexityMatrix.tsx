/**
 * ConvexityMatrix — 4×4 grid of mini-sparklines, one per ticker,
 * each showing the 60-minute trend of GEXBot net convexity (zcvr).
 *
 * zcvr = taker long GEX − taker short GEX: a signed amount centred on 0
 * that measures option buying against option selling. It is NOT a
 * call/put ratio around 1.
 *   zcvr > 0  net option buying   (emerald)
 *   zcvr < 0  net option selling  (rose)
 *   zcvr = 0  neutral
 *
 * Shade is scaled per ticker: |latest| over the ticker's own peak |zcvr|
 * in the 60-minute window the sparkline shows. SPX moves in the
 * thousands and the ETFs in the tens, so a shared scale would paint
 * everything but SPX neutral. Three bands (faint / medium / strong at
 * <1/3, <2/3, ≥2/3 of the peak) keep the classes static for Tailwind.
 * Caveat: a ticker's own peak is the reference, so a ticker sitting at
 * its window high always reads "strong" — compare the sign across
 * tickers, and the number within a ticker.
 *
 * Spec: docs/superpowers/specs/gexbot-frontend-2026-05-16.md
 */

import { memo, useMemo } from 'react';

import {
  useGexbotData,
  type ConvexityTrendRow,
} from '../../hooks/useGexbotData';
import { Sparkline } from './Sparkline';
import { GEXBOT_TICKER_ORDER } from './ticker-order';
import { formatDte } from './types';

interface ConvexityMatrixProps {
  marketOpen: boolean;
}

type Tone = 'buying' | 'selling' | 'neutral';
type Intensity = 'faint' | 'medium' | 'strong';

interface CellData {
  ticker: string;
  minDte: number | null;
  values: number[];
  latest: number | null;
  tone: Tone;
  intensity: Intensity;
}

const SPEC = { view: 'convexity-trend' as const };

/** Band edges as a fraction of the ticker's own peak |zcvr|. */
const INTENSITY_MEDIUM_FROM = 1 / 3;
const INTENSITY_STRONG_FROM = 2 / 3;

function classifyTone(latest: number | null): Tone {
  if (latest == null || latest === 0) return 'neutral';
  return latest > 0 ? 'buying' : 'selling';
}

function classifyIntensity(values: number[], latest: number | null): Intensity {
  if (latest == null) return 'faint';
  const peak = values.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  if (peak === 0) return 'faint';
  const ratio = Math.abs(latest) / peak;
  if (ratio >= INTENSITY_STRONG_FROM) return 'strong';
  if (ratio >= INTENSITY_MEDIUM_FROM) return 'medium';
  return 'faint';
}

// Static class strings (Tailwind scans source), one set per tone × band.
const BUYING_BG: Record<Intensity, string> = {
  faint: 'bg-emerald-500/5',
  medium: 'bg-emerald-500/10',
  strong: 'bg-emerald-500/20',
};
const SELLING_BG: Record<Intensity, string> = {
  faint: 'bg-rose-500/5',
  medium: 'bg-rose-500/10',
  strong: 'bg-rose-500/20',
};

function toneStyles(
  tone: Tone,
  intensity: Intensity,
): { border: string; bg: string; text: string; stroke: string } {
  if (tone === 'buying') {
    return {
      border: 'border-emerald-500/30',
      bg: BUYING_BG[intensity],
      text: 'text-emerald-300',
      stroke: 'text-emerald-300',
    };
  }
  if (tone === 'selling') {
    return {
      border: 'border-rose-500/30',
      bg: SELLING_BG[intensity],
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

/** Signed, compact: +1.35, −1,310, +500. */
function formatZcvr(value: number): string {
  if (value === 0) return '0';
  const digits = Math.abs(value) >= 10 ? 0 : 2;
  const body = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${value > 0 ? '+' : '−'}${body}`;
}

function cellTitle(cell: CellData): string {
  const head = `${cell.ticker} net convexity (zcvr)`;
  if (cell.latest == null) return `${head}: no data`;
  const read =
    cell.tone === 'buying'
      ? 'net option buying'
      : cell.tone === 'selling'
        ? 'net option selling'
        : 'neutral';
  return `${head}: ${read} (${formatZcvr(cell.latest)}), ${formatDte(cell.minDte)}`;
}

function ConvexityMatrixInner({ marketOpen }: ConvexityMatrixProps) {
  const { rows, loading, error } = useGexbotData(SPEC, marketOpen);

  const cells = useMemo<CellData[]>(() => {
    const byTicker = new Map(
      rows.map((r: ConvexityTrendRow) => [r.ticker, r] as const),
    );
    return GEXBOT_TICKER_ORDER.map((ticker) => {
      const row = byTicker.get(ticker);
      const values = row?.series.map(([, v]) => v) ?? [];
      const latest = values.at(-1) ?? null;
      return {
        ticker,
        minDte: row?.minDte ?? null,
        values,
        latest,
        tone: classifyTone(latest),
        intensity: classifyIntensity(values, latest),
      };
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
      <div className="text-tertiary border-b border-white/5 px-3 py-2 text-[10px] tracking-wide uppercase">
        Cross-Asset net convexity (zcvr), 60-min trend — green = net option
        buying, red = net option selling; shade is relative to each
        ticker&apos;s own 60-min peak
      </div>
      <div className="grid grid-cols-4 gap-2 p-2">
        {cells.map((cell) => {
          const styles = toneStyles(cell.tone, cell.intensity);
          return (
            <div
              key={cell.ticker}
              data-testid={`convexity-cell-${cell.ticker}`}
              data-intensity={cell.intensity}
              title={cellTitle(cell)}
              className={`flex flex-col rounded-sm border ${styles.border} ${styles.bg} px-2 py-1.5`}
            >
              <div className="flex items-baseline justify-between">
                <span className={`text-[11px] font-semibold ${styles.text}`}>
                  {cell.ticker}{' '}
                  <span
                    data-testid={`convexity-dte-${cell.ticker}`}
                    className="text-tertiary text-[9px] font-normal"
                  >
                    {cell.latest != null ? formatDte(cell.minDte) : ''}
                  </span>
                </span>
                <span className="text-tertiary text-[10px] tabular-nums">
                  {cell.latest != null ? formatZcvr(cell.latest) : '—'}
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
