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
 *   their last-seen value. Nothing is ever deleted EXCEPT keys listed in
 *   `tombstones` (the only deletion path — for genuinely-retracted rows).
 * - Order is deterministic: previously-seen keys hold their original
 *   insertion position (with refreshed values), brand-new keys append.
 *   The caller re-sorts, so only stability matters.
 *
 * Guards
 * ------
 * - Items whose `key(item)` is falsy/empty or carries a literal
 *   `undefined`/`null` key segment are SKIPPED, never upserted — a
 *   degenerate key would otherwise clobber a distinct row.
 * - The union is capped at `MAX_UNION_ENTRIES`; if exceeded, the OLDEST
 *   entries (Map insertion order) are evicted. A day's distinct chains
 *   are far below the cap, so this only guards pathological growth/quota.
 *
 * Persistence
 * -----------
 * Keyed by `storageKey`. On mount and whenever `storageKey` changes the
 * in-memory union RESETS and rehydrates from `localStorage[storageKey]`
 * (a JSON array of [key, value] pairs; absent/malformed → empty). The
 * durable write is DEBOUNCED (`PERSIST_DEBOUNCE_MS`): the in-memory union
 * and returned snapshot update synchronously, only the localStorage write
 * lags and coalesces. A new `storageKey` (e.g. a new trading day) starts a
 * fresh union; a one-time mount sweep removes stale same-feed slots.
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
 * only replaced with a fresh array when an ingest actually CHANGES the
 * union (tracked by a per-item dirty check, O(incoming) not O(union)).
 * Those effects fire only on `items` / `storageKey` changes, so a stable
 * `items` reference cannot drive a re-render loop.
 */

import { useEffect, useRef, useState } from 'react';

export interface UseStickyUnionOptions<T> {
  /** Stable identity for an item. Two items with the same key are "the same". */
  key: (item: T) => string;
  /** localStorage slot; changing it resets + rehydrates the union. */
  storageKey: string;
  /**
   * Keys that have been genuinely retracted. Any key here is not ingested
   * and is removed from the union (and the persisted blob) if present. This
   * is the ONLY deletion path — absent keys still pin forever.
   */
  tombstones?: ReadonlySet<string>;
}

/** Defensive cap on union size; oldest entries evicted past this. */
const MAX_UNION_ENTRIES = 2000;
/** Trailing-debounce window for the durable localStorage write. */
const PERSIST_DEBOUNCE_MS = 1000;
/** Prefix all day-scoped feed slots share, used by the stale-key sweep. */
const FEED_UNION_PREFIX = 'feed-union:';

function isStorageAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof globalThis.localStorage !== 'undefined'
  );
}

/**
 * A key is degenerate (must be skipped) when it is falsy/empty or when any
 * `|`-delimited segment is the literal string `undefined`/`null` — these
 * arise from `${maybeUndefined}` template interpolation and would silently
 * collide distinct rows onto one slot.
 */
function isDegenerateKey(k: string): boolean {
  if (!k) return true;
  return k
    .split('|')
    .some((seg) => seg === 'undefined' || seg === 'null' || seg === '');
}

/** Read + parse a JSON array of [key, value] pairs from a slot. Never throws. */
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

/** Best-effort persist of an already-serialized union string. */
function persistUnion(storageKey: string, serialized: string): void {
  if (!isStorageAvailable()) return;
  try {
    window.localStorage.setItem(storageKey, serialized);
  } catch {
    // Quota / private mode / disabled storage — degrade to in-memory only.
  }
}

/**
 * Derive the shared prefix for a feed's day-scoped slots from a storageKey
 * of the form `feed-union:<feed>:<date>`. Returns everything up to and
 * including the `<feed>:` segment (e.g. `feed-union:lottery:`). Returns
 * `null` when `storageKey` does not match the scheme (sweep is then a no-op).
 */
function deriveKeyPrefix(storageKey: string): string | null {
  if (!storageKey.startsWith(FEED_UNION_PREFIX)) return null;
  const lastColon = storageKey.lastIndexOf(':');
  // Need a colon strictly after the prefix so a `<feed>` segment exists.
  if (lastColon < FEED_UNION_PREFIX.length) return null;
  return storageKey.slice(0, lastColon + 1);
}

/**
 * One-time mount sweep: delete every localStorage slot that shares the
 * current feed prefix but is NOT the current storageKey (stale prior days).
 * Bounded, guarded, best-effort. Same-prefix-different-date keys are the
 * only ones touched; other feeds and unrelated keys survive.
 */
function sweepStaleKeys(storageKey: string): void {
  if (!isStorageAvailable()) return;
  const prefix = deriveKeyPrefix(storageKey);
  if (prefix == null) return;
  try {
    const ls = window.localStorage;
    const toDelete: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k == null) continue;
      if (k.startsWith(prefix) && k !== storageKey) toDelete.push(k);
    }
    for (const k of toDelete) ls.removeItem(k);
  } catch {
    // Storage iteration/removal failed — leave slots as-is.
  }
}

