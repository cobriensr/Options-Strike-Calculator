/**
 * candle-momentum — pure utility that computes momentum, streak, and
 * acceleration signals from 1-minute SPX candles.
 *
 * Why this exists
 * ---------------
 * The GEX target cron writes snapshots every 5 minutes. By the time the
 * client polls and the user reads the delta-% columns, a fast directional
 * move may already be 6+ minutes old. This module computes momentum
 * signals client-side from the 1-minute candles the hook already
 * has — cutting effective latency to the poll interval (~60s).
 *
 * Pure module — no React, no fetch, no side effects.
 */

import type { SPXCandle } from '../hooks/useGexTarget';

// ── Signal classification ────────────────────────────────────────────────

export type MomentumSignal =
  | 'surge-up'
  | 'drift-up'
  | 'flat'
  | 'drift-down'
  | 'surge-down';

// ── Thresholds (named constants for easy tuning) ─────────────────────────

/** Minimum |streak| to qualify as a surge (with range expansion). */
const SURGE_STREAK = 3;

/** Minimum |streak| to qualify as a drift. */
const DRIFT_STREAK = 2;

/**
 * Range expansion ratio — current window avg range must exceed the
 * previous window avg range by this factor to count as "expanding."
 * 1.2 = 20% wider ranges.
 */
const RANGE_EXPANSION_RATIO = 1.2;

/** Number of candles in each window for range comparison. */
const RANGE_WINDOW = 5;

/**
 * Minimum 3-candle ROC (points) to classify as drifting when streak
 * alone is insufficient. Catches slow grinds.
 */
const DRIFT_ROC_THRESHOLD = 2;

// ── Output type ──────────────────────────────────────────────────────────

export interface CandleMomentum {
  /** 1-candle rate of change (close[-1] - close[-2]), points. */
  roc1: number;
  /** 3-candle rate of change (close[-1] - close[-4]), points. */
  roc3: number;
  /** 5-candle rate of change (close[-1] - close[-6]), points. */
  roc5: number;

  /**
   * Consecutive same-direction candles counting backward from the latest.
   * Positive = green streak (close > open), negative = red streak.
   * A doji (close === open) breaks the streak.
   */
  streak: number;

  /** Average bar range (high - low) of the most recent RANGE_WINDOW candles. */
  avgRange: number;
  /** Average bar range (high - low) of the RANGE_WINDOW candles before that. */
  avgRangePrev: number;
  /** True when avgRange > avgRangePrev * RANGE_EXPANSION_RATIO. */
  rangeExpanding: boolean;

  /**
   * Second derivative — difference between the current 1-candle ROC and
   * the previous 1-candle ROC. Positive = accelerating upward (or
   * decelerating downward). Negative = accelerating downward.
   */
  acceleration: number;

