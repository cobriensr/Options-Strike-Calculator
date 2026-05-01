/**
 * useScrubController — generic scrub state machine for time-series panels.
 *
 * Owns the "user has stepped backwards from live" state and the prev/next/jump/
 * resume-live transitions. Works with any sorted-ascending timestamp array
 * (string ISO timestamps or numeric epoch ms). Extracted from the verbatim
 * duplication that previously lived in `useGexPerStrike` and `useGexTarget`.
 *
 * Semantics (preserved bit-for-bit from the original hooks):
 *   - `scrubTimestamp == null` means "live" — i.e. always show the latest.
 *   - `isScrubbed` is `true` whenever the user has explicitly pinned a past ts.
 *   - `scrubPrev` from live steps to the second-to-last ts (so the user always
 *     sees a *prior* snapshot, never the latest one as a scrub target).
 *   - `scrubNext` from a position close to the end (idx >= length - 2) clears
 *     scrub and resumes live; `null` is the only representation of "current".
 *   - `scrubTo(latestTs)` resumes live; `scrubTo(unknownTs)` is a no-op.
 *
 * `scrubLive()` only clears scrub state. Consumers that also need to reset
 * other panel-local state (e.g. `selectedDate` snapping back to today) wrap
 * the returned function with their own additional logic.
 */

import { useState, useCallback, useEffect } from 'react';

/**
 * Public API of the scrub controller. Generic over the timestamp type so
 * consumers using ISO strings (`useGexPerStrike`) and consumers using numeric
 * epoch ms (future) share the same machinery.
 */
export interface ScrubController<T extends number | string> {
  /**
   * Currently pinned timestamp, or `null` when live (latest auto-selected).
   */
  scrubTimestamp: T | null;
  /** True when the user has explicitly stepped back from live. */
  isScrubbed: boolean;
  /** True when there is at least one earlier timestamp to step to. */
  canScrubPrev: boolean;
  /** True when scrubbed and at least one later step is possible. */
  canScrubNext: boolean;
  /** Step one timestamp earlier. Pauses live mode. */
  scrubPrev: () => void;
  /** Step one timestamp later. Clears scrub and resumes live near the end. */
  scrubNext: () => void;
  /** Jump to a specific timestamp; latest = resume live; unknown = no-op. */
  scrubTo: (ts: T) => void;
  /**
   * Resume live mode. Clears the scrub pin only — consumers wrap this with
   * any panel-specific cleanup (e.g. reset `selectedDate` to today).
   */
  scrubLive: () => void;
}

/**
 * Generic scrub state machine. `timestamps` MUST be sorted ascending; the
 * controller treats `timestamps.at(-1)` as "the latest" in all transitions.
 *
 * Re-creates the prev/next/to/live transitions in lockstep with the original
 * inline implementations in `useGexPerStrike` and `useGexTarget`. The state
 * is owned here, so consumers no longer keep a parallel `scrubTimestamp`.
 */
export function useScrubController<T extends number | string>(
  timestamps: T[],
): ScrubController<T> {
  const [scrubTimestamp, setScrubTimestamp] = useState<T | null>(null);

  // Defensive: if `timestamps` ever shrinks such that the current scrub pin
  // is no longer valid, we clear the pin so `isScrubbed` doesn't lie. The
  // original consumers cleared scrub on date change via a separate effect;
  // this generalizes that guarantee to any timestamp-list churn.
  useEffect(() => {
    if (scrubTimestamp == null) return;
    if (!timestamps.includes(scrubTimestamp)) {
      setScrubTimestamp(null);
    }
  }, [timestamps, scrubTimestamp]);

  const isScrubbed = scrubTimestamp != null;

  // The "current" timestamp for nav math is whatever is on screen. When not
  // scrubbed that's the latest; when scrubbed it's the pinned ts.
  const latestTs = timestamps.at(-1) ?? null;
  const activeTs = scrubTimestamp ?? latestTs;
  const activeIdx = activeTs != null ? timestamps.indexOf(activeTs) : -1;
  const canScrubPrev = activeIdx > 0;
  const canScrubNext = isScrubbed && timestamps.length > 0;

  const scrubPrev = useCallback(() => {
    setScrubTimestamp((current) => {
      // From live, "previous" means one step back from the latest.
      if (current == null) {
        if (timestamps.length < 2) return current;
        return timestamps.at(-2) ?? current;
      }
      const idx = timestamps.indexOf(current);
      if (idx <= 0) return current;
      return timestamps[idx - 1] ?? current;
    });
  }, [timestamps]);

  const scrubNext = useCallback(() => {
    setScrubTimestamp((current) => {
      if (current == null) return null;
      const idx = timestamps.indexOf(current);
      // Unknown ts, or the next step would land on (or past) the latest →
      // resume live so polling restarts. Pinning the newest value is never
      // valid — `null` is the canonical "current" representation.
      if (idx < 0 || idx >= timestamps.length - 2) return null;
      return timestamps[idx + 1] ?? null;
    });
  }, [timestamps]);

  const scrubTo = useCallback(
    (ts: T) => {
      // Jumping to the latest timestamp resumes live mode.
      if (ts === timestamps.at(-1)) {
        setScrubTimestamp(null);
      } else if (timestamps.includes(ts)) {
        setScrubTimestamp(ts);
      }
    },
    [timestamps],
  );

  const scrubLive = useCallback(() => {
    setScrubTimestamp(null);
  }, []);

  return {
    scrubTimestamp,
    isScrubbed,
    canScrubPrev,
    canScrubNext,
    scrubPrev,
    scrubNext,
    scrubTo,
    scrubLive,
  };
}
