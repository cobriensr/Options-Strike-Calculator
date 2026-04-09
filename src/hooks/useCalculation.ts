import { useMemo } from 'react';
import type { IVMode, AmPm, Timezone, CalculationResults } from '../types';
import { IV_MODES } from '../constants';
import {
  calcTimeToExpiry,
  resolveIV,
  calcAllDeltas,
  to24Hour,
} from '../utils/calculator';
import { convertCTToET } from '../utils/timezone';

export interface UseCalculationReturn {
  results: CalculationResults | null;
  errors: Record<string, string>;
}

/**
 * Discriminated result of `computeMarketTime`. The valid branch carries
 * every derived quantity downstream consumers need (totalMinutes,
 * closeMinutes, hoursRemaining), so callers never have to redo the math.
 */
type MarketTimeResult =
  | {
      readonly valid: true;
      readonly totalMinutes: number;
      readonly closeMinutes: number;
      readonly hoursRemaining: number;
    }
  | { readonly valid: false; readonly error: string };

/**
 * Single source of truth for the calculator's time math. Combines:
 *  1. 12h → 24h conversion
 *  2. CT → ET conversion (TZ-aware via Intl, not a fixed +1 offset)
 *  3. market-hours validation (with early-close support)
 *  4. hours-remaining computation
 *
 * Centralizing this prevents the validation block and the computation
 * block from drifting apart (FE-STATE-003) and lets FE-STATE-004's TZ
 * fix live in exactly one place.
 *
 * Error strings are preserved verbatim from the previous inline
 * implementation so no user-visible UI text changes.
 */
export function computeMarketTime(
  timeHour: string,
  timeMinute: string,
  timeAmPm: AmPm,
  timezone: Timezone,
  earlyCloseHourET?: number,
): MarketTimeResult {
  const h = Number.parseInt(timeHour);
  const m = Number.parseInt(timeMinute);
  if (Number.isNaN(h) || Number.isNaN(m)) {
    return { valid: false, error: 'Select a valid hour and minute' };
  }

  const h24Local = to24Hour(h, timeAmPm);
  const etTime =
    timezone === 'CT'
      ? convertCTToET(h24Local, m)
      : { hour: h24Local, minute: m };

  // Early close days: market closes at 1:00 PM ET instead of 4:00 PM ET
  const closeMinutes = earlyCloseHourET ? earlyCloseHourET * 60 : 16 * 60;
  const totalMinutes = etTime.hour * 60 + etTime.minute;

  if (totalMinutes < 9 * 60 + 30) {
    return {
      valid: false,
      error: 'Before market open; use 9:30 AM ET or later',
    };
  }
  if (totalMinutes >= closeMinutes) {
    const closeLabel = earlyCloseHourET
      ? `${earlyCloseHourET > 12 ? earlyCloseHourET - 12 : earlyCloseHourET}:00 PM ET`
      : '4:00 PM ET';
    return {
      valid: false,
      error: `After market close; use before ${closeLabel}`,
    };
  }

  return {
    valid: true,
    totalMinutes,
    closeMinutes,
    hoursRemaining: (closeMinutes - totalMinutes) / 60,
  };
}

export function useCalculation(
  dSpot: string,
  dSpx: string,
  dVix: string,
  dIV: string,
  dMult: string,
  ivMode: IVMode,
  timeHour: string,
  timeMinute: string,
  timeAmPm: AmPm,
  timezone: Timezone,
  spxRatio: number,
  skewPct: number,
  earlyCloseHourET?: number,
): UseCalculationReturn {
  return useMemo(() => {
    const errors: Record<string, string> = {};

    // Derive effective ratio
    const spyVal = Number.parseFloat(dSpot);
    const spxVal = Number.parseFloat(dSpx);
    const spxDirectActive =
      dSpx &&
      !Number.isNaN(spxVal) &&
      spxVal > 0 &&
      !Number.isNaN(spyVal) &&
      spyVal > 0;
    const effectiveRatio = spxDirectActive ? spxVal / spyVal : spxRatio;

    const spyInput = Number.parseFloat(dSpot);
    if (dSpot && (Number.isNaN(spyInput) || spyInput <= 0))
      errors['spot'] = 'Must be a positive number (e.g. 550)';
    const spot = spyInput * effectiveRatio;

    // Single source of truth for all time math: 12h→24h, CT→ET (TZ-aware),
    // market-hours validation, and hours-remaining. (FE-STATE-003 / 004)
    const marketTime = computeMarketTime(
      timeHour,
      timeMinute,
      timeAmPm,
      timezone,
      earlyCloseHourET,
    );
    if (!marketTime.valid) {
      errors['time'] = marketTime.error;
    }

    let sigma: number | null = null;
    if (ivMode === IV_MODES.VIX) {
      const v = Number.parseFloat(dVix);
      const mult = Number.parseFloat(dMult);
      if (dVix && Number.isNaN(v))
        errors['vix'] = 'VIX must be a number (e.g. 19)';
      else if (dMult && Number.isNaN(mult))
        errors['multiplier'] = 'Adjustment must be a number (e.g. 1.15)';
      else if (dVix) {
        const ivResult = resolveIV(IV_MODES.VIX, { vix: v, multiplier: mult });
        if (ivResult.error) errors['iv'] = ivResult.error;
        else sigma = ivResult.sigma;
      }
    } else {
      const iv = Number.parseFloat(dIV);
      if (dIV && Number.isNaN(iv))
        errors['iv'] = 'IV must be a decimal (e.g. 0.22)';
      else if (dIV) {
        const ivResult = resolveIV(IV_MODES.DIRECT, { directIV: iv });
        if (ivResult.error) errors['iv'] = ivResult.error;
        else sigma = ivResult.sigma;
      }
    }

    if (
      Object.keys(errors).length > 0 ||
      !dSpot ||
      Number.isNaN(spyInput) ||
      spyInput <= 0 ||
      sigma == null ||
      !marketTime.valid
    ) {
      return { results: null, errors };
    }

    // After the guard above, marketTime is the valid branch — reuse the
    // already-computed hoursRemaining instead of redoing the time math.
    const { hoursRemaining } = marketTime;
    const closeHourET = earlyCloseHourET ?? 16;

    if (hoursRemaining <= 0) {
      return { results: null, errors };
    }

    // NYSE always opens at 9:30 ET. Half-days only shorten the close.
    // 6.5 on a normal day, 3.5 on a half-day. Exposed in CalculationResults
    // so theta-curve consumers (ThetaDecayChart, calcThetaCurve) can scale
    // their grids correctly. (FE-MATH-006)
    const marketHours = closeHourET - 9.5;

    const T = calcTimeToExpiry(hoursRemaining);
    const allDeltas = calcAllDeltas(
      spot,
      sigma,
      T,
      skewPct / 100,
      effectiveRatio,
    );
    const vixVal = dVix ? Number.parseFloat(dVix) : undefined;
    const vix = vixVal && !Number.isNaN(vixVal) ? vixVal : undefined;
    const results: CalculationResults = {
      allDeltas,
      sigma,
      T,
      hoursRemaining,
      spot,
      vix,
      marketHours,
    };

    return { results, errors };
  }, [
    dSpot,
    dSpx,
    dVix,
    dIV,
    dMult,
    ivMode,
    timeHour,
    timeMinute,
    timeAmPm,
    timezone,
    spxRatio,
    skewPct,
    earlyCloseHourET,
  ]);
}
