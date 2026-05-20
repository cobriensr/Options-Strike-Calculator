/**
 * useTheme — dark-mode preference persisted to localStorage.
 *
 * Extracted from useAppState in Phase 2P-1a. Wraps `usePersistedState`
 * so the LS encoding (`'true'` / `'false'` strings, matching the
 * legacy key `'darkMode'`) is preserved exactly — users' saved
 * preference survives the refactor.
 *
 * Spec: docs/superpowers/specs/frontend-cleanup-tiers-1-2-3-2026-05-18.md (Phase 2P)
 */

import { useCallback } from 'react';

import {
  usePersistedState,
  type UsePersistedStateOptions,
} from './usePersistedState.js';

const DARK_MODE_KEY = 'darkMode';

// Legacy encoding: `'true'` / `'false'` written by the original
// `localStorage.setItem('darkMode', String(value))` in useAppState.
const darkModePersistOpts: UsePersistedStateOptions<boolean> = {
  parse: (raw) => raw === 'true',
  serialize: (v) => String(v),
};

export interface UseThemeReturn {
  /** Whether dark mode is active. Defaults to `true` for first-time visitors. */
  darkMode: boolean;
  /** Setter; the value is persisted to localStorage on change. */
  setDarkMode: (value: boolean) => void;
}

export function useTheme(): UseThemeReturn {
  const [darkMode, rawSetDarkMode] = usePersistedState<boolean>(
    DARK_MODE_KEY,
    true,
    darkModePersistOpts,
  );

  // Tighten the setter contract to `(value: boolean) => void` so call
  // sites match useAppState's original public signature exactly. The
  // updater form (rawSetDarkMode((prev) => !prev)) stays available
  // through `setDarkMode((d) => !d)` thanks to the cast in
  // usePersistedState — but consumers historically only used the
  // value-setter form, so the tighter type avoids API drift.
  const setDarkMode = useCallback(
    (value: boolean) => rawSetDarkMode(value),
    [rawSetDarkMode],
  );

  return { darkMode, setDarkMode };
}
