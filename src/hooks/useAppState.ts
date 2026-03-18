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

import { useState } from 'react';
import type { IVMode, AmPm, Timezone } from '../types';
import { DEFAULTS, IV_MODES } from '../constants';
import { useDebounced } from './useDebounced';

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
  const setDarkModeAndPersist = (value: boolean) => {
    setDarkMode(value);
    try {
      localStorage.setItem('darkMode', String(value));
    } catch {
      // ignore
    }
  };

  // Spot price state
  const [spotPrice, setSpotPrice] = useState('');
  const [spxDirect, setSpxDirect] = useState('');
  const [spxRatio, setSpxRatio] = useState(10);

  // IV state
  const [ivMode, setIvMode] = useState<IVMode>(IV_MODES.VIX);
  const [vixInput, setVixInput] = useState('');
  const [multiplier, setMultiplier] = useState(
    String(DEFAULTS.IV_PREMIUM_FACTOR),
  );
  const [directIVInput, setDirectIVInput] = useState('');

  // Time state
  const [timeHour, setTimeHour] = useState('10');
  const [timeMinute, setTimeMinute] = useState('00');
  const [timeAmPm, setTimeAmPm] = useState<AmPm>('AM');
  const [timezone, setTimezone] = useState<Timezone>('CT');

  // IC & skew state
  const [wingWidth, setWingWidth] = useState(20);
  const [showIC, setShowIC] = useState(true);
  const [contracts, setContracts] = useState(20);
  const [skewPct, setSkewPct] = useState(3);
  const [clusterMult, setClusterMult] = useState(1);

  // Debounced values
  const dSpot = useDebounced(spotPrice);
  const dSpx = useDebounced(spxDirect);
  const dVix = useDebounced(vixInput);
  const dIV = useDebounced(directIVInput);
  const dMult = useDebounced(multiplier);

  // Derived SPX ratio
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
}

export type AppState = ReturnType<typeof useAppState>;
