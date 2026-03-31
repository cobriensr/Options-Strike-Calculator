/**
 * useAppState — Consolidates all top-level UI state for the calculator.
 *
 * Owns:
 *   - Raw input state (spot, IV, time, IC/skew settings, theme)
 *   - Debounced copies of text inputs
 *   - Derived SPX/SPY ratio computation
 *
 * Extracted from App.tsx to keep the root component focused on
 * composition and rendering.
 */

import { useState, useMemo, useCallback } from 'react';
import type { IVMode, AmPm, Timezone } from '../types';
import { DEFAULTS, IV_MODES } from '../constants';
import { useDebounced } from './useDebounced';
import { getCTTime, getETTime } from '../utils/timezone';

/**
 * Returns a CT time that is valid for the calculator.
 * If the current time is outside market hours (9:30 AM – 4:00 PM ET),
 * falls back to 10:00 AM CT so the calculator produces results immediately.
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

export function useAppState() {
  // Theme — persist preference in localStorage
  const [darkMode, setDarkMode] = useState(() => {
    try {
      const stored = localStorage.getItem('darkMode');
      return stored === null ? true : stored === 'true';
    } catch {
      return true;
    }
  });
  const setDarkModeAndPersist = useCallback((value: boolean) => {
    setDarkMode(value);
    try {
      localStorage.setItem('darkMode', String(value));
    } catch {
      // ignore
    }
  }, []);

  // Spot price state — seeded with reasonable defaults so UI renders fully;
  // overwritten by live/historical data via useAutoFill on load.
  const [spotPrice, setSpotPrice] = useState('572');
  const [spxDirect, setSpxDirect] = useState('5720');
  const [spxRatio, setSpxRatio] = useState(10);

  // IV state — seeded with default VIX so term structure + regime cards
  // render immediately; overwritten by live/historical data on load.
  const [ivMode, setIvMode] = useState<IVMode>(IV_MODES.VIX);
  const [vixInput, setVixInput] = useState('19');
  const [multiplier, setMultiplier] = useState(
    String(DEFAULTS.IV_PREMIUM_FACTOR),
  );
  const [directIVInput, setDirectIVInput] = useState('');

  // Time state — initialized to current CT time so that useAutoFill's
  // deferred time-setting (which checks for the '10'/'00' sentinel) never
  // fires. Without this, market-data arrival (~1 s after load) triggers
  // React DOM writes to the <select> elements inside the same SectionBox
  // as the date input, which causes Firefox Android to close the native
  // date picker while it is open.
  const [timeHour, setTimeHour] = useState(() => {
    const { hour } = getInitialCTTime();
    const h = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
    return String(h);
  });
  const [timeMinute, setTimeMinute] = useState(() => {
    const { minute } = getInitialCTTime();
    return String(Math.floor(minute / 5) * 5).padStart(2, '0');
  });
  const [timeAmPm, setTimeAmPm] = useState<AmPm>(() =>
    getInitialCTTime().hour >= 12 ? 'PM' : 'AM',
  );
  const [timezone, setTimezone] = useState<Timezone>('CT');

  // IC & skew state
  const [wingWidth, setWingWidth] = useState(20);
  const [showIC, setShowIC] = useState(true);
  const [contracts, setContracts] = useState(20);
  const [skewPct, setSkewPct] = useState(3);
  const [clusterMult, setClusterMult] = useState(1);

  // BWB state
  const [showBWB, setShowBWB] = useState(false);
  const [bwbNarrowWidth, setBwbNarrowWidth] = useState(20);
  const [bwbWideMultiplier, setBwbWideMultiplier] = useState(2);

  // Debounced values
  const dSpot = useDebounced(spotPrice);
  const dSpx = useDebounced(spxDirect);
  const dVix = useDebounced(vixInput);
  const dIV = useDebounced(directIVInput);
  const dMult = useDebounced(multiplier);

  // Derived SPX ratio (memoized to stabilise object identity)
  return useMemo(() => {
    const spyVal = Number.parseFloat(dSpot);
    const spxVal = Number.parseFloat(dSpx);
    const spxDirectActive =
      !!dSpx &&
      !Number.isNaN(spxVal) &&
      spxVal > 0 &&
      !Number.isNaN(spyVal) &&
      spyVal > 0;
    const effectiveRatio = spxDirectActive ? spxVal / spyVal : spxRatio;

    return {
      // Theme
      darkMode,
      setDarkMode: setDarkModeAndPersist,

      // Spot
      spotPrice,
      setSpotPrice,
      spxDirect,
      setSpxDirect,
      spxRatio,
      setSpxRatio,

      // IV
      ivMode,
      setIvMode,
      vixInput,
      setVixInput,
      multiplier,
      setMultiplier,
      directIVInput,
      setDirectIVInput,

      // Time
      timeHour,
      setTimeHour,
      timeMinute,
      setTimeMinute,
      timeAmPm,
      setTimeAmPm,
      timezone,
      setTimezone,

      // IC & skew
      wingWidth,
      setWingWidth,
      showIC,
      setShowIC,
      contracts,
      setContracts,
      skewPct,
      setSkewPct,
      clusterMult,
      setClusterMult,

      // BWB
      showBWB,
      setShowBWB,
      bwbNarrowWidth,
      setBwbNarrowWidth,
      bwbWideMultiplier,
      setBwbWideMultiplier,

      // Debounced
      dSpot,
      dSpx,
      dVix,
      dIV,
      dMult,

      // Derived
      spyVal,
      spxVal,
      spxDirectActive,
      effectiveRatio,
    };
  }, [
    darkMode,
    setDarkModeAndPersist,
    spotPrice,
    spxDirect,
    spxRatio,
    ivMode,
    vixInput,
    multiplier,
    directIVInput,
    timeHour,
    timeMinute,
    timeAmPm,
    timezone,
    wingWidth,
    showIC,
    contracts,
    skewPct,
    clusterMult,
    showBWB,
    bwbNarrowWidth,
    bwbWideMultiplier,
    dSpot,
    dSpx,
    dVix,
    dIV,
    dMult,
  ]);
}

export type AppState = ReturnType<typeof useAppState>;
