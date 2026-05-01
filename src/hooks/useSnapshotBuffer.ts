/**
 * useSnapshotBuffer — rolling per-strike snapshot ring-buffer feeding the
 * 5m Δ% map and price-trend signals consumed by the FuturesGammaPlaybook
 * flow rules.
 *
 * Mirrors the buffer in `GexLandscape/index.tsx:95-252`. The buffer is
 * held in a ref (no re-render on append); the derived 5m Δ% map and
 * price-trend are held in state and refreshed inside the snapshot-arrival
 * effect. A pruning cutoff of `SNAPSHOT_BUFFER_MS` bounds memory regardless
 * of how long the session runs.
 *
 * Forward-scrub semantics: when the user steps to a later snapshot
 * (T₁ → T₂ where T₂ > T₁) we keep snapshots in [T₁, T₂) — they're valid
 * history at T₂ — but the consumed history slice is `< now` so a
 * post-`now` snapshot from prior live accumulation never compares against
 * a "future" snapshot.
 *
 * Date-change resets: when `selectedDate` flips, the buffer empties and
 * the derived state collapses to neutral. The prior session's prints are
 * irrelevant to today's Δ% and would otherwise leak across the seam.
 */

import { useEffect, useRef, useState } from 'react';
import {
  computeDeltaMap,
  computePriceTrend,
  findClosestSnapshot,
} from '../components/GexLandscape/deltas';
import type {
  PriceTrend,
  Snapshot,
} from '../components/GexLandscape/types';
import type { GexStrikeLevel } from './useGexPerStrike';

/** Snapshot ring-buffer horizon for Δ% and smoothing windows. */
const SNAPSHOT_BUFFER_MS = 10 * 60 * 1000;
/** Lookback for the 5m Δ% window used by wall-flow trends. */
const DELTA_5M_LOOKBACK_MS = 5 * 60 * 1000;
/** Max wall-clock skew allowed when matching a buffered snapshot to a 5m target. */
const DELTA_5M_MATCH_TOLERANCE_MS = 2 * 60 * 1000;

export interface WindowSnapshotInput {
  timestamp: string;
  strikes: GexStrikeLevel[];
}

export interface UseSnapshotBufferInput {
  /** Current snapshot timestamp (ISO string). Null clears flow state. */
  timestamp: string | null;
  /** Current snapshot's per-strike levels. Empty array clears flow state. */
  strikes: GexStrikeLevel[];
  /** Server-returned 5-min window of prior snapshots (seeds the buffer in scrub mode). */
  windowSnapshots: WindowSnapshotInput[];
  /** ET trading date (YYYY-MM-DD). Date change clears the buffer. */
  selectedDate: string;
}

export interface UseSnapshotBufferReturn {
  /** Map<strike, Δ% over the last 5m> derived from the most recent buffer state. */
  delta5mMap: Map<number, number | null>;
  /** Direction + consistency of the price tape over the buffer horizon. */
  priceTrend: PriceTrend | null;
}

/**
 * Maintain a 10-min ring buffer of per-strike snapshots and derive the
 * downstream 5m Δ% map + priceTrend used by the flow rules.
 */
export function useSnapshotBuffer(
  input: UseSnapshotBufferInput,
): UseSnapshotBufferReturn {
  const { timestamp, strikes, windowSnapshots, selectedDate } = input;

  const snapshotBufferRef = useRef<Snapshot[]>([]);
  const [delta5mMap, setDelta5mMap] = useState<Map<number, number | null>>(
    new Map(),
  );
  const [priceTrend, setPriceTrend] = useState<PriceTrend | null>(null);

  // Date change: drop the buffer and reset derived state.
  useEffect(() => {
    snapshotBufferRef.current = [];
    setDelta5mMap(new Map());
    setPriceTrend(null);
  }, [selectedDate]);

  useEffect(() => {
    // Empty snapshot (endpoint returned `strikes: []`, e.g. pre-open or a
    // day with no data yet): don't just bail — also clear downstream flow
    // state. Without this, a prior session's `delta5mMap` / `priceTrend`
    // stay visible across the empty render and `WallFlowStrip` shows
    // stale values with no hint they're stale.
    if (!timestamp || strikes.length === 0) {
      // Functional setters so we don't depend on current state values
      // (which would create an effect-loop — the effect sets these values).
      setDelta5mMap((prev) => (prev.size === 0 ? prev : new Map()));
      setPriceTrend((prev) => (prev === null ? prev : null));
      return;
    }
    const now = new Date(timestamp).getTime();
    if (!Number.isFinite(now)) return;
    if (snapshotBufferRef.current.at(-1)?.ts === now) return;

    // Seed the buffer with any server-returned windowSnapshots (each is a
    // per-strike snapshot from within the last 5 min before `now`). Then
    // prune anything older than the buffer horizon. In live mode this is
    // additive — we already have a rolling buffer. In scrub mode the
    // buffer was empty (or stale) and this is the only path that feeds it.
    //
    // Window snapshots with a bad timestamp get dropped (the `.filter`),
    // but we log a warning so a data-quality regression upstream surfaces
    // rather than manifesting as a silently-degraded 5m Δ%.
    const windowEntries: Snapshot[] = [];
    for (const snap of windowSnapshots) {
      const ts = new Date(snap.timestamp).getTime();
      if (Number.isFinite(ts)) {
        windowEntries.push({ strikes: snap.strikes, ts });
      } else if (typeof console !== 'undefined') {
        console.warn(
          'useSnapshotBuffer: dropping window snapshot with invalid timestamp',
          snap.timestamp,
        );
      }
    }

    // Merge existing buffer with newly arrived window entries, de-duplicated
    // by timestamp (retain the existing entry — it's authoritative). Then
    // prune pre-horizon entries only. We intentionally DO NOT prune
    // post-`now` entries: on a forward scrub (T₁ → T₂ where T₂ > T₁),
    // snapshots in [T₁, T₂) are valid history at T₂ and must survive.
    // The `< now` filter is applied downstream at consumption time (in the
    // findClosestSnapshot call below and inside `computePriceTrend`).
    const existing = snapshotBufferRef.current;
    const existingTs = new Set(existing.map((s) => s.ts));
    const merged: Snapshot[] = [
      ...existing,
      ...windowEntries.filter((s) => !existingTs.has(s.ts)),
    ];
    const cutoff = now - SNAPSHOT_BUFFER_MS;
    const buf = merged
      .filter((snap) => snap.ts >= cutoff)
      .sort((a, b) => a.ts - b.ts);

    // Historical slice for Δ% and priceTrend — explicitly excludes any
    // snapshots at or after `now` so a forward-scrub doesn't compare
    // current against a future snapshot. The full `buf` (including any
    // post-now entries from prior live-mode accumulation) is what we
    // persist; the history view is a read-only slice.
    const history = buf.filter((snap) => snap.ts < now);

    const snap5m = findClosestSnapshot(
      history,
      now - DELTA_5M_LOOKBACK_MS,
      DELTA_5M_MATCH_TOLERANCE_MS,
    );
    setDelta5mMap(
      snap5m ? computeDeltaMap(strikes, snap5m.strikes) : new Map(),
    );

    // Append current snapshot to the persistent buffer, then compute
    // priceTrend against the historical slice + current.
    buf.push({ strikes, ts: now });
    snapshotBufferRef.current = buf;

    const spot = strikes[0]?.price ?? 0;
    setPriceTrend(
      computePriceTrend(spot, [...history, { strikes, ts: now }], now),
    );
  }, [strikes, timestamp, windowSnapshots]);

  return { delta5mMap, priceTrend };
}
