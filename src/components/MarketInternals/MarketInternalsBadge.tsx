/**
 * MarketInternalsBadge — compact horizontal strip of NYSE market internals.
 *
 * Shows the 4 session internals ($TICK, $ADD, $VOLD, $TRIN) with the
 * latest close for each. $TICK gets a threshold-based color band
 * (neutral -> elevated -> extreme -> blowoff) because absolute TICK prints
 * at +/-400 / +/-600 / +/-1000 are the classic reversal vs. trend-day tells.
 * The other three symbols render raw; slope-based classification is used
 * by the regime classifier in `src/utils/market-regime.ts` but the badge
 * still shows raw values.
 *
 * Presentation only — the parent panel owns the `useMarketInternals` hook
 * and passes data down as props to avoid duplicate polling.
 */

import type { FC } from 'react';
import { INTERNAL_SYMBOLS } from '../../constants/market-internals';
import type {
  InternalBandState,
  InternalBar,
  InternalSymbol,
} from '../../types/market-internals';
import { classifyTickBand } from '../../utils/market-regime';

// ============================================================
// PRESENTATION HELPERS
// ============================================================

function bandClass(band: InternalBandState): string {
  switch (band) {
    case 'blowoff':
      return 'text-red-300 bg-red-900/60 border-red-500/50';
    case 'extreme':
      return 'text-orange-300 bg-orange-900/50 border-orange-500/40';
    case 'elevated':
      return 'text-amber-300 bg-amber-900/40 border-amber-500/40';
    case 'neutral':
      return 'text-neutral-300 bg-neutral-800/60 border-neutral-600/40';
  }
}

// ============================================================
// FORMATTERS
// ============================================================

const COMPACT_FMT = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const SIGNED_INT_FMT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
  signDisplay: 'exceptZero',
});

const RATIO_FMT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

function formatValue(symbol: InternalSymbol, close: number): string {
  if (!Number.isFinite(close)) return '\u2014';
  switch (symbol) {
    case '$TICK':
      return SIGNED_INT_FMT.format(Math.round(close));
    case '$ADD':
      // Advance-decline line — signed int, can run into the thousands.
      return SIGNED_INT_FMT.format(Math.round(close));
    case '$VOLD':
      // Up-volume minus down-volume; hundreds of millions common.
      return COMPACT_FMT.format(close);
    case '$TRIN':
      // Arms index — small ratio around 1.0 (0.5 bullish, 2.0 bearish).
      return RATIO_FMT.format(close);
  }
}

// ============================================================
// CELL
// ============================================================

interface CellProps {
  symbol: InternalSymbol;
  bar: InternalBar | null;
  stale: boolean;
}

const Cell: FC<CellProps> = ({ symbol, bar, stale }) => {
  const hasValue = bar !== null;
  const isTick = symbol === '$TICK';
  const band: InternalBandState =
    isTick && hasValue ? classifyTickBand(bar.close) : 'neutral';
  const coloredCell = isTick && hasValue;

  const valueText = hasValue ? formatValue(symbol, bar.close) : '\u2014';

  const cellClass = [
    'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px]',
    coloredCell
      ? bandClass(band)
      : 'text-neutral-200 bg-neutral-800/40 border-neutral-700/40',
    stale ? 'opacity-60' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cellClass}
      data-testid={`market-internal-${symbol.replace('$', '').toLowerCase()}`}
      data-band={coloredCell ? band : undefined}
    >
      <span className="text-muted text-[10px] font-semibold tracking-wider">
        {symbol}
      </span>
      <span className="font-semibold tabular-nums">{valueText}</span>
    </div>
  );
};

// ============================================================
// MAIN
// ============================================================

export interface MarketInternalsBadgeProps {
  latestBySymbol: Record<InternalSymbol, InternalBar | null>;
  loading: boolean;
  error: string | null;
  asOf: string | null;
  marketOpen: boolean;
  className?: string;
}

export const MarketInternalsBadge: FC<MarketInternalsBadgeProps> = ({
  latestBySymbol,
  loading,
  error,
  asOf,
  marketOpen,
  className,
}) => {
  const hasAnyBar = INTERNAL_SYMBOLS.some((s) => latestBySymbol[s] !== null);
  // Errors don't clear bars — if we have stale data, keep showing it.
  const showError = error !== null && !hasAnyBar;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Market internals"
      className={['flex flex-wrap items-center gap-2', className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      {showError && (
        <span
          className="font-mono text-[11px] text-rose-400"
          title={error ?? undefined}
          data-testid="market-internals-error"
        >
          Internals unavailable
        </span>
      )}

      {!showError && loading && !hasAnyBar && (
        <>
          {INTERNAL_SYMBOLS.map((sym) => (
            <Cell key={sym} symbol={sym} bar={null} stale={!marketOpen} />
          ))}
        </>
      )}

      {!showError && (!loading || hasAnyBar) && (
        <>
          {INTERNAL_SYMBOLS.map((sym) => (
            <Cell
              key={sym}
              symbol={sym}
              bar={latestBySymbol[sym]}
              stale={!marketOpen && hasAnyBar}
            />
          ))}
          {!marketOpen && hasAnyBar && (
            <span className="text-muted font-sans text-[10px] italic">
              after hours
            </span>
          )}
          {asOf && (
            <span className="sr-only" data-testid="market-internals-asof">
              Last updated {asOf}
            </span>
          )}
        </>
      )}
    </div>
  );
};
