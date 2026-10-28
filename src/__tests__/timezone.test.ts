// @vitest-environment node

/**
 * Unit tests for src/utils/timezone.ts.
 *
 * This module is depended on by 18+ files spanning api/, src/utils/, and
 * src/components/. Bugs in the DST-handling functions silently corrupt
 * SPX candle queries (wrong UTC anchor → wrong rows from
 * index_candles_1m) and futures-hours guards (cron jobs running during
 * the 16:00–17:00 maintenance break or weekend gap). Tests pin the
 * EDT/EST + CDT/CST transitions explicitly so any DST bug surfaces here
 * rather than in production.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getETTime,
  getCTTime,
  getETDateStr,
  getETToday,
  isPastETDate,
  isBacktestMode,
  getCTDateStr,
  getETDayOfWeek,
  getCTDayOfWeek,
  isFuturesMarketOpen,
  getETTotalMinutes,
  getETDayOfWeekFromDateStr,
  getCTToETOffsetMinutes,
  getETMarketOpenUtcIso,
  getETCloseUtcIso,
  etWallClockToUtcIso,
  ctWallClockToUtcIso,
  wallClockToUtcIso,
  convertCTToET,
} from '../utils/timezone';

describe('getETTime / getCTTime', () => {
  it('returns ET hour/minute for a known UTC instant in EDT', () => {
    // 2026-07-15 14:30 UTC = 10:30 EDT (GMT-4)
    const d = new Date('2026-07-15T14:30:00.000Z');
    expect(getETTime(d)).toEqual({ hour: 10, minute: 30 });
  });

  it('returns ET hour/minute for a known UTC instant in EST', () => {
    // 2026-01-15 14:30 UTC = 09:30 EST (GMT-5)
    const d = new Date('2026-01-15T14:30:00.000Z');
    expect(getETTime(d)).toEqual({ hour: 9, minute: 30 });
  });

  it('returns CT hour/minute for a known UTC instant in CDT', () => {
    // 2026-07-15 14:30 UTC = 09:30 CDT (GMT-5)
    const d = new Date('2026-07-15T14:30:00.000Z');
    expect(getCTTime(d)).toEqual({ hour: 9, minute: 30 });
  });

  it('handles hour boundary at midnight ET (24 → 00)', () => {
    // Intl reports midnight ET as hour=24 in en-US h24 — getETTime
    // coerces via Number; verify the result is sensible.
    const d = new Date('2026-04-15T04:00:00.000Z'); // 00:00 EDT
    const { hour } = getETTime(d);
    // Allow either 0 or 24 depending on Node ICU build; both round-trip
    // correctly in minute math.
    expect([0, 24]).toContain(hour);
  });
});

describe('getETDateStr / getCTDateStr / getETToday', () => {
  it('extracts the ET calendar date in YYYY-MM-DD format', () => {
    const d = new Date('2026-04-17T13:30:00.000Z'); // EDT, 09:30 ET
    expect(getETDateStr(d)).toBe('2026-04-17');
  });

  it('extracts the CT calendar date in YYYY-MM-DD format', () => {
    const d = new Date('2026-04-17T13:30:00.000Z'); // CDT, 08:30 CT
    expect(getCTDateStr(d)).toBe('2026-04-17');
  });

  it('crosses the day boundary correctly (late ET = next-day UTC)', () => {
    const d = new Date('2026-04-18T03:00:00.000Z'); // 23:00 ET on 4/17
    expect(getETDateStr(d)).toBe('2026-04-17');
  });

  it('getETToday returns a YYYY-MM-DD string', () => {
    expect(getETToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('isPastETDate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Pin the clock (Date only) to a UTC instant. */
  function at(iso: string) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  }

  it.each([
    // [label, clock (UTC), date, expected]
    ['the day before today', '2026-03-04T15:00:00Z', '2026-03-03', true],
    ['a date months back', '2026-03-04T15:00:00Z', '2025-12-31', true],
    ['today', '2026-03-04T15:00:00Z', '2026-03-04', false],
    ['tomorrow', '2026-03-04T15:00:00Z', '2026-03-05', false],
    ['an empty date', '2026-03-04T15:00:00Z', '', false],
    // 21:00 EST on 03-04 is 02:00Z on 03-05: the UTC date has rolled, the
    // ET date has not.
    [
      'today after the UTC rollover',
      '2026-03-05T02:00:00Z',
      '2026-03-04',
      false,
    ],
    // ET midnight in EST (UTC-5): 23:59:59 vs 00:00:00 ET.
    [
      'today one second before ET midnight (EST)',
      '2026-03-05T04:59:59Z',
      '2026-03-04',
      false,
    ],
    [
      'yesterday from ET midnight (EST)',
      '2026-03-05T05:00:00Z',
      '2026-03-04',
      true,
    ],
    // ET midnight in EDT (UTC-4).
    [
      'today one second before ET midnight (EDT)',
      '2026-07-16T03:59:59Z',
      '2026-07-15',
      false,
    ],
    [
      'yesterday from ET midnight (EDT)',
      '2026-07-16T04:00:00Z',
      '2026-07-15',
      true,
    ],
    // 23:30 CT on 03-04 is 00:30 ET on 03-05: the ET convention counts
    // 03-04 as past even though it is still 03-04 in Chicago.
    [
      'the CT date in the last CT hour',
      '2026-03-05T05:30:00Z',
      '2026-03-04',
      true,
    ],
  ])('%s (clock %s, date %s) → %s', (_label, clock, date, expected) => {
    at(clock);
    expect(isPastETDate(date)).toBe(expected);
  });

  it('agrees with getETToday at the same instant', () => {
    at('2026-03-05T05:00:00Z');
    const today = getETToday();
    expect(isPastETDate(today)).toBe(false);
    expect(today).toBe('2026-03-05');
  });

  it('compares with a given today instead of the clock', () => {
    at('2026-03-04T15:00:00Z');
    expect(isPastETDate('2026-03-04', '2026-03-05')).toBe(true);
    expect(isPastETDate('2026-03-04', '2026-03-04')).toBe(false);
    expect(isPastETDate('', '2026-03-05')).toBe(false);
  });
});

