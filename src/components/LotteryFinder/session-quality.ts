/**
 * Session-quality lookup for the Lottery Finder feed.
 *
 * Pure decision-support: maps the current time-of-day to a historical
 * expectancy backdrop (median peak %, win rate %) so the trader sees the
 * session context at a glance. Changes NO scoring/filtering/data.
 *
 * Static stats are from docs/tmp/tod-fire-position-2026-06-08.md §1.
 */
import { getCTTime } from '../../utils/timezone.js';
import type { TimeOfDay } from './types.js';

/**
 * Bucket a Date into the lottery time-of-day window using CT wall-clock.
 *
 * MUST stay in lockstep with getTimeOfDayFromCtHourMin in
 * api/_lib/lottery-finder.ts — the cutoffs (9.5 / 11.5 / 12.5) are
 * duplicated here on purpose so the banner labels match the backend's
 * `tod` tag exactly. A parity test in src/__tests__/session-quality.test.ts
 * sweeps every session minute against the backend function.
 */
export function getTodBucket(now: Date): TimeOfDay {
  const { hour, minute } = getCTTime(now);
  const h = hour + minute / 60;
  if (h < 9.5) return 'AM_open';
  if (h < 11.5) return 'MID';
  if (h < 12.5) return 'LUNCH';
  return 'PM';
}

/** Quality tier driven by historical median peak return. */
export type SessionQuality = 'strong' | 'moderate' | 'weak';

export interface TodQualityStat {
  tod: TimeOfDay;
  label: string;
  ctWindow: string;
  medianPeakPct: number;
  winRatePct: number;
  n: number;
  quality: SessionQuality;
  blurb: string;
}

/**
 * Static historical expectancy by time-of-day bucket.
 *
 * Quality tiers are median-peak driven: strong ≥35, moderate 20–35,
 * weak <20. (AM→strong, MID/LUNCH→moderate, PM→weak.)
 */
export const TOD_QUALITY: Record<TimeOfDay, TodQualityStat> = {
  AM_open: {
    tod: 'AM_open',
    label: 'AM session',
    ctWindow: '08:30–09:29 CT',
    medianPeakPct: 40.18,
    winRatePct: 62.1,
    n: 217676,
    quality: 'strong',
    blurb: 'historically the strongest entry window',
  },
  MID: {
    tod: 'MID',
    label: 'Midday',
    ctWindow: '09:30–11:29 CT',
    medianPeakPct: 32.65,
    winRatePct: 59.2,
    n: 206268,
    quality: 'moderate',
    blurb: 'solid mid-session backdrop',
  },
  LUNCH: {
    tod: 'LUNCH',
    label: 'Lunch',
    ctWindow: '11:30–12:29 CT',
    medianPeakPct: 29.1,
    winRatePct: 58.2,
    n: 72353,
    quality: 'moderate',
    blurb: 'mid-tier backdrop',
  },
  PM: {
    tod: 'PM',
    label: 'PM session',
    ctWindow: '12:30–15:00 CT',
    medianPeakPct: 16.27,
    winRatePct: 52.2,
    n: 196536,
    quality: 'weak',
    blurb: 'weakest window — be selective',
  },
};
