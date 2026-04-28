/**
 * TickerCard — one ticker's zero-gamma state.
 *
 * Header line: ticker name and last-updated timestamp.
 * Big numbers: spot price, zero-gamma level (or — if no flip).
 * Distance line: ΔSpot − ZG in points and percent, with regime label.
 * Sparkline: spot vs ZG over the most recent N snapshots.
 *
 * Confidence is shown as a thin opacity-modulated badge. Low confidence
 * doesn't hide the level (per the no-gating decision) — it just dims it.
 */

import { memo } from 'react';
import type { ZeroGammaRow } from '../../hooks/useZeroGamma';
import { Sparkline } from './Sparkline';

interface TickerCardProps {
  ticker: string;
  latest: ZeroGammaRow | null;
  history: ZeroGammaRow[];
  loading: boolean;
  error: string | null;
}

interface RegimeInfo {
  label: 'SUPPRESSION' | 'ACCELERATION' | 'KNIFE EDGE' | 'NO FLIP';
  /** Tailwind text-color token. */
  colorClass: string;
}

const KNIFE_EDGE_PCT = 0.003; // ±0.3% of spot

function classifyRegime(spot: number, zeroGamma: number | null): RegimeInfo {
  if (zeroGamma == null) {
    return { label: 'NO FLIP', colorClass: 'text-secondary' };
  }
  const distancePct = Math.abs(spot - zeroGamma) / spot;
  if (distancePct <= KNIFE_EDGE_PCT) {
    return { label: 'KNIFE EDGE', colorClass: 'text-amber-400' };
  }
  if (spot > zeroGamma) {
    return { label: 'SUPPRESSION', colorClass: 'text-emerald-400' };
  }
  return { label: 'ACCELERATION', colorClass: 'text-rose-400' };
}

function fmtNumber(n: number, digits: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Chicago',
  });
}

function TickerCardInner({
  ticker,
  latest,
  history,
  loading,
  error,
}: TickerCardProps) {
  if (error) {
    return (
      <div
        className="border-edge bg-surface rounded-md border p-3"
        role="alert"
      >
        <div className="text-primary font-sans text-sm font-semibold">
          {ticker}
        </div>
        <div className="text-secondary mt-2 font-sans text-xs">
          Failed to load: {error}
        </div>
      </div>
    );
  }

  if (loading && latest == null) {
    return (
      <div className="border-edge bg-surface rounded-md border p-3">
        <div className="text-primary font-sans text-sm font-semibold">
          {ticker}
        </div>
        <div className="text-secondary mt-2 font-sans text-xs">Loading…</div>
      </div>
    );
  }

  if (latest == null) {
    return (
      <div className="border-edge bg-surface rounded-md border p-3">
        <div className="text-primary font-sans text-sm font-semibold">
          {ticker}
        </div>
        <div className="text-secondary mt-2 font-sans text-xs">No data yet</div>
      </div>
    );
  }

  const { spot, zeroGamma, confidence } = latest;
  const regime = classifyRegime(spot, zeroGamma);
  const priceDigits = 2;

  const distance =
    zeroGamma == null
      ? null
      : { pts: spot - zeroGamma, pct: ((spot - zeroGamma) / spot) * 100 };

  // Sort history ascending by ts so the sparkline reads left → right
  // (the API returns DESC).
  const sortedHistory = [...history].sort((a, b) => a.ts.localeCompare(b.ts));

  return (
    <div className="border-edge bg-surface flex flex-col gap-2 rounded-md border p-3">
      <header className="flex items-baseline justify-between">
        <span className="text-primary font-sans text-sm font-semibold">
          {ticker}
        </span>
        <span className="text-secondary font-mono text-[10px]">
          {fmtTime(latest.ts)}
        </span>
      </header>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-secondary font-sans text-[10px] tracking-wide uppercase">
            Spot
          </div>
          <div className="text-primary font-mono text-base">
            {fmtNumber(spot, priceDigits)}
          </div>
        </div>
        <div>
          <div className="text-secondary font-sans text-[10px] tracking-wide uppercase">
            Zero Gamma
          </div>
          <div
            className="text-primary font-mono text-base"
            style={
              confidence != null && confidence < 0.5
                ? { opacity: 0.55 }
                : undefined
            }
          >
            {zeroGamma == null ? '—' : fmtNumber(zeroGamma, priceDigits)}
          </div>
        </div>
      </div>

      <div className="flex items-baseline justify-between">
        <span
          className={`font-sans text-xs font-semibold ${regime.colorClass}`}
        >
          {regime.label}
        </span>
        <span className="text-secondary font-mono text-[11px]">
          {distance == null
            ? '—'
            : `${distance.pts >= 0 ? '+' : ''}${fmtNumber(distance.pts, priceDigits)} (${distance.pct >= 0 ? '+' : ''}${distance.pct.toFixed(2)}%)`}
        </span>
      </div>

      <Sparkline history={sortedHistory} priceDigits={priceDigits} />
    </div>
  );
}

export const TickerCard = memo(TickerCardInner);
