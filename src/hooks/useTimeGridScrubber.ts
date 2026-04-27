/**
 * Time-grid scrubber for intraday data replay on a fixed 5-min slot grid
 * spanning the trading session (08:30–15:00 CT).
 *
 * Shared by `useDarkPoolLevels` and `useIVAnomalies`, which both expose
 * the same prev/next/to/live navigation over the same HH:MM grid. The
 * scrubber owns ONLY the navigation state and grid math; per-feature
 * concerns (`isLive`, freshness, `isToday`, polling) stay in the
 * consuming hook because their policies differ across consumers.
 *
 * Snapshot scrubbers that index into a dynamic timestamp array
 * (e.g. `useGexPerStrike`) are intentionally NOT unified here — their
 * "live = last slot" semantics differ enough that a single abstraction
 * would force awkward policy parameters. They keep their own scrubber.
 */

import { useCallback, useState } from 'react';

/**
 * 5-minute slots from 08:30 to 15:00 CT, inclusive (79 values).
 * Values are HH:MM strings in 24-hour CT (e.g. "08:30", "13:45").
 */
export const TIME_GRID: readonly string[] = (() => {
  const grid: string[] = [];
  for (let min = 8 * 60 + 30; min <= 15 * 60; min += 5) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    grid.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
  return grid;
})();

/**
 * Last TIME_GRID slot at or before the current CT wall-clock.
 * Used to anchor the scrubber when the user first clicks "prev" from
 * live mode. Falls back to the first grid slot when called before 08:30 CT.
 */
function lastGridTimeBeforeNow(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const nowMin = (h >= 24 ? 0 : h) * 60 + m;
  for (let i = TIME_GRID.length - 1; i >= 0; i--) {
    const slot = TIME_GRID[i]!;
    const [sh, sm] = slot.split(':').map(Number);
    if (sh! * 60 + sm! <= nowMin) return slot;
  }
  return TIME_GRID[0]!;
}

export interface TimeGridScrubber {
  /** Current scrub slot HH:MM, or null when in live mode. */
  scrubTime: string | null;
  /** True when scrubTime is set (i.e. not live). */
  isScrubbed: boolean;
  /** True when prev would advance — always true from live; idx > 0 from scrubbed. */
  canScrubPrev: boolean;
  /** True when next would advance — false from live; idx < last from scrubbed. */
  canScrubNext: boolean;
  /** Step backward one slot, or enter scrub mode at the slot at-or-before now. */
  scrubPrev: () => void;
  /** Step forward one slot. Clamps at the last slot. */
  scrubNext: () => void;
  /** Jump to a specific slot. Jumping to the last slot resumes live mode. */
  scrubTo: (time: string) => void;
  /** Resume live polling. */
  scrubLive: () => void;
  /** Full slot grid — convenient for UI dropdowns. */
  timeGrid: readonly string[];
}

export function useTimeGridScrubber(): TimeGridScrubber {
  const [scrubTime, setScrubTime] = useState<string | null>(null);

  const scrubTimeIdx = scrubTime !== null ? TIME_GRID.indexOf(scrubTime) : null;

  const canScrubPrev = scrubTimeIdx === null ? true : scrubTimeIdx > 0;
  const canScrubNext =
    scrubTimeIdx !== null && scrubTimeIdx < TIME_GRID.length - 1;
  const isScrubbed = scrubTime !== null;

  const scrubPrev = useCallback(() => {
    setScrubTime((cur) => {
      if (cur === null) return lastGridTimeBeforeNow();
      const idx = TIME_GRID.indexOf(cur);
      return idx > 0 ? (TIME_GRID[idx - 1] ?? cur) : cur;
    });
  }, []);

  const scrubNext = useCallback(() => {
    setScrubTime((cur) => {
      if (cur === null) return cur;
      const idx = TIME_GRID.indexOf(cur);
      return idx < TIME_GRID.length - 1 ? (TIME_GRID[idx + 1] ?? cur) : cur;
    });
  }, []);

  const scrubTo = useCallback((time: string) => {
    if (time === TIME_GRID.at(-1)) {
      setScrubTime(null);
    } else if (TIME_GRID.includes(time)) {
      setScrubTime(time);
    }
  }, []);

  const scrubLive = useCallback(() => {
    setScrubTime(null);
  }, []);

  return {
    scrubTime,
    isScrubbed,
    canScrubPrev,
    canScrubNext,
    scrubPrev,
    scrubNext,
    scrubTo,
    scrubLive,
    timeGrid: TIME_GRID,
  };
}
