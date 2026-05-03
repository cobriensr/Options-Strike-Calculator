/**
 * Cell — single-ticker rendering for the Dealer Regime Tile.
 *
 * Layout (top → bottom):
 *   ticker                — bold, mono
 *   state badge           — color-coded, screen-reader-labeled
 *   net γ at spot         — signed, abbreviated magnitude (e.g. "+3.6B")
 *   spot · zero-gamma     — secondary line showing the underlying levels
 *   confidence            — small print, helps the trader judge the read
 *
 * When `row` is null the cell renders an inert placeholder using the
 * `uncertain` palette so the tile keeps a stable column count even when
 * a ticker has no data yet (e.g. fresh deploy + cron hasn't run).
 */

import { memo } from 'react';
import type { DealerRegimeRow } from '../../hooks/useDealerRegime';
import type { DealerRegimeState } from './classify';

interface CellProps {
  ticker: 'SPX' | 'NDX' | 'SPY' | 'QQQ';
  row: DealerRegimeRow | null;
  state: DealerRegimeState;
}

const STATE_CLASSES: Record<DealerRegimeState, string> = {
  'long-γ': 'bg-sky-400/15 text-sky-300 border-sky-400/40',
  'short-γ': 'bg-amber-400/15 text-amber-300 border-amber-400/40',
  transition:
    'bg-zinc-400/10 text-zinc-300 border-dashed border-zinc-400/30',
  uncertain: 'bg-zinc-700/30 text-zinc-500 border-zinc-700/40',
};

const STATE_ARIA: Record<DealerRegimeState, string> = {
  'long-γ': 'Dealers long gamma — dampening regime',
  'short-γ': 'Dealers short gamma — amplifying regime',
  transition: 'Spot near zero-gamma — regime in transition',
  uncertain: 'Insufficient data to classify regime',
};

/**
 * Format a signed dollar number to a compact abbreviation:
 *   3_500_000_000 → "+3.5B"
 *   −2_400_000_000 → "−2.4B"
 *   1_200_000 → "+1.2M"
 *   null → "—"
 */
function fmtSignedAbbrev(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  let scaled: number;
  let suffix: string;
  if (abs >= 1e9) {
    scaled = value / 1e9;
    suffix = 'B';
  } else if (abs >= 1e6) {
    scaled = value / 1e6;
    suffix = 'M';
  } else if (abs >= 1e3) {
    scaled = value / 1e3;
    suffix = 'K';
  } else {
    scaled = value;
    suffix = '';
  }
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  // Drop the inherent '-' from toFixed since we're emitting our own
  // sign character (uses the typographic minus for negatives).
  const magnitude = Math.abs(scaled).toFixed(1);
  return `${sign}${magnitude}${suffix}`;
}

function fmtPrice(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(2);
}

function fmtConfidence(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(2);
}

function CellInner({ ticker, row, state }: CellProps) {
  return (
    <div
      className="border-edge bg-surface flex flex-col gap-1 rounded-md border p-2"
      data-testid={`dealer-regime-cell-${ticker}`}
    >
      <div className="text-primary font-mono text-[12px] font-semibold">
        {ticker}
      </div>
      <div
        className={`inline-block w-fit rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${STATE_CLASSES[state]}`}
        role="status"
        aria-label={`${ticker}: ${STATE_ARIA[state]}`}
      >
        {state}
      </div>
      <div className="text-primary font-mono text-[11px]">
        net γ {fmtSignedAbbrev(row?.netGammaAtSpot ?? null)}
      </div>
      <div className="text-secondary font-mono text-[10px]">
        spot {fmtPrice(row?.spot ?? null)} · zg{' '}
        {fmtPrice(row?.zeroGamma ?? null)}
      </div>
      <div className="text-secondary font-mono text-[10px]">
        conf {fmtConfidence(row?.confidence ?? null)}
      </div>
    </div>
  );
}

export const Cell = memo(CellInner);
