/**
 * usePersistedState — React state that mirrors itself to localStorage.
 *
 * Drop-in replacement for the recurring SilentBoom / LotteryFinder /
 * GexLandscape pattern of `useState(() => readLS(key, default))`
 * paired with a one-line `useEffect(() => writeLS(key, value))`. The
 * extracted hook collapses both into a single dependency-free call
 * and centralizes the SSR / quota / parse-failure paths.
 *
 * Storage encoding defaults to JSON (round-trips strings, numbers,
 * booleans, objects, arrays). Existing call sites that wrote bespoke
 * encodings — bool-as-'0'/'1', numbers via `String(n)`, enum-string
 * values with no quoting — pass `parse` / `serialize` to keep their
 * localStorage payload byte-identical, so a one-line migration does
 * not invalidate users' saved filter state.
 *
 * Failure mode: any thrown error during read (corrupt JSON, quota,
 * disabled storage, custom-parse rejection) falls back to
 * `defaultValue`. Writes are best-effort and swallow exceptions —
 * private-mode browsers throw on `setItem` and we'd rather lose
 * persistence than crash the component.
 *
 * Spec: docs/superpowers/specs/frontend-cleanup-tiers-1-2-3-2026-05-18.md (Phase 2A)
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

export interface UsePersistedStateOptions<T> {
  /**
   * Convert the raw localStorage string back into a `T`. Default is
   * `JSON.parse`. May throw — exceptions are caught and the hook
   * falls back to `defaultValue`.
   *
   * Returning `undefined` ALSO triggers the fallback, which lets a
   * custom parser reject malformed but well-formed-JSON values
   * (e.g. enum strings outside the allowed set) without throwing.
   */
  parse?: (raw: string) => T | undefined;
  /**
   * Convert a `T` into the string written to localStorage. Default
   * is `JSON.stringify`. May return `null` to remove the key
   * entirely (useful when a `null` state should clear the slot
   * rather than persist `"null"`).
   */
  serialize?: (value: T) => string | null;
}

function isStorageAvailable(): boolean {
  return (
    typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
  );
}

function defaultParse<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function defaultSerialize<T>(value: T): string {
  return JSON.stringify(value);
}

export function usePersistedState<T>(
  key: string,
  defaultValue: T | (() => T),
  options: UsePersistedStateOptions<T> = {},
): [T, Dispatch<SetStateAction<T>>] {
  // Stash parse/serialize in a ref so callers can pass inline
  // functions without retriggering the write effect on every render.
  const optsRef = useRef(options);
  optsRef.current = options;

  const [value, setValue] = useState<T>(() => {
    // Matches React's useState lazy-initializer contract — callers
    // pass a thunk when computing the default is expensive (e.g.
    // reads from a legacy localStorage key for a one-time migration).
    const resolveDefault = (): T =>
      typeof defaultValue === 'function'
        ? (defaultValue as () => T)()
        : defaultValue;
    if (!isStorageAvailable()) return resolveDefault();
    try {
      const raw = window.localStorage.getItem(key);
      if (raw == null) return resolveDefault();
      const parse = options.parse ?? defaultParse<T>;
      const parsed = parse(raw);
      return parsed === undefined ? resolveDefault() : parsed;
    } catch {
      return resolveDefault();
    }
  });

  // Track the last value we wrote so we can skip the round-trip
  // when the consumer re-sets the same value (e.g. derived state
  // recomputed to the existing value). Cheap dedupe vs. a setItem
  // per render. Initialized to undefined so the first commit
  // always writes — distinguishing "never written" from "wrote
  // null" requires this sentinel rather than just checking `=== value`.
  const lastWrittenRef = useRef<T | undefined>(undefined);

  useEffect(() => {
    if (!isStorageAvailable()) return;
    if (lastWrittenRef.current === value) return;
    lastWrittenRef.current = value;
    try {
      const serialize = optsRef.current.serialize ?? defaultSerialize<T>;
      const serialized = serialize(value);
      if (serialized === null) {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(key, serialized);
      }
    } catch {
      // Quota exceeded, private mode, or storage disabled. Best-effort
      // persistence — drop the write rather than crash the component.
    }
  }, [key, value]);

  // Stable setter identity matches `useState`'s contract — consumers
  // can pass `setValue` to effect deps without retriggering.
  const setter = useCallback<Dispatch<SetStateAction<T>>>((updater) => {
    setValue(updater);
  }, []);

  return [value, setter];
}
