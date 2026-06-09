import { describe, it, expect } from 'vitest';
import {
  getTodBucket,
  TOD_QUALITY,
} from '../components/LotteryFinder/session-quality';
import type { TimeOfDay } from '../components/LotteryFinder/types';
import { getTimeOfDayFromCtHourMin } from '../../api/_lib/lottery-finder';

// ── Helpers ──────────────────────────────────────────────────
//
// Build a UTC instant that maps to a known CT wall-clock time.
// Central Daylight Time (CDT, summer) is UTC-5, so 08:30 CT = 13:30Z.
// Central Standard Time (CST, winter) is UTC-6, so 08:30 CT = 14:30Z.

/** A summer date (CDT, UTC-5). 2026-06-08 is a Monday in DST. */
function cdtInstant(ctHour: number, ctMinute: number, ctSecond = 0): Date {
  // CDT = UTC-5 → UTC hour = CT hour + 5.
  return new Date(Date.UTC(2026, 5, 8, ctHour + 5, ctMinute, ctSecond));
}

/** A winter date (CST, UTC-6). 2026-01-12 is a Monday in standard time. */
function cstInstant(ctHour: number, ctMinute: number, ctSecond = 0): Date {
  // CST = UTC-6 → UTC hour = CT hour + 6.
  return new Date(Date.UTC(2026, 0, 12, ctHour + 6, ctMinute, ctSecond));
}

// ============================================================
// BUCKET BOUNDARIES (CDT / summer)
// ============================================================

describe('getTodBucket: CT wall-clock → bucket', () => {
  const cases: Array<{
    label: string;
    instant: Date;
    expected: TimeOfDay;
  }> = [
    {
      label: '08:30:00 CT',
      instant: cdtInstant(8, 30, 0),
      expected: 'AM_open',
    },
    {
      label: '09:29:59 CT',
      instant: cdtInstant(9, 29, 59),
      expected: 'AM_open',
    },
    { label: '09:30:00 CT', instant: cdtInstant(9, 30, 0), expected: 'MID' },
    { label: '11:29:59 CT', instant: cdtInstant(11, 29, 59), expected: 'MID' },
    { label: '11:30:00 CT', instant: cdtInstant(11, 30, 0), expected: 'LUNCH' },
    {
      label: '12:29:59 CT',
      instant: cdtInstant(12, 29, 59),
      expected: 'LUNCH',
    },
    { label: '12:30:00 CT', instant: cdtInstant(12, 30, 0), expected: 'PM' },
    { label: '14:59:00 CT', instant: cdtInstant(14, 59, 0), expected: 'PM' },
  ];

  for (const { label, instant, expected } of cases) {
    it(`buckets ${label} → ${expected}`, () => {
      expect(getTodBucket(instant)).toBe(expected);
    });
  }
});

// ============================================================
// DST INDEPENDENCE
// ============================================================

describe('getTodBucket: DST-safe (no hardcoded offset)', () => {
  it('buckets 08:30 CT as AM_open in winter (CST, UTC-6) too', () => {
    // 08:30 CT in CST = 14:30Z. If the impl hardcoded a -5 offset it would
    // read 09:30 CT and mis-bucket to MID. Proving it uses Intl CT.
    expect(getTodBucket(cstInstant(8, 30, 0))).toBe('AM_open');
  });

  it('buckets 12:30 CT as PM in winter too', () => {
    expect(getTodBucket(cstInstant(12, 30, 0))).toBe('PM');
  });
});

// ============================================================
// BACKEND PARITY
// ============================================================
//
// getTodBucket MUST stay in lockstep with the backend
// getTimeOfDayFromCtHourMin (api/_lib/lottery-finder.ts). We sweep every
// minute across the session and assert they agree. The backend fn takes
// (hour, minute) directly; getTodBucket takes a Date — we build a CDT
// instant for each minute so getCTTime decodes it back to that CT time.

describe('getTodBucket: backend parity', () => {
  it('agrees with getTimeOfDayFromCtHourMin for every session minute', () => {
    for (let hour = 8; hour <= 15; hour++) {
      for (let minute = 0; minute < 60; minute++) {
        const backend = getTimeOfDayFromCtHourMin(hour, minute);
        const frontend = getTodBucket(cdtInstant(hour, minute, 0));
        expect(frontend, `mismatch at ${hour}:${minute}`).toBe(backend);
      }
    }
  });
});

// ============================================================
// STATIC STATS TABLE
// ============================================================

describe('TOD_QUALITY: static stats', () => {
  it('maps AM_open → strong, MID/LUNCH → moderate, PM → weak', () => {
    expect(TOD_QUALITY.AM_open.quality).toBe('strong');
    expect(TOD_QUALITY.MID.quality).toBe('moderate');
    expect(TOD_QUALITY.LUNCH.quality).toBe('moderate');
    expect(TOD_QUALITY.PM.quality).toBe('weak');
  });

  it('carries the documented median-peak / win-rate numbers', () => {
    expect(TOD_QUALITY.AM_open.medianPeakPct).toBe(40.18);
    expect(TOD_QUALITY.AM_open.winRatePct).toBe(62.1);
    expect(TOD_QUALITY.MID.medianPeakPct).toBe(32.65);
    expect(TOD_QUALITY.LUNCH.medianPeakPct).toBe(29.1);
    expect(TOD_QUALITY.PM.medianPeakPct).toBe(16.27);
    expect(TOD_QUALITY.PM.winRatePct).toBe(52.2);
  });

  it('keys each entry to its own tod', () => {
    for (const tod of ['AM_open', 'MID', 'LUNCH', 'PM'] as TimeOfDay[]) {
      expect(TOD_QUALITY[tod].tod).toBe(tod);
    }
  });

  it('quality tiers follow the median-peak thresholds (≥35 / 20–35 / <20)', () => {
    for (const stat of Object.values(TOD_QUALITY)) {
      if (stat.medianPeakPct >= 35) expect(stat.quality).toBe('strong');
      else if (stat.medianPeakPct >= 20) expect(stat.quality).toBe('moderate');
      else expect(stat.quality).toBe('weak');
    }
  });
});
