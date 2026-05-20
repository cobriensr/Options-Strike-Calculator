/**
 * useIvInputs — implied-volatility input state.
 *
 * Owns:
 *   - `ivMode` ('vix' or 'direct') — picks which input drives IV
 *   - `vixInput` text input (default '19') — used when ivMode is 'vix'
 *   - `multiplier` text input — premium-factor multiplier on top of VIX
 *   - `directIVInput` text input — used when ivMode is 'direct'
 *   - Debounced copies of the three text inputs (`dVix`, `dIV`,
 *     `dMult`) so downstream calculators don't recompute on every
 *     keystroke
 *
 * Extracted from useAppState in Phase 2P-1c.
 * Spec: docs/superpowers/specs/frontend-cleanup-tiers-1-2-3-2026-05-18.md (Phase 2P)
 */

import { useState, type Dispatch, type SetStateAction } from 'react';

import { DEFAULTS, IV_MODES } from '../constants/index.js';
import type { IVMode } from '../types/index.js';
import { useDebounced } from './useDebounced.js';

export interface UseIvInputsReturn {
  ivMode: IVMode;
  setIvMode: Dispatch<SetStateAction<IVMode>>;
  /** Raw VIX text input. */
  vixInput: string;
  setVixInput: Dispatch<SetStateAction<string>>;
  /** Premium-factor multiplier text input. */
  multiplier: string;
  setMultiplier: Dispatch<SetStateAction<string>>;
  /** Direct IV text input (used when ivMode === 'direct'). */
  directIVInput: string;
  setDirectIVInput: Dispatch<SetStateAction<string>>;
  /** Debounced vixInput. */
  dVix: string;
  /** Debounced directIVInput. */
  dIV: string;
  /** Debounced multiplier. */
  dMult: string;
}

export function useIvInputs(): UseIvInputsReturn {
  // Seeded with default VIX so term structure + regime cards render
  // immediately on first paint; overwritten by live/historical data
  // via useAutoFill on load.
  const [ivMode, setIvMode] = useState<IVMode>(IV_MODES.VIX);
  const [vixInput, setVixInput] = useState('19');
  const [multiplier, setMultiplier] = useState(
    String(DEFAULTS.IV_PREMIUM_FACTOR),
  );
  const [directIVInput, setDirectIVInput] = useState('');

  const dVix = useDebounced(vixInput);
  const dIV = useDebounced(directIVInput);
  const dMult = useDebounced(multiplier);

  return {
    ivMode,
    setIvMode,
    vixInput,
    setVixInput,
    multiplier,
    setMultiplier,
    directIVInput,
    setDirectIVInput,
    dVix,
    dIV,
    dMult,
  };
}
