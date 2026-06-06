/**
 * useStickyUnion — absolute "never-vanish" accumulator for alert feeds.
 *
 * Once an item appears in the server response it stays in the returned
 * list FOREVER for the life of a `storageKey`, even if later responses
 * omit it. This backstops the Lottery Finder / Silent Boom feeds, where
 * a row that briefly drops out of a snapshot must not visually vanish.
 *
 * Semantics
 * ---------
 * - UPSERT every incoming item keyed by `key(item)`: insert if new,
 *   REPLACE the stored value with the latest one if the key already
 *   exists (so live fields like % gain stay fresh).
 * - PIN: keys already in the union but absent from `items` are kept with
 *   their last-seen value. Nothing is ever deleted.
 * - Order is deterministic: previously-seen keys hold their original
 *   insertion position (with refreshed values), brand-new keys append.
 *   The caller re-sorts, so only stability matters.
 *
 * Persistence
 * -----------
 * Keyed by `storageKey`. On mount and whenever `storageKey` changes the
 * in-memory union RESETS and rehydrates from `localStorage[storageKey]`
 * (a JSON array of T; absent/malformed → empty). Every upsert persists
 * the union back. A new `storageKey` (e.g. a new trading day) therefore
 * starts a fresh union while the old key's entry is left untouched.
 *
 * Resilience
 * ----------
 * All `window` / `localStorage` access is feature-checked and wrapped in
 * try/catch — SSR, private mode, quota-exceeded, and corrupt JSON degrade
 * to in-memory-only behaviour rather than throwing.
 *
 * Render safety
 * -------------
 * The union map lives in a ref; the returned array is held in state and
 * only replaced with a fresh array when the ingest/reset effects actually
 * change the union. Those effects fire only on `items` / `storageKey`
 * changes, so a stable `items` reference cannot drive a re-render loop.
 */

import { useEffect, useRef, useState } from 'react';

export interface UseStickyUnionOptions<T> {
  /** Stable identity for an item. Two items with the same key are "the same". */
  key: (item: T) => string;
  /** localStorage slot; changing it resets + rehydrates the union. */
  storageKey: string;
}

function isStorageAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof globalThis.localStorage !== 'undefined'
  );
}

/** Read + parse a JSON array of T from a slot. Never throws. */
function readUnion<T>(storageKey: string): Map<string, T> {
  const map = new Map<string, T>();
  if (!isStorageAvailable()) return map;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw == null) return map;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return map;
    // We persisted [key, value] pairs to preserve insertion order AND
    // the caller's key without re-deriving it (the key fn identity may
    // change across mounts; the stored key is authoritative).
    for (const entry of parsed) {
      if (
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string'
      ) {
        map.set(entry[0], entry[1] as T);
      }
    }
    return map;
  } catch {
    return map;
  }
}

/** Best-effort persist of the union as a JSON array of [key, value] pairs. */
function writeUnion<T>(storageKey: string, union: Map<string, T>): void {
  if (!isStorageAvailable()) return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify([...union]));
  } catch {
    // Quota / private mode / disabled storage — degrade to in-memory only.
  }
}

export function useStickyUnion<T>(
  items: T[],
  opts: UseStickyUnionOptions<T>,
): T[] {
  const { key, storageKey } = opts;

  // The accumulator. Insertion order is the Map's own iteration order.
  const unionRef = useRef<Map<string, T>>(new Map());
  // Slot the unionRef currently reflects — guards against a stale ref
  // when storageKey changes between the reset effect and an ingest.
  const loadedKeyRef = useRef<string | null>(null);
  // Latest key fn without re-triggering the ingest effect on identity change.
  const keyFnRef = useRef(key);
  keyFnRef.current = key;

  // The returned snapshot lives in state so React re-renders when the
  // union grows/updates. We only ever set it to a NEW array when content
  // actually changed, so a stable `items` reference cannot drive a loop.
  const [snapshot, setSnapshot] = useState<T[]>([]);

  // Reset + hydrate whenever the slot changes. Runs before the ingest
  // effect below on the same commit, so ingest sees the fresh union.
  useEffect(() => {
    const union = readUnion<T>(storageKey);
    unionRef.current = union;
    loadedKeyRef.current = storageKey;
    setSnapshot([...union.values()]);
  }, [storageKey]);

  // Ingest `items`: upsert each, pin the rest, persist + re-snapshot if
  // anything moved.
  useEffect(() => {
    // If the slot changed but the reset effect hasn't run yet this commit,
    // rehydrate now so we never upsert into the previous day's union.
    if (loadedKeyRef.current !== storageKey) {
      unionRef.current = readUnion<T>(storageKey);
      loadedKeyRef.current = storageKey;
    }

    const union = unionRef.current;
    const keyFn = keyFnRef.current;

    if (items.length === 0) return;

    for (const item of items) {
      // UPSERT: always overwrite so live fields refresh. Map.set on an
      // existing key keeps its original insertion position.
      union.set(keyFn(item), item);
    }

    writeUnion(storageKey, union);
    setSnapshot([...union.values()]);
  }, [items, storageKey]);

  return snapshot;
}
