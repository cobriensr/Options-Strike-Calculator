/**
 * Priced odds for a short strike on the level ladder, and how they print.
 *
 * Pure. For a short strike `K`, the ladder's spot `S` and `E` (one standard
 * deviation to expiry, in points): `sigmaAway` is `(K − S) / E` for a call
 * and `(S − K) / E` for a put, the chance of finishing beyond the strike is
 * `N(−sigmaAway)` and the chance of a touch is twice that, capped at 1.
 *
 * These are the odds options are pricing through GEXBot's expected move, on
 * a normal curve with no skew: not an edge and not a forecast. The panel
 * says "priced" every time it prints one.
 *
 * Spec: docs/superpowers/specs/gexbot-level-ladder-2026-11-22.md,
 * "Odds and status".
 */

import type { ExpectedMoveRow } from '../../../hooks/useGexbotData';
import { normalCDF } from '../../../utils/black-scholes';
import {
  LADDER_CLEAR_SIGMA,
  LADDER_TESTED_SIGMA,
  type ShortSide,
  type StrikeOdds,
  type StrikeStatus,
} from './types';

const MS_PER_DAY = 86_400_000;

/** A finite number above 0: the guard for spot, levels and `E`. */
export function isPositiveFinite(value: number | null): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

/** Priced chance of finishing beyond a strike `sigmaAway` σ from spot. */
export function finishBeyondProbability(sigmaAway: number): number {
  return normalCDF(-sigmaAway);
}

/** Priced chance of a touch before expiry: twice the finish, at most 1. */
export function touchProbability(sigmaAway: number): number {
  return Math.min(1, 2 * finishBeyondProbability(sigmaAway));
}

export function statusForSigma(sigmaAway: number): StrikeStatus {
  if (sigmaAway >= LADDER_CLEAR_SIGMA) return 'clear';
  if (sigmaAway >= LADDER_TESTED_SIGMA) return 'watch';
  if (sigmaAway > 0) return 'tested';
  return 'breached';
}

/**
 * The odds for one short strike, or null with no usable `E` (null,
 * non-finite or ≤ 0). A breached strike has been touched, so it carries how
 * far past it spot is instead of a touch and a finish beyond.
 */
export function strikeOdds(
  side: ShortSide,
  strike: number,
  spot: number,
  expectedMove: number | null,
): StrikeOdds | null {
  if (!isPositiveFinite(expectedMove)) return null;
  const toward = side === 'call' ? strike - spot : spot - strike;
  const sigmaAway = toward / expectedMove;
  const status = statusForSigma(sigmaAway);
  if (status === 'breached') {
    // `toward` ≤ 0 here; abs, not negation, so spot on the strike is 0, not −0.
    return {
      sigmaAway,
      status,
      finishBeyond: null,
      touch: null,
      pointsPast: Math.abs(toward),
    };
  }
  return {
    sigmaAway,
    status,
    finishBeyond: finishBeyondProbability(sigmaAway),
    touch: touchProbability(sigmaAway),
    pointsPast: null,
  };
}

/**
 * The expected-move row's `E` carried forward from its stamp to `nowMs`:
 * `E_row × √(T_now ÷ T_row)`, with `T_row` the row's `dteFraction` (days)
 * and `T_now = T_row − elapsed`. The row is sized at the vendor's stamp,
 * which can be a couple of minutes old, and near the close that overstates
 * `E` (a 2-minute-old row with 5 minutes left is about 18% too wide).
 *
 * Elapsed time clamps at 0, so a row stamped after `nowMs` never widens `E`.
 * Null when the row has no usable move or time, or `T_now` ≤ 0.
 */
export function carryForwardExpectedMove(
  row: Pick<ExpectedMoveRow, 'expectedMove' | 'dteFraction' | 'asOf'>,
  nowMs: number,
): number | null {
  const { expectedMove, dteFraction } = row;
  if (!isPositiveFinite(expectedMove) || !isPositiveFinite(dteFraction)) {
    return null;
  }
  const asOfMs = Date.parse(row.asOf);
  if (Number.isNaN(asOfMs)) return null;
  const elapsedDays = Math.max(0, nowMs - asOfMs) / MS_PER_DAY;
  const tNow = dteFraction - elapsedDays;
  if (tNow <= 0) return null;
  return expectedMove * Math.sqrt(tNow / dteFraction);
}

// ────────────────────────────────────────────────────────────
// Printing
// ────────────────────────────────────────────────────────────

/** σ to two decimals below 3 and one from 3 up: "1.37σ", "7.1σ". */
export function formatSigma(sigmaAway: number): string {
  return `${sigmaAway.toFixed(sigmaAway < 3 ? 2 : 1)}σ`;
}

/** Whole percent; below 1% is "under 1%", above 99% is "over 99%". */
export function formatPercent(p: number): string {
  if (p < 0.01) return 'under 1%';
  if (p > 0.99) return 'over 99%';
  return `${Math.round(p * 100)}%`;
}

/**
 * One decimal with thousands separators: distances in points ("2.4") and
 * prices that are not strikes (spot, the band, "1,234.6").
 */
export function formatOneDecimal(value: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/**
 * How far past a breached strike spot is: "spot is 2.4 pts past it", or
 * "spot is at it" when that rounds to nothing.
 */
export function formatPointsPast(pointsPast: number): string {
  const text = formatOneDecimal(pointsPast);
  return text === '0.0' ? 'spot is at it' : `spot is ${text} pts past it`;
}

/**
 * A short-strike row's second column after its pill:
 * "1.37σ · touch 17% · finish beyond 8%". A breached strike prints how far
 * past it spot is, with no touch or finish beyond.
 */
export function formatOddsLine(odds: StrikeOdds): string {
  if (odds.status === 'breached') return formatPointsPast(odds.pointsPast);
  const touch = formatPercent(odds.touch);
  const finish = formatPercent(odds.finishBeyond);
  return `${formatSigma(odds.sigmaAway)} · touch ${touch} · finish beyond ${finish}`;
}
