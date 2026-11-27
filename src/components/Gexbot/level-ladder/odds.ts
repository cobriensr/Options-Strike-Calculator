/**
 * Priced odds for a short strike on the level ladder, and how they print.
 *
 * Pure. For a short strike `K` and the ladder's spot `S`, with `distance`
 * `K − S` for a call and `S − K` for a put:
 *
 * - The priced chance of finishing beyond `K` is what a vertical spread at
 *   `K` costs per point of width as it narrows to nothing (the skew-adjusted
 *   digital), from `K`'s own IV and the smile's slope on the short leg's
 *   side (owner, 2026-11-26). Fallback, the ATM σ: `N(−distance ÷ E)`, when
 *   the strike IVs can't price it.
 * - `sigmaAway` is the σ whose normal tail equals that chance,
 *   `−Φ⁻¹(finishBeyond)`, so the printed σ and odds always agree (on the
 *   fallback it is `distance ÷ E`).
 * - The chance of a touch is twice the finish, capped at 1.
 * - The status comes from `sigmaAway`, except that `breached` is spot's
 *   position: at or past the strike.
 *
 * These are the odds the options are pricing, from GEXBot's IVs: not an edge
 * and not a forecast. The panel says "priced" every time it prints one.
 *
 * `strikeOdds` is the one place the odds are computed, so the volatility
 * source can change there alone.
 *
 * Spec: docs/superpowers/specs/gexbot-level-ladder-2026-11-22.md,
 * "Odds and status".
 */

import { DEFAULTS } from '../../../constants';
import type { ExpectedMoveRow } from '../../../hooks/useGexbotData';
import { normalCDF, normalPDF } from '../../../utils/black-scholes';
import {
  LADDER_CLEAR_SIGMA,
  LADDER_TESTED_SIGMA,
  type LadderStrikeIv,
  type LadderVolatility,
  type OddsSource,
  type ShortSide,
  type StrikeOdds,
  type StrikeStatus,
} from './types';

const MS_PER_DAY = 86_400_000;

/** The smile's slope at `K` is read from one listed strike either side. */
const SLOPE_STEP = DEFAULTS.STRIKE_INCREMENT;

/** A finite number above 0: the guard for spot, levels, IVs and `E`. */
export function isPositiveFinite(value: number | null): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

/** Priced chance of finishing beyond a strike `sigmaAway` σ out, on the ATM σ. */
export function finishBeyondProbability(sigmaAway: number): number {
  return normalCDF(-sigmaAway);
}

/** Priced chance of a touch before expiry: twice the finish, at most 1. */
export function touchProbability(finishBeyond: number): number {
  return Math.min(1, 2 * finishBeyond);
}

/**
 * Breached once spot is at or past the strike (`distance` ≤ 0), whatever σ
 * says; otherwise clear, watch or tested by `sigmaAway`. A strike spot has
 * not reached but priced at 50% or more (`sigmaAway` ≤ 0) is `tested`.
 */
export function strikeStatus(
  sigmaAway: number,
  distance: number,
): StrikeStatus {
  if (distance <= 0) return 'breached';
  if (sigmaAway >= LADDER_CLEAR_SIGMA) return 'clear';
  if (sigmaAway >= LADDER_TESTED_SIGMA) return 'watch';
  return 'tested';
}

// ────────────────────────────────────────────────────────────
// Φ⁻¹
// ────────────────────────────────────────────────────────────

// Acklam's rational approximation (relative error about 1.15e-9).
const ACKLAM_A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
  1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
] as const;
const ACKLAM_B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
  6.680131188771972e1, -1.328068155288572e1,
] as const;
const ACKLAM_C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
  -2.549732539343734, 4.374664141464968, 2.938163982698783,
] as const;
const ACKLAM_D = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
  3.754408661907416,
] as const;
const ACKLAM_TAIL = 0.02425;

/** Horner's rule over coefficients from the highest power down. */
function horner(coefficients: readonly number[], x: number): number {
  return coefficients.reduce((sum, c) => sum * x + c, 0);
}

