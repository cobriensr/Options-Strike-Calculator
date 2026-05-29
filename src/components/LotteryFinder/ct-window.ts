/**
 * Pure helper for the LotteryFinder time scrubber: returns the UTC
 * instant of a given CT wall-clock time on a given date.
 *
 * Extracted from LotteryFinderSection so it can be unit-tested
 * independent of React state. The earlier in-component implementation
 * had a TZ-dependent bug — see ct-window.test.ts for the regression.
 */

import { getEarlyCloseHourET } from '../../data/marketHours.js';

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Build an ISO UTC timestamp string for `hh:mm` CT on the given date.
 * Browser-TZ-independent. Handles CDT/CST automatically because the
 * Intl API knows the date's DST state for America/Chicago.
 *
 * Strategy:
 *   1. Build an initial guess by PRETENDING the requested CT time is
 *      UTC. This is wrong by the CT offset (~4-6h) but is a stable
 *      anchor independent of `Intl.DateTimeFormat`'s TZ database.
 *   2. Ask Intl what CT actually reads for that guess instant.
 *   3. Shift the guess forward by the wall-clock difference between
 *      what we wanted CT to read and what it actually reads.
 *
 * For a CT user on 2026-05-01 (CDT, UTC-5):
 *   ctToUtc('2026-05-01', 8, 30) → '2026-05-01T13:30:00.000Z'
 *   ctToUtc('2026-05-01', 15, 0) → '2026-05-01T20:00:00.000Z'
 */
export function ctToUtc(date: string, hh: number, mm: number): string {
  const guess = new Date(`${date}T${pad(hh)}:${pad(mm)}:00Z`);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(guess)) parts[p.type] = p.value;
  // Some locales render midnight as '24' — normalize to 0.
  const ctH = parts.hour === '24' ? 0 : Number(parts.hour);
  const ctM = Number(parts.minute);
  let diffMin = (hh - ctH) * 60 + (mm - ctM);
  // Wrap diff into [-12h, +12h] to pick the nearest CT moment.
  // Without this, midnight CT (where guess Z is on the next CT date)
  // would land 19h earlier on the prior calendar day.
  if (diffMin > 720) diffMin -= 1440;
  if (diffMin < -720) diffMin += 1440;
  return new Date(guess.getTime() + diffMin * 60_000).toISOString();
}

/**
 * Session bounds (08:30 CT open → close CT) for a date. The close is
 * normally 15:00 CT, but NYSE half-days (Black Friday, Christmas Eve, …)
 * close at 13:00 ET = 12:00 CT. ET is always CT+1, so the CT close hour
 * is the ET close hour minus one. Mirrors the early-close awareness the
 * calculator (`useCalculation` via `getEarlyCloseHourET`) already uses,
 * so the chart axis / scrubbers don't paint phantom post-close time.
 */
export function ctSessionBounds(date: string): { min: string; max: string } {
  const closeHourEt = getEarlyCloseHourET(date) ?? 16;
  return { min: ctToUtc(date, 8, 30), max: ctToUtc(date, closeHourEt - 1, 0) };
}
