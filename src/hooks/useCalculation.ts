import { useMemo } from 'react';
import type { IVMode, AmPm, Timezone, CalculationResults } from '../types';
import { IV_MODES } from '../constants';
import {
  calcTimeToExpiry,
  resolveIV,
  calcAllDeltas,
  to24Hour,
} from '../utils/calculator';

export interface UseCalculationReturn {
  results: CalculationResults | null;
  errors: Record<string, string>;
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

    const h = Number.parseInt(timeHour);
    const m = Number.parseInt(timeMinute);
    if (Number.isNaN(h) || Number.isNaN(m)) {
      errors['time'] = 'Select a valid hour and minute';
    } else {
      let h24 = to24Hour(h, timeAmPm);
      if (timezone === 'CT') h24 += 1;

      // Early close days: market closes at 1:00 PM ET instead of 4:00 PM ET
      const closeMinutes = earlyCloseHourET ? earlyCloseHourET * 60 : 16 * 60; // 4:00 PM ET default
      const totalMinutes = h24 * 60 + m;

      if (totalMinutes < 9 * 60 + 30) {
        errors['time'] = 'Before market open; use 9:30 AM ET or later';
      } else if (totalMinutes >= closeMinutes) {
        const closeLabel = earlyCloseHourET
          ? `${earlyCloseHourET > 12 ? earlyCloseHourET - 12 : earlyCloseHourET}:00 PM ET`
          : '4:00 PM ET';
        errors['time'] = `After market close; use before ${closeLabel}`;
      }
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
      sigma == null
    ) {
      return { results: null, errors };
    }

    let h24 = to24Hour(h, timeAmPm);
    if (timezone === 'CT') h24 += 1;

    // Compute hours remaining using actual close time (early close or standard)
    const closeHourET = earlyCloseHourET ?? 16;
    const closeMinutes = closeHourET * 60;
    const totalMinutes = h24 * 60 + m;
    const hoursRemaining = (closeMinutes - totalMinutes) / 60;

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
