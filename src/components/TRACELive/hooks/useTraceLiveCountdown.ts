/**
 * useTraceLiveCountdown — derives a 1-second-ticking countdown to the
 * next expected TRACE row visibility given the latest captured row's
 * timestamp.
 *
 * Why two intervals: the daemon CAPTURES every CADENCE_MS, but each
 * captured payload also has to go through the Vercel function's
 * Anthropic call (5-9 min for effort:'high' on a 3-image structured
 * call) before the row lands in the DB and the dashboard sees it. The
 * countdown anchors to row-visibility time so it doesn't yell
 * "Overdue" during the normal processing window.
 *
 * next-row-visible ≈ latestCapturedAt + CADENCE_MS + PROCESSING_MS_P95
 *
 * "Overdue" therefore fires only when the GAP exceeds typical
 * processing — a real signal worth surfacing.
 *
 * Returns null label when there's no latestCapturedAt yet.
 */

import { useEffect, useState } from 'react';

// Matches daemon's CADENCE_SECONDS default (daemon/src/config.ts).
// Bumped from 5 → 10 min in commit 811cd38. There's no compile-time
// link between the two; keep them in sync by hand.
const CADENCE_MS = 10 * 60 * 1000;

// p95 of recent function durations for /api/trace-live-analyze on
// Sonnet 4.6 + effort:'high' + 3 images. The next row appears in
// the DB at captured_at + CADENCE + ~processing — anchoring the
// countdown there means "Overdue" only fires when the system is
// genuinely behind, not during normal Anthropic processing time.
const PROCESSING_MS_P95 = 9 * 60 * 1000;
const NEXT_VISIBLE_OFFSET_MS = CADENCE_MS + PROCESSING_MS_P95;

export interface UseTraceLiveCountdownReturn {
  /** Seconds until next capture is expected. Negative when overdue. */
  secondsRemaining: number | null;
  /** "M:SS" formatted string for display, or null when no anchor. */
  label: string | null;
  /** True when the countdown is past zero — surface as a daemon-down hint. */
  isOverdue: boolean;
  /** ISO of when the next capture is expected. */
  nextExpectedAt: string | null;
}

export function useTraceLiveCountdown(
  latestCapturedAt: string | null,
): UseTraceLiveCountdownReturn {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Gate the timer on having an anchor — when latestCapturedAt is null
    // (cold start, no captures yet, non-owner) the hook returns early
    // without using `now`, so 60 wakeups/min is wasted re-render work.
    if (!latestCapturedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [latestCapturedAt]);

  if (!latestCapturedAt) {
    return {
      secondsRemaining: null,
      label: null,
      isOverdue: false,
      nextExpectedAt: null,
    };
  }

  const anchor = new Date(latestCapturedAt).getTime();
  if (Number.isNaN(anchor)) {
    return {
      secondsRemaining: null,
      label: null,
      isOverdue: false,
      nextExpectedAt: null,
    };
  }

  const nextMs = anchor + NEXT_VISIBLE_OFFSET_MS;
  const remainingSec = Math.round((nextMs - now) / 1000);
  const isOverdue = remainingSec < 0;
  const absSec = Math.abs(remainingSec);
  const minutes = Math.floor(absSec / 60);
  const seconds = absSec % 60;
  const label = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  return {
    secondsRemaining: remainingSec,
    label,
    isOverdue,
    nextExpectedAt: new Date(nextMs).toISOString(),
  };
}
