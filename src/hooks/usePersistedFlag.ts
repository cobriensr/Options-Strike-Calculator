import { useCallback, useState } from 'react';

/**
 * Boolean flag persisted to localStorage ('1' / '0'). Storage failures
 * (private mode, quota) degrade to in-memory state for the session.
 *
 * To reset a persisted flag manually:
 * `localStorage.removeItem('<key>')` in devtools.
 */
export function usePersistedFlag(key: string): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });

  const set = useCallback(
    (v: boolean) => {
      try {
        localStorage.setItem(key, v ? '1' : '0');
      } catch {
        // localStorage unavailable — keep in-memory value only.
      }
      setValue(v);
    },
    [key],
  );

  return [value, set];
}
