/**
 * extreme-detector — pure utility that scans intraday $TICK bars for
 * threshold-crossing events and labels them with regime-aware context.
 *
 * Why this exists
 * ---------------
 * A TICK print at +650 means something very different on a range day
 * (likely a fade candidate) versus a trend day (confirming continuation).
 * This module pairs the raw threshold detection from `classifyTickBand`
 * with the session regime to produce actionable labels.
 *
 * Pure module — no React, no fetch, no side effects.
 */

import {
  MARKET_INTERNALS_THRESHOLDS,
  PINNED_THRESHOLD_MINUTES,
} from '../constants/market-internals.js';
import type {
  ExtremeEvent,
  InternalBandState,
  InternalBar,
  RegimeType,
} from '../types/market-internals.js';
import { classifyTickBand } from './market-regime.js';

// ============================================================
// MAIN
// ============================================================

/**
 * Detect extreme $TICK events and label them contextually based on the
 * current session regime.
 *
 * - Filters to $TICK bars only (extreme events are TICK-specific in
 *   Phase 2).
 * - For each bar where |close| >= elevated (400), creates an
 *   `ExtremeEvent` with a regime-aware label.
 * - Marks events as `pinned` when part of a consecutive streak of
 *   bars above the extreme threshold (600) lasting at least
 *   `PINNED_THRESHOLD_MINUTES` bars.
 *
 * Returns events sorted by timestamp ascending (oldest first).
 */
export function detectExtremes(
  bars: InternalBar[],
  regime?: RegimeType,
): ExtremeEvent[] {
  if (bars.length === 0) return [];

  const tickBars = bars.filter((b) => b.symbol === '$TICK');
  if (tickBars.length === 0) return [];

  const elevatedThreshold = MARKET_INTERNALS_THRESHOLDS.tick.elevated;
  const extremeThreshold = MARKET_INTERNALS_THRESHOLDS.tick.extreme;

  // Sort by timestamp ascending so streak detection is chronological.
  const sorted = [...tickBars].sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime(),
  );

  // ------------------------------------------------------------------
  // Pre-compute consecutive-extreme streaks for pinned detection.
  // A bar is "extreme-level" when |close| >= 600 (the extreme threshold).
  // We walk left-to-right and compute the streak length ending at each
  // index.
  // ------------------------------------------------------------------
  const streakLengths: number[] = new Array<number>(sorted.length).fill(0);
  for (let i = 0; i < sorted.length; i++) {
    const bar = sorted[i];
    if (!bar) continue;
    const isExtreme = Math.abs(bar.close) >= extremeThreshold;
    if (isExtreme) {
      streakLengths[i] = i > 0 ? (streakLengths[i - 1] ?? 0) + 1 : 1;
    }
  }

  // Propagate streak length backward so every member of a streak of
  // length N sees the full streak length (not just their running count).
  // Walk right-to-left: if i is the end of a streak, propagate its
  // length to all earlier members.
  const fullStreakLengths: number[] = [...streakLengths];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const current = fullStreakLengths[i] ?? 0;
    if (current === 0) continue;
    const next = fullStreakLengths[i + 1] ?? 0;
    if (i + 1 < sorted.length && next > current) {
      fullStreakLengths[i] = next;
    }
  }

  // ------------------------------------------------------------------
  // Build events for bars above the elevated threshold.
  // ------------------------------------------------------------------
  const events: ExtremeEvent[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const bar = sorted[i];
    if (!bar) continue;
    const mag = Math.abs(bar.close);
    if (mag < elevatedThreshold) continue;

    const band = classifyTickBand(bar.close);
    // We only reach here for |close| >= elevated, so band is never
    // 'neutral'. The type assertion is safe.
    if (band === 'neutral') continue;
    const label = buildLabel(band, regime);
    const streakLen = fullStreakLengths[i] ?? 0;
    const pinned =
      streakLen >= PINNED_THRESHOLD_MINUTES && mag >= extremeThreshold;

    events.push({
      ts: bar.ts,
      symbol: '$TICK',
      value: bar.close,
      band,
      label,
      pinned,
    });
  }

  return events;
}

// ============================================================
// LABEL BUILDER
// ============================================================

function buildLabel(
  band: Exclude<InternalBandState, 'neutral'>,
  regime?: RegimeType,
): string {
  if (band === 'blowoff') return 'Blowoff — pay attention';

  if (regime === 'range' && (band === 'elevated' || band === 'extreme')) {
    return 'FADE candidate';
  }
  if (regime === 'trend' && (band === 'elevated' || band === 'extreme')) {
    return 'Confirming trend';
  }

  // Neutral or no regime — just report the band name.
  return band;
}
