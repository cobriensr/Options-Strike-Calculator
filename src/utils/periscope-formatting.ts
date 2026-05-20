/**
 * Pure formatting helpers shared across the Periscope panel sections.
 *
 * These were inlined inside PeriscopePanel.tsx until the Phase 3A
 * decomposition (2026-05-19). They're string/color formatters with no
 * React dependencies, so they live in src/utils/ and can be unit tested
 * in isolation.
 */

import { theme } from '../themes/index.js';
import type { TradePlan, Verdict } from './periscope-trade-plan.js';

/** Format a signed number with M/K suffix and a leading +/− sign. */
export function fmtSigned(n: number): string {
  if (Math.abs(n) >= 1_000_000)
    return `${n >= 0 ? '+' : ''}${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000)
    return `${n >= 0 ? '+' : ''}${(n / 1_000).toFixed(1)}K`;
  return `${n >= 0 ? '+' : ''}${n.toFixed(0)}`;
}

/** Format a "points from spot" value as a signed integer string. */
export function fmtPts(pts: number): string {
  const sign = pts >= 0 ? '+' : '';
  return `${sign}${pts.toFixed(0)}`;
}

/** Theme-aware sign coloring used by ranked-cell values + tally rows. */
export function colorForValue(v: number): string {
  if (v > 0) return theme.green;
  if (v < 0) return theme.red;
  return theme.textSecondary;
}

/** Describe straddle-cone asymmetry direction in plain English. */
export function asymmetryLabel(pts: number): string {
  if (pts > 0) return 'lower-skewed (downside priced richer)';
  if (pts < 0) return 'upper-skewed (upside priced richer)';
  return 'symmetric';
}

/** Trade-plan verdict → theme color (safe=green, conditional=caution,
 *  avoid=red). */
export function verdictColor(v: Verdict): string {
  if (v === 'safe') return theme.green;
  if (v === 'conditional') return theme.caution;
  return theme.red;
}

/** Trade-plan regime → theme color used for the inline chip on the
 *  TradePlan section header. */
export function regimeColor(regime: TradePlan['regime']): string {
  if (regime === 'cone-breach-up') return theme.green;
  if (regime === 'cone-breach-down') return theme.red;
  if (regime === 'pin') return theme.accent;
  if (regime === 'drift-and-cap') return theme.text;
  return theme.textMuted;
}

/** Render a TradePlan level (trigger / stop / target) as an integer
 *  string, with em-dash for null. */
export function fmtLevel(n: number | null): string {
  if (n == null) return '—';
  return n.toFixed(0);
}
