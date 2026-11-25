/**
 * Session clock shared by the GEXBot panels that read time to the close
 * (CharmClock, NetVannaTile).
 */

import { useEffect, useState } from 'react';

import { getMarketCloseHourET } from '../../data/marketHours';
import { etWallClockToUtcIso, getETDateStr } from '../../utils/timezone';

/** Re-read the wall clock once a minute; the readouts show minutes. */
const CLOCK_TICK_MS = 60_000;

/**
 * Hours from `now` to the calendar close of its ET day: 16:00 ET, or 13:00 ET
 * on an early-close day (`EARLY_CLOSE_DATES`). 0 once the close has passed,
 * and on a market holiday, which has no close to count to.
 *
 * Not `getETCloseUtcIso`, which is a fixed 16:00 ET: counting to it on a half
 * day overstates the time left by three hours.
 */
export function hoursToClose(now: Date): number {
  const etDate = getETDateStr(now);
  const closeHour = getMarketCloseHourET(etDate);
  if (closeHour == null) return 0;
  const closeIso = etWallClockToUtcIso(etDate, closeHour * 60);
  if (!closeIso) return 0;
  const ms = new Date(closeIso).getTime() - now.getTime();
  return Math.max(0, ms / 3_600_000);
}

export function formatHoursMinutes(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}

/** Wall clock that re-renders every `intervalMs`; the interval is cleaned up. */
export function useNow(intervalMs: number | null): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (intervalMs == null) return undefined;
    const tick = () => setNow(new Date());
    // Catch up after a closed-market or hidden-tab gap, then keep ticking.
    tick();
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    const id = setInterval(tick, intervalMs);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);
  return now;
}

/**
 * Hours to the close for a live readout, re-read once a minute while the
 * market is open and 0 while it is not.
 *
 * The `marketOpen` gate stops the ticking, which leaves `now` as stale as a
 * minute before the close: a countdown read from it would call the session
 * open all evening. A closed market is read as a closed session instead.
 * That also reads 0 before the open, when there is no live session to count
 * down either.
 */
export function useHoursToClose(marketOpen: boolean): number {
  const now = useNow(marketOpen ? CLOCK_TICK_MS : null);
  return marketOpen ? hoursToClose(now) : 0;
}
