/**
 * Shared formatting and display helpers for position table rows.
 */

import type { Spread } from './types';

// ── Table cell class constants ───────────────────────────────

export const TD_CLASS = 'px-3 py-2 text-right font-mono text-sm';
export const TD_LEFT = 'px-3 py-2 text-left font-mono text-sm';

// ── Formatting ───────────────────────────────────────────────

export function formatCurrency(value: number): string {
  if (value < 0) {
    return `($${Math.abs(value).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })})`;
  }
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatPct(value: number | null): string {
  if (value === null) return '\u2014';
  return `${value.toFixed(1)}%`;
}

export function formatTime(time: string | null): string {
  if (!time) return '\u2014';
  return time;
}

export function pnlColor(value: number | null): string {
  if (value === null) return 'text-muted';
  if (value > 0) return 'text-success';
  if (value < 0) return 'text-danger';
  return 'text-primary';
}

export function spreadStrikeLabel(s: Spread): string {
  const short = s.shortLeg.strike;
  const long = s.longLeg.strike;
  return `${short}/${long}`;
}

export function spreadTypeLabel(s: Spread): string {
  return s.spreadType === 'PUT_CREDIT_SPREAD' ? 'PCS' : 'CCS';
}

/** Cushion: distance from spot to short strike as % of spot */
export function cushionPct(s: Spread, spot: number): number | null {
  if (spot <= 0) return null;
  return s.distanceToShortStrikePct ?? null;
}
