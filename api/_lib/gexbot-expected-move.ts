/**
 * GEXBot's ±1σ expected move, rebuilt from the per-strike IV the State
 * Greek endpoints already return (`decodeStrikeIvs`). The vendor draws it on
 * its Options Profile chart and documents the formula
 * (docs.gexbot.com/state/optionsprofile, read 2026-11-20):
 *
 *   expected move = spot × smoothed ATM IV × √(fractional DTE / 365)
 *   smoothed ATM IV = 50% ATM + 25% ATM−1 + 25% ATM+1
 *   fractional DTE  = seconds left to the close / 86,400
 *
 * The docs leave two things open; these are our choices, not the vendor's:
 *   - a strike's IV is the mean of its call and put IV, or the one side that
 *     is quoted;
 *   - ATM is the listed strike nearest spot (the lower one on an exact tie),
 *     and ATM±1 are the listed strikes either side of it.
 *
 * Two clocks, on purpose (owner decision 2026-11-25). The SIZE of the move
 * counts seconds to 16:00 ET on every day, the vendor's documented clock,
 * including half days: GEXBot's IV is most likely solved against that clock,
 * so it keeps sigma × √T equal to the move the option prices. The SESSION
 * still ends at the real close (13:00 ET on a half day): from then on a 0DTE
 * read is `expired`.
 *
 * Pure: no clock and no I/O. The caller passes the moment the IVs describe.
 *
 * Spec: docs/superpowers/specs/gexbot-expected-move-net-vanna-2026-11-20.md
 */

import { getMarketCloseHourET } from '../../src/data/marketHours.js';
import { etWallClockToUtcIso, getETDateStr } from '../../src/utils/timezone.js';
import type { DecodedStrikeIv } from './periscope-gexbot.js';

const SECONDS_PER_DAY = 86_400;
const DAYS_PER_YEAR = 365;
const ATM_WEIGHT = 0.5;
const NEIGHBOUR_WEIGHT = 0.25;
/** The close GEXBot counts down to ("4:00 PM ET"), in ET minutes of the day. */
const VENDOR_CLOCK_CLOSE_MIN_ET = 16 * 60;

/**
 * Why there is no expected move:
 *   - `no_spot`: the capture has no positive spot;
 *   - `no_dte`: the vendor sent no `min_dte`, or the day is a market holiday;
 *   - `expired`: a 0DTE read at or after the session close (16:00 ET, or
 *     13:00 ET on a half day);
 *   - `no_atm_iv`: the strike nearest spot has no quoted IV.
 */
export type ExpectedMoveUnavailable =
  | 'no_spot'
  | 'no_dte'
  | 'expired'
  | 'no_atm_iv';

export interface ExpectedMove {
  spot: number | null;
  /** Calendar days to the expiry the IVs belong to (0 = today). */
  minDte: number | null;
  atmStrike: number | null;
  /** Smoothed ATM IV as a fraction (0.11 = 11%). */
  atmIv: number | null;
  /** Days to expiry, including the part of today that is left. */
  dteFraction: number | null;
  /** One standard deviation, in the underlying's points. */
  expectedMove: number | null;
  lower: number | null;
  upper: number | null;
  /** Null exactly when `expectedMove` is a number. */
  unavailable: ExpectedMoveUnavailable | null;
}

export interface ExpectedMoveInput {
  spot: number | null;
  minDte: number | null;
  strikes: DecodedStrikeIv[];
  /** The moment the IVs describe (the vendor's snapshot timestamp). */
  asOf: Date;
}

function strikeIv(row: DecodedStrikeIv): number | null {
  if (row.callIv != null && row.putIv != null) {
    return (row.callIv + row.putIv) / 2;
  }
  return row.callIv ?? row.putIv;
}

/**
 * The 50/25/25 weighted IV around the strike nearest `spot`. A neighbour
 * with no IV (or no neighbour, at the edge of the chain) drops out and the
 * rest are re-weighted. Null when the ATM strike itself has no IV: its
 * neighbours alone are not an ATM read.
 */
