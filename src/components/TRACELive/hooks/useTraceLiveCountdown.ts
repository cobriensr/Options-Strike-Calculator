/**
 * useTraceLiveCountdown — derives a 1-second-ticking countdown to the
 * next expected TRACE capture given the timestamp of the latest one.
 *
 * The capture daemon fires every CADENCE_MS (5 minutes). The countdown =
 * (latestCapturedAt + CADENCE_MS) - now. When that goes negative, the
 * UI should show "expected at HH:MM, waiting…" — that's a daemon-down
 * signal worth surfacing visually.
 *
 * Returns null label when there's no latestCapturedAt yet (cold start /
 * empty list).
 */

import { useEffect, useState } from 'react';

const CADENCE_MS = 5 * 60 * 1000; // matches daemon's 5-min cadence

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
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

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

  const nextMs = anchor + CADENCE_MS;
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