  /** Classified momentum state. */
  signal: MomentumSignal;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function safeClose(candles: SPXCandle[], fromEnd: number): number {
  const c = candles.at(-(fromEnd + 1));
  return c?.close ?? candles.at(-1)?.close ?? 0;
}

function candleRange(c: SPXCandle): number {
  return c.high - c.low;
}

function avgRangeForWindow(
  candles: SPXCandle[],
  endOffset: number,
  windowSize: number,
): number {
  const startIdx = candles.length - endOffset - windowSize;
  const endIdx = candles.length - endOffset;
  if (startIdx < 0 || endIdx <= 0) return 0;

  let sum = 0;
  let count = 0;
  for (let i = Math.max(0, startIdx); i < endIdx; i++) {
    const c = candles[i];
    if (c) {
      sum += candleRange(c);
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Count consecutive same-direction candles from the end.
 * A green candle has close > open; red has close < open.
 * Doji (close === open) breaks the streak.
 */
function computeStreak(candles: SPXCandle[]): number {
  if (candles.length === 0) return 0;

  const latest = candles.at(-1)!;
  const latestDir = Math.sign(latest.close - latest.open);
  if (latestDir === 0) return 0;

  let count = 1;
  for (let i = candles.length - 2; i >= 0; i--) {
    const c = candles[i];
    if (!c) break;
    const dir = Math.sign(c.close - c.open);
    if (dir !== latestDir) break;
    count++;
  }

  return latestDir * count;
}

function classifySignal(
  streak: number,
  rangeExpanding: boolean,
  roc3: number,
): MomentumSignal {
  const absStreak = Math.abs(streak);
  const isUp = streak > 0 || (streak === 0 && roc3 > 0);

  // Surge: strong streak with expanding ranges — institutional urgency
  if (absStreak >= SURGE_STREAK && rangeExpanding) {
    return isUp ? 'surge-up' : 'surge-down';
  }

  // Drift: moderate streak OR meaningful ROC without expansion
  if (absStreak >= DRIFT_STREAK || Math.abs(roc3) >= DRIFT_ROC_THRESHOLD) {
    return isUp ? 'drift-up' : 'drift-down';
  }

  return 'flat';
}

// ── Main ─────────────────────────────────────────────────────────────────

/** Null object for when there aren't enough candles to compute. */
export const EMPTY_MOMENTUM: CandleMomentum = {
  roc1: 0,
  roc3: 0,
  roc5: 0,
  streak: 0,
  avgRange: 0,
  avgRangePrev: 0,
  rangeExpanding: false,
  acceleration: 0,
  signal: 'flat',
};

/**
 * Compute momentum, streak, and acceleration from 1-minute SPX candles.
 *
 * Requires at least 2 candles for basic ROC; returns `EMPTY_MOMENTUM`
 * otherwise. Richer signals (range expansion, acceleration) need ~12
 * candles for full fidelity but degrade gracefully.
 */
export function computeMomentum(candles: SPXCandle[]): CandleMomentum {
  if (candles.length < 2) return EMPTY_MOMENTUM;

  // Rate of change — lookback N candles from the latest
  const roc1 = safeClose(candles, 0) - safeClose(candles, 1);
  const roc3 = safeClose(candles, 0) - safeClose(candles, 3);
  const roc5 = safeClose(candles, 0) - safeClose(candles, 5);

  // Streak
  const streak = computeStreak(candles);

  // Range expansion — compare recent window to preceding window
  const avgRange = avgRangeForWindow(candles, 0, RANGE_WINDOW);
  const avgRangePrev = avgRangeForWindow(candles, RANGE_WINDOW, RANGE_WINDOW);
  const rangeExpanding =
    avgRangePrev > 0 && avgRange > avgRangePrev * RANGE_EXPANSION_RATIO;

  // Acceleration — second derivative of price.
  // Current 1-candle ROC minus the previous 1-candle ROC.
  const prevRoc1 =
    candles.length >= 3 ? safeClose(candles, 1) - safeClose(candles, 2) : 0;
  const acceleration = roc1 - prevRoc1;

  // Signal
  const signal = classifySignal(streak, rangeExpanding, roc3);

  return {
    roc1,
    roc3,
    roc5,
    streak,
    avgRange,
    avgRangePrev,
    rangeExpanding,
    acceleration,
    signal,
  };
}

// ── Display helpers ──────────────────────────────────────────────────────

/** Human-readable label for the momentum signal. */
export function signalLabel(signal: MomentumSignal): string {
  switch (signal) {
    case 'surge-up':
      return 'SURGE \u25B2';
    case 'drift-up':
      return 'DRIFT \u25B2';
    case 'flat':
      return 'FLAT';
    case 'drift-down':
      return 'DRIFT \u25BC';
    case 'surge-down':
      return 'SURGE \u25BC';
    default: {
      const _exhaustive: never = signal;
      return _exhaustive;
    }
  }
}

/** Color for the momentum signal badge. */
export function signalColor(signal: MomentumSignal): string {
  switch (signal) {
    case 'surge-up':
      return '#00e676';
    case 'drift-up':
      return '#69f0ae';
    case 'flat':
      return 'rgba(255,255,255,0.5)';
    case 'drift-down':
      return '#ff8a80';
    case 'surge-down':
      return '#ff5252';
    default: {
      const _exhaustive: never = signal;
      return _exhaustive;
    }
  }
}
