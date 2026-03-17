import { useEffect, useState } from 'react';
import type { IVMode, CalculationResults } from '../types';
import { IV_MODES } from '../constants';
import {
  calcTimeToExpiry,
  resolveIV,
  calcAllDeltas,
  to24Hour,
} from '../utils/calculator';

type AmPm = 'AM' | 'PM';
type Timezone = 'ET' | 'CT';

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
  const [results, setResults] = useState<CalculationResults | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

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

  useEffect(() => {
    const newErrors: Record<string, string> = {};
    const spyInput = Number.parseFloat(dSpot);
    if (dSpot && (Number.isNaN(spyInput) || spyInput <= 0))
      newErrors['spot'] = 'Enter a positive number';
    const spot = spyInput * effectiveRatio;

    const h = Number.parseInt(timeHour);
    const m = Number.parseInt(timeMinute);
    if (Number.isNaN(h) || Number.isNaN(m)) {
      newErrors['time'] = 'Invalid time';
    } else {
      let h24 = to24Hour(h, timeAmPm);
      if (timezone === 'CT') h24 += 1;

      // Early close days: market closes at 1:00 PM ET instead of 4:00 PM ET
      const closeMinutes = earlyCloseHourET ? earlyCloseHourET * 60 : 16 * 60; // 4:00 PM ET default
      const totalMinutes = h24 * 60 + m;

      if (totalMinutes < 9 * 60 + 30) {
        newErrors['time'] = 'Before market open (9:30 AM ET)';
      } else if (totalMinutes >= closeMinutes) {
        newErrors['time'] = earlyCloseHourET
          ? `At or after early close (${earlyCloseHourET > 12 ? earlyCloseHourET - 12 : earlyCloseHourET}:00 PM ET)`
          : 'At or after market close (4:00 PM ET)';
      }
    }

    let sigma: number | null = null;
    if (ivMode === IV_MODES.VIX) {
      const v = Number.parseFloat(dVix);
      const mult = Number.parseFloat(dMult);
      if (dVix && Number.isNaN(v)) newErrors['vix'] = 'Enter a valid number';
      else if (dMult && Number.isNaN(mult))
        newErrors['multiplier'] = 'Enter a valid number';
      else if (dVix) {
        const ivResult = resolveIV(IV_MODES.VIX, { vix: v, multiplier: mult });
        if (ivResult.error) newErrors['iv'] = ivResult.error;
        else sigma = ivResult.sigma;
      }
    } else {
      const iv = Number.parseFloat(dIV);
      if (dIV && Number.isNaN(iv)) newErrors['iv'] = 'Enter a valid number';
      else if (dIV) {
        const ivResult = resolveIV(IV_MODES.DIRECT, { directIV: iv });
        if (ivResult.error) newErrors['iv'] = ivResult.error;
        else sigma = ivResult.sigma;
      }
    }

    setErrors(newErrors);

    if (Object.keys(newErrors).length === 0 && spyInput > 0 && sigma != null) {
      let h24 = to24Hour(h, timeAmPm);
      if (timezone === 'CT') h24 += 1;

      // Compute hours remaining using actual close time (early close or standard)
      const closeMinutes = earlyCloseHourET ? earlyCloseHourET * 60 : 16 * 60;
      const totalMinutes = h24 * 60 + m;
      const hoursRemaining = (closeMinutes - totalMinutes) / 60;

      if (hoursRemaining > 0) {
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
        setResults({ allDeltas, sigma, T, hoursRemaining, spot, vix });
      }
    } else {
      setResults(null);
    }
  }, [
    dSpot,
    dVix,
    dIV,
    dMult,
    ivMode,
    timeHour,
    timeMinute,
    timeAmPm,
    timezone,
    effectiveRatio,
    skewPct,
    earlyCloseHourET,
  ]);

  return { results, errors };
}
