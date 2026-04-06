/**
 * FuturesGrid — Compact responsive grid showing all 7 futures
 * symbols with price, 1H change, day change, and volume ratio.
 *
 * ES card includes an ES-SPX basis annotation when available.
 */

import { memo } from 'react';
import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import type { FuturesSnapshot } from '../../hooks/useFuturesData';

/** Human-readable labels for futures symbols */
const SYMBOL_LABELS: Record<string, string> = {
  ES: '/ES',
  NQ: '/NQ',
  VX1: '/VX F',
  VX2: '/VX B',
  ZN: '/ZN',
  RTY: '/RTY',
  CL: '/CL',
};

const SYMBOL_NAMES: Record<string, string> = {
  ES: 'S&P 500',
  NQ: 'Nasdaq 100',
  VX1: 'VIX Front',
  VX2: 'VIX Back',
  ZN: '10Y Treasury',
  RTY: 'Russell 2000',
  CL: 'Crude Oil',
};

interface FuturesGridProps {
  readonly snapshots: FuturesSnapshot[];
  readonly esSpxBasis: number | null;
}

function formatChange(pct: number | null): string {
  if (pct == null) return '—';
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

function changeColor(pct: number | null): string {
  if (pct == null) return theme.textMuted;
  if (pct > 0) return theme.green;
  if (pct < 0) return theme.red;
  return theme.textMuted;
}

function volumeLabel(
  ratio: number | null,
): { text: string; color: string } | null {
  if (ratio == null) return null;
  if (ratio >= 2) return { text: 'HEAVY', color: theme.red };
  if (ratio >= 1.5) return { text: 'ELEVATED', color: theme.caution };
  return { text: 'NORMAL', color: theme.textMuted };
}

function formatPrice(symbol: string, price: number): string {
  // ZN trades in 32nds but snapshot stores decimal
  if (symbol === 'ZN') return price.toFixed(3);
  if (symbol === 'CL') return price.toFixed(2);
  if (symbol.startsWith('VX')) return price.toFixed(2);
  return price.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const FuturesGrid = memo(function FuturesGrid({
  snapshots,
  esSpxBasis,
}: FuturesGridProps) {
  if (snapshots.length === 0) return null;

  return (
    <div
      className="grid grid-cols-2 gap-2.5 md:grid-cols-4"
      role="list"
      aria-label="Futures prices"
    >
      {snapshots.map((s) => {
        const vol = volumeLabel(s.volumeRatio);
        const label = SYMBOL_LABELS[s.symbol] ?? `/${s.symbol}`;
        const name = SYMBOL_NAMES[s.symbol] ?? s.symbol;

        return (
          <div
            key={s.symbol}
            role="listitem"
            className="border-edge rounded-lg border p-2.5"
            style={{
              backgroundColor: tint(theme.surfaceAlt, '80'),
            }}
          >
            {/* Symbol header */}
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="font-sans text-[11px] font-bold tracking-wide">
                <span className="text-accent" aria-label={`${label} ${name}`}>
                  {label}
                </span>
              </span>
              {vol && s.volumeRatio != null && (
                <span
                  className="rounded-full px-1.5 py-px font-sans text-[9px] font-bold"
                  style={{
                    backgroundColor: tint(vol.color, '18'),
                    color: vol.color,
                  }}
                  title={`Volume: ${s.volumeRatio.toFixed(1)}x 20-day avg`}
                >
                  {s.volumeRatio.toFixed(1)}x
                </span>
              )}
            </div>

            {/* Price */}
            <div className="text-primary mb-1 font-mono text-[14px] leading-tight font-semibold">
              {formatPrice(s.symbol, s.price)}
            </div>

            {/* Changes row */}
            <div className="flex items-center gap-2">
              <span
                className="font-mono text-[11px] font-medium"
                style={{ color: changeColor(s.change1hPct) }}
                title="1-hour change"
              >
                1H {formatChange(s.change1hPct)}
              </span>
              <span
                className="font-mono text-[11px] font-medium"
                style={{ color: changeColor(s.changeDayPct) }}
                title="Day change"
              >
                D {formatChange(s.changeDayPct)}
              </span>
            </div>

            {/* Subtext */}
            <div className="text-muted mt-0.5 font-sans text-[9px]">{name}</div>

            {/* ES-SPX basis annotation */}
            {s.symbol === 'ES' && esSpxBasis != null && (
              <div
                className="mt-1.5 rounded px-1.5 py-0.5 font-mono text-[10px]"
                style={{
                  backgroundColor: tint(theme.accent, '10'),
                  color: theme.accent,
                }}
                title="ES - SPX fair value basis"
              >
                Basis: {esSpxBasis >= 0 ? '+' : ''}
                {esSpxBasis.toFixed(2)} pts
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

export default FuturesGrid;
