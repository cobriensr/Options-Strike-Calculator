/**
 * useTimeInputs — time-of-day picker state.
 *
 * Owns the 4 fields that drive the time picker:
 *   - timeHour (string, 1-12)
 *   - timeMinute (string, "00".."55")
 *   - timeAmPm ('AM' | 'PM')
 *   - timezone ('CT' | 'ET')
 *
 * Seeds from the current CT clock during regular trading hours
 * (9:30 AM ET – 4:00 PM ET), or 10:00 AM CT outside those hours so the
 * calculator produces results immediately on first paint. The
 * seed-from-clock-OR-default mechanism matters because useAutoFill's
 * deferred time-setting checks for the legacy '10'/'00' sentinel —
 * without an initial value the sentinel check would never settle.
 *
 * Extracted from useAppState in Phase 2P-1d.
 * Spec: docs/superpowers/specs/frontend-cleanup-tiers-1-2-3-2026-05-18.md (Phase 2P)
 */

import { useState, type Dispatch, type SetStateAction } from 'react';

import type { AmPm, Timezone } from '../types/index.js';
import { getCTTime, getETTime } from '../utils/timezone.js';

/**
 * Returns a CT time that is valid for the calculator.
 * If the current time is outside market hours (9:30 AM – 4:00 PM ET),
 * falls back to 10:00 AM CT so the calculator produces results
 * immediately on first paint.
 */
function getInitialCTTime(): { hour: number; minute: number } {
  const now = new Date();
  const et = getETTime(now);
  const etMinutes = et.hour * 60 + et.minute;
  // Market hours: 9:30 AM ET (570) to 4:00 PM ET (960)
  if (etMinutes >= 570 && etMinutes < 960) {
    return getCTTime(now);
  }
  // Outside market hours: default to 10:00 AM CT (11:00 AM ET)
  return { hour: 10, minute: 0 };
}

export interface UseTimeInputsReturn {
  timeHour: string;
  setTimeHour: Dispatch<SetStateAction<string>>;
  timeMinute: string;
  setTimeMinute: Dispatch<SetStateAction<string>>;
  timeAmPm: AmPm;
  setTimeAmPm: Dispatch<SetStateAction<AmPm>>;
  timezone: Timezone;
  setTimezone: Dispatch<SetStateAction<Timezone>>;
}

export function useTimeInputs(): UseTimeInputsReturn {
  // Initialized to current CT time so that useAutoFill's deferred
  // time-setting (which checks for the '10'/'00' sentinel) never fires.
  // Without this, market-data arrival (~1 s after load) triggers React
  // DOM writes to the <select> elements inside the same SectionBox as
  // the date input, which causes Firefox Android to close the native
  // date picker while it is open.
  //
  // Read the clock ONCE and derive all three seed fields from that single
  // snapshot. Calling getInitialCTTime() separately per useState lazy
  // initializer could read the clock across a minute / AM-PM boundary and
  // tear the seeded hour/minute/AM-PM apart (e.g. 11:59:59.9 AM → hour
  // reads 11 AM but minute reads :00 of 12 PM).
  const seed = getInitialCTTime();
  const [timeHour, setTimeHour] = useState(() => {
    const h =
      seed.hour > 12 ? seed.hour - 12 : seed.hour === 0 ? 12 : seed.hour;
    return String(h);
  });
  const [timeMinute, setTimeMinute] = useState(() =>
    String(Math.floor(seed.minute / 5) * 5).padStart(2, '0'),
  );
  const [timeAmPm, setTimeAmPm] = useState<AmPm>(() =>
    seed.hour >= 12 ? 'PM' : 'AM',
  );
  const [timezone, setTimezone] = useState<Timezone>('CT');

  return {
    timeHour,
    setTimeHour,
    timeMinute,
    setTimeMinute,
    timeAmPm,
    setTimeAmPm,
    timezone,
    setTimezone,
  };
}