describe('isBacktestMode', () => {
  // 11:00 EDT on Tue 2026-03-10 (660 ET minutes).
  const NOW = new Date('2026-03-10T15:00:00Z');
  const m = (h: number, min: number) => h * 60 + min;

  it.each([
    // [label, date, ET minutes of the selected time, expected]
    ['a past date, any time', '2026-03-09', m(15, 55), true],
    ['a past date at the same clock time', '2026-03-09', m(11, 0), true],
    ['a future date, even at an earlier time', '2026-03-11', m(9, 30), false],
    ['an empty date', '', m(9, 30), false],
    ['today at the current time', '2026-03-10', m(11, 0), false],
    [
      'today 5 minutes back (the time sync snaps down)',
      '2026-03-10',
      m(10, 55),
      false,
    ],
    ['today 6 minutes back', '2026-03-10', m(10, 54), true],
    ['today scrubbed back to the open', '2026-03-10', m(9, 30), true],
    ['today ahead of the clock', '2026-03-10', m(15, 0), false],
  ])('%s → %s', (_label, date, etMinutes, expected) => {
    expect(isBacktestMode(date, etMinutes, NOW)).toBe(expected);
  });

  it('keys on the ET date of `now`, not the UTC date', () => {
    // 21:00 EDT on 03-10 is 01:00Z on 03-11.
    const evening = new Date('2026-03-11T01:00:00Z');
    expect(isBacktestMode('2026-03-10', m(21, 0), evening)).toBe(false);
    expect(isBacktestMode('2026-03-10', m(15, 0), evening)).toBe(true);
    expect(isBacktestMode('2026-03-11', m(9, 30), evening)).toBe(false);
  });

  it('reads the clock when no `now` is given', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      expect(isBacktestMode('2026-03-10', m(10, 54))).toBe(true);
      expect(isBacktestMode('2026-03-10', m(10, 55))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('getETDayOfWeek / getCTDayOfWeek', () => {
  it('returns 1 (Monday) for a known Monday in ET', () => {
    // 2026-04-13 is a Monday.
    const d = new Date('2026-04-13T17:00:00.000Z');
    expect(getETDayOfWeek(d)).toBe(1);
  });

  it('returns 0 (Sunday) for a known Sunday in CT', () => {
    // 2026-04-12 Sunday.
    const d = new Date('2026-04-12T18:00:00.000Z');
    expect(getCTDayOfWeek(d)).toBe(0);
  });

  it('returns 6 (Saturday) for a known Saturday', () => {
    const d = new Date('2026-04-11T18:00:00.000Z');
    expect(getETDayOfWeek(d)).toBe(6);
  });
});

describe('isFuturesMarketOpen', () => {
  // Sat — closed all day.
  it('Saturday is always closed', () => {
    expect(isFuturesMarketOpen(new Date('2026-04-11T22:00:00.000Z'))).toBe(
      false,
    );
  });

  // Sun before 17:00 CT — closed.
  it('Sunday before 17:00 CT is closed', () => {
    // 2026-04-12 21:00 UTC = 16:00 CDT — before reopen.
    expect(isFuturesMarketOpen(new Date('2026-04-12T21:00:00.000Z'))).toBe(
      false,
    );
  });

  // Sun after 17:00 CT — open.
  it('Sunday after 17:00 CT is open', () => {
    // 2026-04-12 22:30 UTC = 17:30 CDT — after reopen.
    expect(isFuturesMarketOpen(new Date('2026-04-12T22:30:00.000Z'))).toBe(
      true,
    );
  });

  // Fri at/after 16:00 CT — closed (weekend close).
  it('Friday at 16:00 CT is closed (weekend close)', () => {
    // 2026-04-17 21:00 UTC = 16:00 CDT.
    expect(isFuturesMarketOpen(new Date('2026-04-17T21:00:00.000Z'))).toBe(
      false,
    );
  });

  // Fri before 16:00 CT — open.
  it('Friday before 16:00 CT is open', () => {
    // 2026-04-17 20:00 UTC = 15:00 CDT.
    expect(isFuturesMarketOpen(new Date('2026-04-17T20:00:00.000Z'))).toBe(
      true,
    );
  });

  // Mon-Thu daily maintenance break at 16:00 CT (hour === 16).
  it('Mon-Thu 16:00 CT is closed (maintenance break)', () => {
    // 2026-04-13 (Mon) 21:30 UTC = 16:30 CDT.
    expect(isFuturesMarketOpen(new Date('2026-04-13T21:30:00.000Z'))).toBe(
      false,
    );
  });

  // Mon-Thu at 17:00 CT — open.
  it('Mon-Thu 17:00 CT is open (after maintenance)', () => {
    // 2026-04-13 22:30 UTC = 17:30 CDT.
    expect(isFuturesMarketOpen(new Date('2026-04-13T22:30:00.000Z'))).toBe(
      true,
    );
  });

  it('Mon-Thu mid-session is open', () => {
    // 2026-04-15 (Wed) 14:30 UTC = 09:30 CDT.
    expect(isFuturesMarketOpen(new Date('2026-04-15T14:30:00.000Z'))).toBe(
      true,
    );
  });
});

describe('getETTotalMinutes', () => {
  it('returns total minutes from midnight ET', () => {
    // 13:30 UTC = 09:30 EDT = 570 minutes
    const d = new Date('2026-04-17T13:30:00.000Z');
    expect(getETTotalMinutes(d)).toBe(9 * 60 + 30);
  });
});

describe('getETDayOfWeekFromDateStr', () => {
  it('returns weekday for a valid ET date string', () => {
    // 2026-04-13 = Monday.
    expect(getETDayOfWeekFromDateStr('2026-04-13')).toBe(1);
  });

  it('returns null for malformed date string', () => {
    expect(getETDayOfWeekFromDateStr('not-a-date')).toBeNull();
    expect(getETDayOfWeekFromDateStr('2026/04/13')).toBeNull();
    expect(getETDayOfWeekFromDateStr('')).toBeNull();
  });

  it('returns null for invalid calendar date (Feb 30)', () => {
    expect(getETDayOfWeekFromDateStr('2026-02-30')).toBeNull();
  });

  it('returns null for invalid month (13)', () => {
    expect(getETDayOfWeekFromDateStr('2026-13-01')).toBeNull();
  });
});

describe('getCTToETOffsetMinutes', () => {
  it('returns 60 minutes in DST (CDT vs EDT)', () => {
    const d = new Date('2026-07-15T14:30:00.000Z');
    expect(getCTToETOffsetMinutes(d)).toBe(60);
  });

  it('returns 60 minutes in standard time (CST vs EST)', () => {
    const d = new Date('2026-01-15T14:30:00.000Z');
    expect(getCTToETOffsetMinutes(d)).toBe(60);
  });
});

describe('getETMarketOpenUtcIso', () => {
  it('returns 13:30 UTC for a date in EDT', () => {
    expect(getETMarketOpenUtcIso('2026-04-17')).toBe(
      '2026-04-17T13:30:00.000Z',
    );
  });

  it('returns 14:30 UTC for a date in EST', () => {
    expect(getETMarketOpenUtcIso('2026-01-15')).toBe(
      '2026-01-15T14:30:00.000Z',
    );
  });

  it('returns null for malformed input', () => {
    expect(getETMarketOpenUtcIso('not-a-date')).toBeNull();
    expect(getETMarketOpenUtcIso('2026-13-01')).toBeNull();
  });
});

describe('getETCloseUtcIso', () => {
  it('returns 20:00 UTC for a date in EDT', () => {
    expect(getETCloseUtcIso('2026-04-23')).toBe('2026-04-23T20:00:00.000Z');
  });

  it('returns 21:00 UTC for a date in EST', () => {
    expect(getETCloseUtcIso('2026-01-15')).toBe('2026-01-15T21:00:00.000Z');
  });

  it('returns null for malformed input', () => {
    expect(getETCloseUtcIso('2026-02-30')).toBeNull();
  });
});

describe('etWallClockToUtcIso', () => {
  it('converts 9:30 ET to UTC across EDT/EST', () => {
    expect(etWallClockToUtcIso('2026-04-17', 9 * 60 + 30)).toBe(
      '2026-04-17T13:30:00.000Z',
    );
    expect(etWallClockToUtcIso('2026-01-15', 9 * 60 + 30)).toBe(
      '2026-01-15T14:30:00.000Z',
    );
  });

  it('returns null on bad date', () => {
    expect(etWallClockToUtcIso('bogus', 570)).toBeNull();
  });
});

describe('ctWallClockToUtcIso', () => {
  it('converts 9:30 CT to UTC across CDT/CST', () => {
    expect(ctWallClockToUtcIso('2026-04-17', 9 * 60 + 30)).toBe(
      '2026-04-17T14:30:00.000Z',
    );
    expect(ctWallClockToUtcIso('2026-01-15', 9 * 60 + 30)).toBe(
      '2026-01-15T15:30:00.000Z',
    );
  });

  it('returns null on invalid Feb 30', () => {
    expect(ctWallClockToUtcIso('2026-02-30', 570)).toBeNull();
  });
});

describe('wallClockToUtcIso', () => {
  it('uses the formatter to read the zone offset', () => {
    // Roundtrip: passing the ET formatter should match etWallClockToUtcIso.
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      timeZoneName: 'shortOffset',
      year: 'numeric',
    });
    expect(wallClockToUtcIso('2026-04-17', 9 * 60 + 30, fmt)).toBe(
      '2026-04-17T13:30:00.000Z',
    );
  });
});

describe('convertCTToET', () => {
  it('adds 60 minutes to convert CT to ET', () => {
    const d = new Date('2026-04-17T15:00:00.000Z'); // weekday inside DST
    expect(convertCTToET(9, 30, d)).toEqual({ hour: 10, minute: 30 });
  });

  it('wraps around midnight CT → next-day ET', () => {
    const d = new Date('2026-04-17T15:00:00.000Z');
    // 23:30 CT + 60min = 00:30 ET (next day) — function wraps to 00:30
    expect(convertCTToET(23, 30, d)).toEqual({ hour: 0, minute: 30 });
  });

  it('handles negative wrap (CT very late before midnight crossing)', () => {
    // 0:30 CT - if offset somehow negative would underflow; verify normal
    // forward-wrap still produces valid [0,23].
    const d = new Date('2026-04-17T15:00:00.000Z');
    const result = convertCTToET(0, 30, d);
    expect(result.hour).toBeGreaterThanOrEqual(0);
    expect(result.hour).toBeLessThanOrEqual(23);
  });
});
