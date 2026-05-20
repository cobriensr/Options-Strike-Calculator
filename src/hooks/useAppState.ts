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
 *
 * Memoization policy: the previous incarnation wrapped the entire
 * 30-field return object in a single `useMemo` with 26 dependencies.
 * That pattern looks defensive but does nothing useful: the only
 * consumer (App.tsx) destructures the return immediately, so object
 * identity never leaves this hook. The memo was invalidated on every
 * state change and bought zero downstream stability. Removed.
 *
 * What IS still memoized: the four derived values (`spyVal`, `spxVal`,
 * `spxDirectActive`, `effectiveRatio`) share a tight 3-dep array
 * `[dSpot, dSpx, spxRatio]` and stay stable across unrelated state
 * churn (theme toggle, time picker, etc.).
 */

import { useState } from 'react';
import { useIvInputs } from './useIvInputs';
import { useSpotInputs } from './useSpotInputs';
import { useTheme } from './useTheme';
import { useTimeInputs } from './useTimeInputs';

export function useAppState() {
  // Theme — Phase 2P-1a moved this to the dedicated `useTheme` hook.
  // useAppState stays the facade so existing consumers
  // (`appState.darkMode` / `appState.setDarkMode`) don't churn until
  // Phase 2P-2 deletes the facade entirely.
  const { darkMode, setDarkMode } = useTheme();

  // Spot inputs — Phase 2P-1b moved this to the dedicated `useSpotInputs`
  // hook. useAppState stays the facade so consumers don't churn until
  // Phase 2P-2 deletes the facade entirely.
  const spotInputs = useSpotInputs();

  // IV inputs — Phase 2P-1c moved this to the dedicated `useIvInputs`
  // hook. Provides ivMode/vixInput/multiplier/directIVInput +
  // their debounced copies (dVix, dIV, dMult).
  const ivInputs = useIvInputs();

  // Time inputs — Phase 2P-1d moved this to the dedicated
  // `useTimeInputs` hook. Provides timeHour/timeMinute/timeAmPm/timezone.
  const timeInputs = useTimeInputs();

  // IC & skew state
  const [wingWidth, setWingWidth] = useState(20);
  const [showIC, setShowIC] = useState(true);
  const [contracts, setContracts] = useState(20);
  const [skewPct, setSkewPct] = useState(3);
  const [clusterMult, setClusterMult] = useState(1);

  // Hedge breakeven coverage target — audit FE-MATH-009.
  // Multiplier of spot-to-hedge-strike distance used to size hedge contracts.
  // 1.0 = cost-neutral (hedge covers full IC loss only at 1× distance),
  // 1.5 = default (moderate coverage), 3.0 = aggressive.
  const [breakevenTarget, setBreakevenTarget] = useState(1.5);

  // BWB state
  const [showBWB, setShowBWB] = useState(false);
  const [bwbNarrowWidth, setBwbNarrowWidth] = useState(20);
  const [bwbWideMultiplier, setBwbWideMultiplier] = useState(2);

  // FE-STATE-006: aggregate portfolio risk threshold as % of NLV.
  // Warning fires when total effective max loss exceeds this % of NLV.
  // Default 12% is mid-range of audit's 10-15% suggestion.
  const [portfolioRiskThresholdPct, setPortfolioRiskThresholdPct] =
    useState(12);

  // Debounced spot/spx live in useSpotInputs;
  // debounced vix/iv/multiplier live in useIvInputs.

  return {
    // Theme
    darkMode,
    setDarkMode,

    // Spot — sourced from `useSpotInputs` (also provides dSpot, dSpx,
    // spyVal, spxVal, spxDirectActive, effectiveRatio below).

    // IV — sourced from `useIvInputs` (spread below alongside its
    // debounced copies dVix/dIV/dMult).

    // Time — sourced from `useTimeInputs` (spread below).

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

    // Hedge
    breakevenTarget,
    setBreakevenTarget,

    // BWB
    showBWB,
    setShowBWB,
    bwbNarrowWidth,
    setBwbNarrowWidth,
    bwbWideMultiplier,
    setBwbWideMultiplier,

    // Portfolio risk gate (FE-STATE-006)
    portfolioRiskThresholdPct,
    setPortfolioRiskThresholdPct,

    // IV inputs + their debounced copies (ivMode, vixInput,
    // multiplier, directIVInput + dVix, dIV, dMult).
    ...ivInputs,

    // Time inputs (timeHour, timeMinute, timeAmPm, timezone + setters).
    ...timeInputs,

    // Spot inputs + their debounced/derived values (spotPrice,
    // setSpotPrice, spxDirect, setSpxDirect, spxRatio, setSpxRatio,
    // dSpot, dSpx, spyVal, spxVal, spxDirectActive, effectiveRatio).
    ...spotInputs,
  };
}

export type AppState = ReturnType<typeof useAppState>;
