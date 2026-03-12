import { useEffect, useState } from 'react';
import type { IVMode, CalculationResults } from '../types';
import { IV_MODES } from '../constants';
import {
  validateMarketTime,
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
      const timeResult = validateMarketTime(h24, m);
      if (!timeResult.valid && timeResult.error)
        newErrors['time'] = timeResult.error;
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
      const { hoursRemaining } = validateMarketTime(h24, m);
      if (hoursRemaining != null) {
        const T = calcTimeToExpiry(hoursRemaining);
        const allDeltas = calcAllDeltas(
          spot,
          sigma,
          T,
          skewPct / 100,
          effectiveRatio,
        );
        setResults({ allDeltas, sigma, T, hoursRemaining, spot });
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
  ]);

  return { results, errors };
}
