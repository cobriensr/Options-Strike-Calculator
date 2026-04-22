/**
 * useTopStrikesTracker — tracks the Top 5 GEX strike composition across
 * snapshots, surfacing when the SET changes (a new strike enters and an
 * old one leaves) and which strike has been in Top 5 the longest this
 * session.
 *
 * The Top 5 list is recomputed each 60s poll by sorting all strikes on
 * |netGamma|. Rank shuffles within the existing five are noise; a
 * membership change is the real signal — dealers are repositioning and
 * the walls the trader has been watching just shifted. This hook fires
 * a single short chime on each membership change so attention can be
 * redirected without the trader staring at the panel.
 *
 * Behavior:
 *   - Records first-seen snapshot timestamp per strike in a ref.
 *   - Skips the chime on the first observed snapshot (no baseline to
 *     compare against, otherwise every page load would ding).
 *   - Honors `muted` and `isLive` — historical scrubbing never chimes.
 *   - Resets all state when `resetKey` changes (pass `selectedDate` so
 *     scrubbing to a different day starts fresh).
 *   - Returns `justEntered` (strikes added this tick, for NEW pills) and
 *     `oldestStrike` (min-firstSeenAt, for the ANCHOR pill). Both are
 *     null / empty when the set is still at its session baseline — a
 *     single distinct "oldest" only surfaces once drift has occurred.
 */

import { useEffect, useRef, useState } from 'react';
import type { GexStrikeLevel } from './useGexPerStrike.js';

export interface UseTopStrikesTrackerInput {
  /** Current Top 5 (caller computes; order doesn't matter for this hook). */
  topFive: GexStrikeLevel[];
  /** ISO timestamp of the active snapshot. */
  timestamp: string | null;
  /** False during historical scrub — suppresses the chime. */
  isLive: boolean;
  /** When true, the chime never fires. */
  muted: boolean;
  /** When this value changes, firstSeen / prevSet tracking is cleared. */
  resetKey?: string;
}

export interface UseTopStrikesTrackerReturn {
  /** Strikes added to Top 5 on the most recent tick. Empty on baseline. */
  justEntered: Set<number>;
  /** Strike with the earliest firstSeenAt; null until drift occurs. */
  oldestStrike: number | null;
}

// Exported for tests that need to verify empty-state equality. Never mutate.
export const EMPTY_JUST_ENTERED: ReadonlySet<number> = new Set();

/**
 * Two-note ding-dong chime — distinct from the futures-playbook single
 * tones (660/880/1040Hz) so the trader can tell "Top 5 changed" apart
 * from regime/level/trigger alerts. Uses B5 → E6 (988Hz → 1318Hz),
 * bright enough to cut through trading-floor ambience.
 */
function playTopStrikeChime(): void {
  try {
    if (typeof window === 'undefined') return;
    type AudioCtor = typeof AudioContext;
    const AC: AudioCtor | undefined =
      (window as unknown as { AudioContext?: AudioCtor }).AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioCtor })
        .webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.value = 0.08;
    osc.frequency.setValueAtTime(988, ctx.currentTime);
    osc.frequency.setValueAtTime(1318, ctx.currentTime + 0.15);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
    // Let the browser GC the context after the oscillator stops. We
    // intentionally don't schedule ctx.close() — orphaned timers can
    // hang test workers, and the hardware release delay is imperceptible
    // for a 300ms sine tone.
  } catch {
    // Autoplay blocked / unsupported API / suspended context — silent.
  }
}

export function useTopStrikesTracker(
  input: UseTopStrikesTrackerInput,
): UseTopStrikesTrackerReturn {
  const { topFive, timestamp, isLive, muted, resetKey } = input;

  // strike → ms of snapshot it first entered Top 5. Survives re-renders;
  // pruned as strikes leave the set to keep memory bounded.
  const firstSeenRef = useRef<Map<number, number>>(new Map());
  // Previous observed Top 5 strike set; null = no baseline yet.
  const prevSetRef = useRef<Set<number> | null>(null);

  const [justEntered, setJustEntered] = useState<Set<number>>(() => new Set());
  const [oldestStrike, setOldestStrike] = useState<number | null>(null);

  // Reset tracking when the scrub date changes so firstSeen for today
  // isn't polluted by yesterday's snapshots (and vice versa).
  useEffect(() => {
    firstSeenRef.current = new Map();
    prevSetRef.current = null;
    setJustEntered(new Set());
    setOldestStrike(null);
  }, [resetKey]);

  useEffect(() => {
    if (!timestamp) return;
    const snapMs = new Date(timestamp).getTime();
    if (!Number.isFinite(snapMs)) return;

    const currentSet = new Set(topFive.map((s) => s.strike));

    // Prune strikes that left — unbounded growth would otherwise retain
    // every strike ever seen across a multi-hour session.
    for (const strike of firstSeenRef.current.keys()) {
      if (!currentSet.has(strike)) firstSeenRef.current.delete(strike);
    }
    // Record first-seen for any newcomer (includes the baseline snapshot).
    for (const strike of currentSet) {
      if (!firstSeenRef.current.has(strike)) {
        firstSeenRef.current.set(strike, snapMs);
      }
    }

    const prevSet = prevSetRef.current;
    const isBaseline = prevSet === null;

    // Additions = in current, not in prev. Skip on baseline so the whole
    // initial Top 5 doesn't flash as NEW and doesn't fire the chime.
    const added = new Set<number>();
    if (!isBaseline) {
      for (const strike of currentSet) {
        if (!prevSet.has(strike)) added.add(strike);
      }
    }
    const setChanged = added.size > 0;

    // Oldest = strictly min firstSeenAt. Null when all are equal (no drift).
    let minTs = Infinity;
    let maxTs = -Infinity;
    let minStrike: number | null = null;
    for (const strike of currentSet) {
      const ts = firstSeenRef.current.get(strike) ?? snapMs;
      if (ts < minTs) {
        minTs = ts;
        minStrike = strike;
      }
      if (ts > maxTs) maxTs = ts;
    }
    const nextOldest = minTs < maxTs ? minStrike : null;

    prevSetRef.current = currentSet;

    setJustEntered(added);
    setOldestStrike(nextOldest);

    if (setChanged && isLive && !muted) {
      playTopStrikeChime();
    }
  }, [topFive, timestamp, isLive, muted]);

  return { justEntered, oldestStrike };
}