/** Evict oldest entries (Map insertion order) until at most cap remain. */
function enforceCap<T>(union: Map<string, T>): void {
  if (union.size <= MAX_UNION_ENTRIES) return;
  const overflow = union.size - MAX_UNION_ENTRIES;
  const iter = union.keys();
  for (let i = 0; i < overflow; i++) {
    const oldest = iter.next().value;
    if (oldest === undefined) break;
    union.delete(oldest);
  }
}

export function useStickyUnion<T>(
  items: T[],
  opts: UseStickyUnionOptions<T>,
): T[] {
  const { key, storageKey, tombstones } = opts;

  // The accumulator. Insertion order is the Map's own iteration order.
  const unionRef = useRef<Map<string, T>>(new Map());
  // Latest key fn without re-triggering the ingest effect on identity change.
  const keyFnRef = useRef(key);
  keyFnRef.current = key;
  // Latest tombstones without widening the ingest effect's dep surface; the
  // effect already re-runs on `items`, which is what carries new retractions.
  const tombstonesRef = useRef<ReadonlySet<string> | undefined>(tombstones);
  tombstonesRef.current = tombstones;

  // Pending debounced-persist timer + the storageKey/payload it will write.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPersistRef = useRef<{
    storageKey: string;
    payload: string;
  } | null>(null);

  // The returned snapshot lives in state so React re-renders when the
  // union grows/updates. We only ever set it to a NEW array when content
  // actually changed, so a stable `items` reference cannot drive a loop.
  const [snapshot, setSnapshot] = useState<T[]>([]);

  // Flush any pending debounced write immediately (used on slot change +
  // unmount). Clears the timer and writes the staged payload synchronously.
  const flushPersist = (): void => {
    if (persistTimerRef.current != null) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    const pending = pendingPersistRef.current;
    if (pending != null) {
      pendingPersistRef.current = null;
      persistUnion(pending.storageKey, pending.payload);
    }
  };

  // Stage a debounced write: snapshot the payload now, write at most once
  // per PERSIST_DEBOUNCE_MS (trailing edge). Rapid ingests coalesce into one.
  const schedulePersist = (slot: string, payload: string): void => {
    pendingPersistRef.current = { storageKey: slot, payload };
    if (persistTimerRef.current != null) return; // a trailing write is queued
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      const pending = pendingPersistRef.current;
      if (pending == null) return;
      pendingPersistRef.current = null;
      persistUnion(pending.storageKey, pending.payload);
    }, PERSIST_DEBOUNCE_MS);
  };

  // One-time stale-key sweep on first mount (bounded cleanup of prior days).
  useEffect(() => {
    sweepStaleKeys(storageKey);
    // Intentionally mount-only: re-sweeping on every storageKey change would
    // be redundant (a new day's reset already replaces the union) and the
    // initial mount key is representative of the feed prefix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset + hydrate whenever the slot changes. Runs before the ingest
  // effect below on the same commit, so ingest sees the fresh union. Any
  // pending write for the OLD slot is flushed first so it isn't lost.
  useEffect(() => {
    flushPersist();
    const union = readUnion<T>(storageKey);
    unionRef.current = union;
    setSnapshot([...union.values()]);
  }, [storageKey]);

  // Ingest `items`: upsert each (skipping degenerate/tombstoned keys), pin
  // the rest, evict tombstones, then persist + re-snapshot ONLY when the
  // union actually changed.
  //
  // CRITICAL loop guard: callers routinely pass a fresh `items` array on
  // every render (e.g. `unionEngaged ? memoizedFires : []` — the `[]`
  // branch is a new reference each render). The effect deps therefore fire
  // on every render. We track a per-item `dirty` flag during the upsert
  // loop (O(incoming), not O(union)): a write is dirty when the key is new
  // OR its serialized value differs from the stored one. Only when `dirty`
  // is true do we re-snapshot + (debounced) persist, so an identical-content
  // ingest from a brand-new array reference is a true no-op — breaking the
  // loop while still refreshing live fields the instant any value changes.
  useEffect(() => {
    const union = unionRef.current;
    const keyFn = keyFnRef.current;
    const tombs = tombstonesRef.current;

    let dirty = false;

    // Evict any tombstoned keys already present (the only deletion path).
    if (tombs != null && tombs.size > 0) {
      for (const t of tombs) {
        if (union.delete(t)) dirty = true;
      }
    }

    for (const item of items) {
      const k = keyFn(item);
      if (isDegenerateKey(k)) continue; // #9: never clobber a distinct row
      if (tombs?.has(k)) continue; // #6: retracted — do not re-ingest

      const prev = union.get(k);
      // Per-item dirty check: new key, or value changed. Cheap stringify of
      // the single item, not the whole union.
      if (prev === undefined || JSON.stringify(prev) !== JSON.stringify(item)) {
        union.set(k, item);
        dirty = true;
      }
    }

    if (!dirty) return; // no-op ingest: skip state update + persist

    enforceCap(union); // #7: bound pathological growth (post-mutation)

    schedulePersist(storageKey, JSON.stringify([...union]));
    setSnapshot([...union.values()]);
  }, [items, storageKey, tombstones]);

  // Flush any pending debounced write on unmount so a final ingest is not
  // lost when the component tears down before the timer fires.
  useEffect(() => {
    return () => {
      flushPersist();
    };
  }, []);

  return snapshot;
}