export function smoothedAtmIv(
  strikes: DecodedStrikeIv[],
  spot: number,
): { atmStrike: number; iv: number } | null {
  const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
  let atmIndex = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    // Strict `<` keeps the lower strike on an exact tie.
    if (
      Math.abs(sorted[i]!.strike - spot) <
      Math.abs(sorted[atmIndex]!.strike - spot)
    ) {
      atmIndex = i;
    }
  }
  const atm = sorted[atmIndex];
  const atmIv = atm ? strikeIv(atm) : null;
  if (atm == null || atmIv == null) return null;

  let weighted = ATM_WEIGHT * atmIv;
  let weight = ATM_WEIGHT;
  for (const neighbour of [sorted[atmIndex - 1], sorted[atmIndex + 1]]) {
    const iv = neighbour ? strikeIv(neighbour) : null;
    if (iv == null) continue;
    weighted += NEIGHBOUR_WEIGHT * iv;
    weight += NEIGHBOUR_WEIGHT;
  }
  return { atmStrike: atm.strike, iv: weighted / weight };
}

/** Epoch ms of `minutes` past ET midnight on `etDate`; null if unparseable. */
function etWallClockMs(etDate: string, minutes: number): number | null {
  const iso = etWallClockToUtcIso(etDate, minutes);
  return iso == null ? null : new Date(iso).getTime();
}

/**
 * Days to expiry at `asOf` on the vendor's clock: `minDte` whole days plus
 * the seconds left to 16:00 ET that day over 86,400. That is 16:00 on every
 * day, half days included (see the file header). A read after 16:00 adds
 * nothing, never a negative. Null on a market holiday, for an invalid date,
 * or for a DTE that is negative or not finite.
 */
export function fractionalDte(asOf: Date, minDte: number): number | null {
  if (!Number.isFinite(minDte) || minDte < 0) return null;
  if (Number.isNaN(asOf.getTime())) return null;
  const etDate = getETDateStr(asOf);
  if (getMarketCloseHourET(etDate) == null) return null;
  const closeMs = etWallClockMs(etDate, VENDOR_CLOCK_CLOSE_MIN_ET);
  if (closeMs == null) return null;
  const secondsLeft = Math.max(0, (closeMs - asOf.getTime()) / 1000);
  return minDte + secondsLeft / SECONDS_PER_DAY;
}

/**
 * True at or after the calendar close of `asOf`'s ET day: 16:00 ET, or 13:00
 * ET on an early-close day. False on a market holiday and for an invalid
 * date (neither has a session to be over).
 */
export function isSessionOver(asOf: Date): boolean {
  if (Number.isNaN(asOf.getTime())) return false;
  const etDate = getETDateStr(asOf);
  const closeHour = getMarketCloseHourET(etDate);
  if (closeHour == null) return false;
  const closeMs = etWallClockMs(etDate, closeHour * 60);
  return closeMs != null && asOf.getTime() >= closeMs;
}

/**
 * True when the vendor's snapshot stamp falls on an earlier ET date than the
 * moment we captured it: the vendor replaying a finished session's last
 * snapshot at the open. Its IVs describe yesterday, so the capture says
 * nothing about the session that is starting.
 */
export function isPriorSessionStamp(vendorAt: Date, capturedAt: Date): boolean {
  return getETDateStr(vendorAt) < getETDateStr(capturedAt);
}

export function computeExpectedMove(input: ExpectedMoveInput): ExpectedMove {
  const { spot, minDte, strikes, asOf } = input;
  const none = {
    atmStrike: null,
    atmIv: null,
    dteFraction: null,
    expectedMove: null,
    lower: null,
    upper: null,
  };
  if (spot == null || !Number.isFinite(spot) || spot <= 0) {
    return { ...none, spot: null, minDte, unavailable: 'no_spot' };
  }
  const dteFraction = minDte == null ? null : fractionalDte(asOf, minDte);
  if (dteFraction == null) {
    return { ...none, spot, minDte, unavailable: 'no_dte' };
  }
  // The size above counts to 16:00; the session ends at the calendar close.
  // Only a same-day expiry is over then: a later one still has days to run.
  if (minDte === 0 && isSessionOver(asOf)) {
    return {
      ...none,
      spot,
      minDte,
      dteFraction: 0,
      unavailable: 'expired',
    };
  }
  const atm = smoothedAtmIv(strikes, spot);
  if (atm == null) {
    return { ...none, spot, minDte, dteFraction, unavailable: 'no_atm_iv' };
  }
  const expectedMove = spot * atm.iv * Math.sqrt(dteFraction / DAYS_PER_YEAR);
  return {
    spot,
    minDte,
    atmStrike: atm.atmStrike,
    atmIv: atm.iv,
    dteFraction,
    expectedMove,
    lower: spot - expectedMove,
    upper: spot + expectedMove,
    unavailable: null,
  };
}
