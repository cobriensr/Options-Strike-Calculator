/**
 * CandleStrip — a compact row of 30-minute SPX candle squares for the 0DTE
 * Gamma Regime panel. Each square is emerald when close > open, red when
 * close < open, and slate for a doji. A vertical divider marks the
 * persistence cutoff (11:00 CT by default) — candles left of it feed the
 * `mostly-red` trigger's green/red count.
 *
 * Pure / presentational: props in, markup out. No data fetching.
 * Empty input renders a graceful placeholder.
 */

import { memo, useMemo } from 'react';

export interface StripCandle {
  ctMin: number;
  open: number;
  close: number;
}

interface CandleStripProps {
  candles: StripCandle[];
  /** CT minute where the persistence window ends (the divider position). */
  persistEndCtMin: number;
}

function squareClass(c: StripCandle): string {
  if (c.close > c.open) return 'bg-emerald-500/80';
  if (c.close < c.open) return 'bg-red-500/80';
  return 'bg-slate-600';
}

function CandleStripImpl({ candles, persistEndCtMin }: CandleStripProps) {
  const sorted = useMemo(
    () => [...candles].sort((a, b) => a.ctMin - b.ctMin),
    [candles],
  );

  if (sorted.length === 0) {
    return (
      <div
        className="flex h-8 items-center justify-center rounded border border-slate-700/60 bg-slate-900/40 text-xs text-slate-500"
        role="img"
        aria-label="30-minute candle strip unavailable — no candles yet"
      >
        no candles
      </div>
    );
  }

  // The divider sits before the first candle whose bucket starts at/after the
  // persistence cutoff. If every candle is before the cutoff, no divider.
  const dividerIndex = sorted.findIndex((c) => c.ctMin >= persistEndCtMin);

  return (
    <div
      className="flex items-center gap-0.5"
      role="img"
      aria-label="30-minute SPX candles. Green is up, red is down, with a divider at the persistence cutoff."
    >
      {sorted.map((c, i) => (
        <span key={c.ctMin} className="flex items-center">
          {i === dividerIndex && i > 0 && (
            <span
              className="mr-0.5 inline-block h-4 w-px bg-amber-400/70"
              aria-hidden="true"
            />
          )}
          <span
            className={`inline-block h-4 w-3 rounded-[1px] ${squareClass(c)}`}
            aria-hidden="true"
          />
        </span>
      ))}
    </div>
  );
}

export const CandleStrip = memo(CandleStripImpl);