/** Acklam's lower-tail formula for `p` < `ACKLAM_TAIL`. */
function acklamLowerTail(p: number): number {
  const q = Math.sqrt(-2 * Math.log(p));
  return horner(ACKLAM_C, q) / (horner(ACKLAM_D, q) * q + 1);
}

/**
 * Φ⁻¹, the inverse of `normalCDF`: Acklam's approximation, then two Newton
 * steps against this repo's `normalCDF` itself, so `normalCDF(Φ⁻¹(p))`
 * returns `p` to within about 1e-9 (measured from p = 1e-6 to 1 − 1e-6).
 * −∞ at 0 and +∞ at 1.
 */
export function inverseNormalCDF(p: number): number {
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;
  let x: number;
  if (p < ACKLAM_TAIL) x = acklamLowerTail(p);
  else if (p > 1 - ACKLAM_TAIL) x = -acklamLowerTail(1 - p);
  else {
    const q = p - 0.5;
    const r = q * q;
    x = (horner(ACKLAM_A, r) * q) / (horner(ACKLAM_B, r) * r + 1);
  }
  for (let step = 0; step < 2; step++) {
    x -= (normalCDF(x) - p) / normalPDF(x);
  }
  return x;
}

// ────────────────────────────────────────────────────────────
// The priced chance (the skew-adjusted digital)
// ────────────────────────────────────────────────────────────

/**
 * The market's priced chance of finishing beyond `strike`: a vertical
 * spread at the strike per point of width, taken as the spread narrows to
 * nothing. That is the strike derivative of normal-model (Bachelier) prices
 * with each strike at its own IV on the short leg's side:
 *
 * - `m = S × √(days ÷ 365)`, `n = m × IV(K)` points;
 * - the smile's slope `IV′ = (IV(K + h) − IV(K − h)) ÷ 2h`, per point;
 * - put `Φ(d) + φ(d) × m × IV′` with `d = (K − S) ÷ n`; call
 *   `Φ(x) − φ(x) × m × IV′` with `x = (S − K) ÷ n`.
 *
 * The `Φ` term is the curve at `K`'s own IV, and the slope term takes part
 * of it back (a put's IV usually falls toward spot). With a flat smile it is
 * the ATM formula exactly, at every `E`: unlike a 10-wide spread's average
 * over `K ± h`, which reads strikes riskier as `E` shrinks late in a session.
 *
 * Null when `K`, `K − h` or `K + h` has no usable IV on that side, or the
 * result is not finite or not strictly between 0 and 1.
 */
function pricedFinishBeyond(
  side: ShortSide,
  strike: number,
  spot: number,
  daysLeft: number,
  strikeIvs: readonly LadderStrikeIv[],
): number | null {
  const ivAt = (k: number) => {
    const row = strikeIvs.find((r) => r.strike === k);
    return (side === 'put' ? row?.putIv : row?.callIv) ?? null;
  };
  const ownIv = ivAt(strike);
  const lowIv = ivAt(strike - SLOPE_STEP);
  const highIv = ivAt(strike + SLOPE_STEP);
  if (
    !isPositiveFinite(ownIv) ||
    !isPositiveFinite(lowIv) ||
    !isPositiveFinite(highIv)
  ) {
    return null;
  }

  const m = spot * Math.sqrt(daysLeft / 365);
  const n = m * ownIv;
  const slope = (highIv - lowIv) / (2 * SLOPE_STEP);
  // A put's chance rises with its strike, a call's falls: one form, signed.
  const z = side === 'put' ? (strike - spot) / n : (spot - strike) / n;
  const skew = normalPDF(z) * m * slope;
  const result = normalCDF(z) + (side === 'put' ? skew : -skew);
  return Number.isFinite(result) && result > 0 && result < 1 ? result : null;
}

// ────────────────────────────────────────────────────────────
// The odds
// ────────────────────────────────────────────────────────────

