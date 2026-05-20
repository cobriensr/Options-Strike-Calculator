/**
 * useSpotInputs — SPY spot price, SPX direct input, manual ratio,
 * and the derived effective-ratio + parsed numeric values.
 *
 * Extracted from useAppState in Phase 2P-1b. Owns:
 *   - `spotPrice` / `spxDirect` text inputs (string state to allow
 *     in-flight edits like "5.")
 *   - `spxRatio` numeric override (used when no SPX direct value
 *     is present)
 *   - Debounced copies (`dSpot`, `dSpx`) so downstream calculators
 *     don't recompute on every keystroke
 *   - Derived numerics (`spyVal`, `spxVal`, `spxDirectActive`,
 *     `effectiveRatio`) memoized against the debounced inputs only
 *
 * Spec: docs/superpowers/specs/frontend-cleanup-tiers-1-2-3-2026-05-18.md (Phase 2P)
 */

import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';

import { useDebounced } from './useDebounced.js';

export interface UseSpotInputsReturn {
  /** Raw SPY spot price text input (default '572'). */
  spotPrice: string;
  setSpotPrice: Dispatch<SetStateAction<string>>;
  /** Raw SPX direct value text input (default '5720'). */
  spxDirect: string;
  setSpxDirect: Dispatch<SetStateAction<string>>;
  /** Manual SPX/SPY multiplier used when no SPX direct value is set. */
  spxRatio: number;
  setSpxRatio: Dispatch<SetStateAction<number>>;
  /** Debounced spotPrice — feeds the derived numeric values + downstream consumers. */
  dSpot: string;
  /** Debounced spxDirect — same. */
  dSpx: string;
  /** Parsed SPY value (NaN if the input isn't numeric). */
  spyVal: number;
  /** Parsed SPX value (NaN if the input isn't numeric). */
  spxVal: number;
  /** True when the SPX direct input is populated and both spy + spx parse to positive numbers. */
  spxDirectActive: boolean;
  /** Either the spxVal/spyVal quotient (when spxDirectActive) or the manual `spxRatio`. */
  effectiveRatio: number;
}

export function useSpotInputs(): UseSpotInputsReturn {
  // Seeded with reasonable defaults so UI renders fully on first
  // paint; overwritten by live/historical data via useAutoFill on load.
  const [spotPrice, setSpotPrice] = useState('572');
  const [spxDirect, setSpxDirect] = useState('5720');
  const [spxRatio, setSpxRatio] = useState(10);

  const dSpot = useDebounced(spotPrice);
  const dSpx = useDebounced(spxDirect);

  // Derived SPX ratio — memoized against its true dependencies only so
  // unrelated state changes (theme, time, IC settings) don't re-compute.
  const derived = useMemo(() => {
    const spyVal = Number.parseFloat(dSpot);
    const spxVal = Number.parseFloat(dSpx);
    const spxDirectActive =
      !!dSpx &&
      !Number.isNaN(spxVal) &&
      spxVal > 0 &&
      !Number.isNaN(spyVal) &&
      spyVal > 0;
    const effectiveRatio = spxDirectActive ? spxVal / spyVal : spxRatio;
    return { spyVal, spxVal, spxDirectActive, effectiveRatio };
  }, [dSpot, dSpx, spxRatio]);

  return {
    spotPrice,
    setSpotPrice,
    spxDirect,
    setSpxDirect,
    spxRatio,
    setSpxRatio,
    dSpot,
    dSpx,
    ...derived,
  };
}
