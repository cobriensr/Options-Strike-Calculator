/**
 * usePolling — gated `setInterval` primitive for polling hooks.
 *
 * Many panels need the same shape: "fire `fn` every `intervalMs` while every
 * gate is truthy; stop when any gate flips false; clean up on unmount". The
 * verbatim duplication that previously lived in `useMarketData`,
 * `useGexPerStrike`, and `useGexTarget` collapses into a single primitive
 * here.
 *
 * Semantics (preserved bit-for-bit from the original hand-rolled patterns):
 *   - Schedules only — never calls `fn` immediately. Each consumer continues
 *     to own its own eager mount-fetch effect; this primitive is exclusively
 *     about the *recurring* interval.
 *   - `gates` is a boolean array. The interval runs only while every gate is
 *     truthy. An empty `gates` array means "always-active" (matches the
 *     convention from `useWallClockFreshness`).
 *   - Captures the latest `fn` via a ref so callers don't need to
 *     `useCallback` — passing a fresh closure each render works correctly.
 *     Each interval tick fires the most recent `fn` reference.
 *   - Re-schedules (clears + restarts) when `intervalMs` changes or when the
 *     gate-conjunction flips. Does NOT re-schedule when `fn` changes — the
 *     ref simply updates, and the next tick uses the new function.
 *   - Cleans up on unmount and on gate-flip-to-closed.
 *
 * Timing nuance: when a gate flips while an interval is mid-flight, the
 * effect re-runs, clears the existing interval, and (if the gates are open)
 * starts a fresh one. The new interval counts from the moment the gate
 * flipped, so the first post-flip tick fires `intervalMs` later — not at
 * the original cadence offset. This matches the legacy behavior of every
 * consumer.
 */

import { useEffect, useRef } from 'react';

/**
 * Gated `setInterval` primitive. Returns nothing — the hook is invoked for
 * its side effect (scheduling + cleanup).
 *
 * @param fn         The function to invoke on every tick. May change every
 *                   render; the hook captures the latest reference via a
 *                   ref so callers don't need to memoize.
 * @param intervalMs Cadence in milliseconds. Changing this re-schedules.
 * @param gates      Boolean conjunction. The interval runs while every gate
 *                   is truthy. Empty array means "always-active".
 */
export function usePolling(
  fn: () => void,
  intervalMs: number,
  gates: boolean[],
): void {
  // Latest `fn` reference. Updating a ref in render-phase (rather than in an
  // effect) is intentional: it guarantees the next interval tick — even one
  // queued in the same render commit — fires the freshest `fn`. React's docs
  // call this "useEffectEvent in spirit": stable identity, latest value.
  const fnRef = useRef(fn);
  fnRef.current = fn;

  // Reduce the gates array to a single primitive so the effect dep array
  // stays cheap and structural. A referentially-new array with the same
  // contents won't churn the effect — only an actual flip does.
  const allGatesOpen = gates.every(Boolean);

  useEffect(() => {
    if (!allGatesOpen) return;
    const id = setInterval(() => fnRef.current(), intervalMs);
    return () => clearInterval(id);
  }, [allGatesOpen, intervalMs]);
}