/**
 * The odds for one short strike, or null with no usable volatility (none,
 * or `E` not finite and above 0). The priced chance when the strike IVs can
 * price it (`oddsSource: 'priced'`), else the ATM σ (`'atm'`). A breached
 * strike has been touched, so it carries how far past it spot is instead of
 * a touch and a finish beyond.
 */
export function strikeOdds(
  side: ShortSide,
  strike: number,
  spot: number,
  vol: LadderVolatility | null,
): StrikeOdds | null {
  if (vol == null || !isPositiveFinite(vol.expectedMove)) return null;
  const distance = side === 'call' ? strike - spot : spot - strike;
  const priced =
    vol.strikeIvs == null
      ? null
      : pricedFinishBeyond(side, strike, spot, vol.daysLeft, vol.strikeIvs);

  let oddsSource: OddsSource;
  let finishBeyond: number;
  let sigmaAway: number;
  if (priced == null) {
    oddsSource = 'atm';
    sigmaAway = distance / vol.expectedMove;
    finishBeyond = finishBeyondProbability(sigmaAway);
  } else {
    oddsSource = 'priced';
    finishBeyond = priced;
    sigmaAway = -inverseNormalCDF(priced);
  }

  const status = strikeStatus(sigmaAway, distance);
  if (status === 'breached') {
    // `distance` ≤ 0 here; abs, not negation, so spot on the strike is 0, not −0.
    return {
      sigmaAway,
      status,
      finishBeyond: null,
      touch: null,
      pointsPast: Math.abs(distance),
      oddsSource,
    };
  }
  return {
    sigmaAway,
    status,
    finishBeyond,
    touch: touchProbability(finishBeyond),
    pointsPast: null,
    oddsSource,
  };
}

/**
 * The expected-move row carried forward from its stamp to `nowMs`: the time
 * left `T_now = T_row − elapsed` in days, with `T_row` the row's
 * `dteFraction`, and `E = E_row × √(T_now ÷ T_row)`. The row is sized at
 * the vendor's stamp, which can be a couple of minutes old, and near the
 * close that overstates `E` (a 2-minute-old row with 5 minutes left is
 * about 18% too wide).
 *
 * Elapsed time clamps at 0, so a row stamped after `nowMs` never widens `E`.
 * Null when the row has no usable move or time, or `T_now` ≤ 0.
 */
export function carryForwardMove(
  row: Pick<ExpectedMoveRow, 'expectedMove' | 'dteFraction' | 'asOf'>,
  nowMs: number,
): { expectedMove: number; daysLeft: number } | null {
  const { expectedMove, dteFraction } = row;
  if (!isPositiveFinite(expectedMove) || !isPositiveFinite(dteFraction)) {
    return null;
  }
  const asOfMs = Date.parse(row.asOf);
  if (Number.isNaN(asOfMs)) return null;
  const elapsedDays = Math.max(0, nowMs - asOfMs) / MS_PER_DAY;
  const daysLeft = dteFraction - elapsedDays;
  // A NaN (from a NaN nowMs) is refused too, not only ≤ 0.
  if (Number.isNaN(daysLeft) || daysLeft <= 0) return null;
  return {
    expectedMove: expectedMove * Math.sqrt(daysLeft / dteFraction),
    daysLeft,
  };
}

// ────────────────────────────────────────────────────────────
// Printing
// ────────────────────────────────────────────────────────────

/**
 * σ to two decimals below 3 and one from 3 up: "1.37σ", "7.1σ". The
 * precision is chosen from the value rounded to hundredths, so 2.996 prints
 * "3.0σ", never "3.00σ". Below 0 (a strike priced at 50% or more before spot
 * reaches it) prints "0.00σ".
 */
export function formatSigma(sigmaAway: number): string {
  const sigma = Math.max(0, sigmaAway);
  const hundredths = Math.round(sigma * 100) / 100;
  const text = hundredths < 3 ? hundredths.toFixed(2) : sigma.toFixed(1);
  return `${text}σ`;
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
