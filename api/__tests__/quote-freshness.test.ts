// @vitest-environment node

/**
 * api/_lib/quote-freshness.ts: whether a live snapshot save's quote is fresh
 * enough for its slot, and whether a refusal is worth an alert.
 *
 * Every instant is written out as UTC, so the tests do not lean on the
 * timezone helpers they check. 2026-11-09 is CST (UTC-6, ET UTC-5);
 * 2026-03-10 is CDT (UTC-5, ET UTC-4).
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_QUOTE_AHEAD_MS,
  MAX_QUOTE_BEHIND_MS,
  alertsOnRefusal,
  checkQuoteFreshness,
  isInSession,
  isoOrNull,
} from '../_lib/quote-freshness.js';
import type { QuoteVerdict } from '../_lib/quote-freshness.js';

const MIN = 60_000;
const utc = (iso: string) => Date.parse(iso);

/** Mon 2026-11-09, 10:35 AM CST. */
const CST_DATE = '2026-11-09';
const CST_SLOT = utc('2026-11-09T16:35:00Z');
/** Tue 2026-03-10, 10:35 AM CDT. */
const CDT_DATE = '2026-03-10';
const CDT_SLOT = utc('2026-03-10T15:35:00Z');

function check(
  overrides: Partial<Parameters<typeof checkQuoteFreshness>[0]> = {},
) {
  return checkQuoteFreshness({
    date: CST_DATE,
    entryTime: '10:35 AM CT',
    quotedAt: CST_SLOT - 7 * MIN,
    nowMs: CST_SLOT + 30_000,
    ...overrides,
  });
}

describe('constants', () => {
  it('pins the spec’s 10 minutes and a 2 minute clock-skew allowance', () => {
    expect(MAX_QUOTE_BEHIND_MS).toBe(10 * MIN);
    expect(MAX_QUOTE_AHEAD_MS).toBe(2 * MIN);
  });
});

describe('checkQuoteFreshness: the 10 minute rule', () => {
  it('passes a quote 7 min 48 s behind its slot', () => {
    // SPX 16:27:12Z, VIX 16:34:45Z: the older one is the quote time.
    expect(check({ quotedAt: utc('2026-11-09T16:27:12Z') })).toEqual({
      ok: true,
      behindMs: 7 * MIN + 48_000,
    });
  });

  it('passes a quote exactly 10:00 behind its slot', () => {
    expect(check({ quotedAt: CST_SLOT - MAX_QUOTE_BEHIND_MS })).toEqual({
      ok: true,
      behindMs: MAX_QUOTE_BEHIND_MS,
    });
  });

  it('refuses a quote 10:00.001 behind its slot as stale-quote', () => {
    expect(check({ quotedAt: CST_SLOT - MAX_QUOTE_BEHIND_MS - 1 })).toEqual({
      ok: false,
      reason: 'stale-quote',
      slotMs: CST_SLOT,
      behindMs: MAX_QUOTE_BEHIND_MS + 1,
    });
  });

  it('refuses a quote frozen at 16:20Z for the 16:35Z slot (15 min)', () => {
    expect(check({ quotedAt: utc('2026-11-09T16:20:00Z') })).toMatchObject({
      ok: false,
      reason: 'stale-quote',
      behindMs: 15 * MIN,
    });
  });

  it('passes a quote newer than its slot (the slot is floored to 5 min)', () => {
    const verdict = check({
      quotedAt: CST_SLOT + 4 * MIN,
      nowMs: CST_SLOT + 5 * MIN,
    });
    expect(verdict).toEqual({ ok: true, behindMs: -4 * MIN });
  });

  it('reads the slot in CDT too: 10:35 AM CT is 15:35Z in March', () => {
    const base = { date: CDT_DATE, nowMs: CDT_SLOT + 30_000 };
    // 9 min behind passes. On a fixed UTC-6 offset the slot would be an hour
    // later and this would be 69 min behind.
    expect(
      check({ ...base, quotedAt: utc('2026-03-10T15:26:00Z') }),
    ).toMatchObject({ ok: true });
    expect(
      check({ ...base, quotedAt: utc('2026-03-10T15:20:00Z') }),
    ).toMatchObject({ ok: false, reason: 'stale-quote', behindMs: 15 * MIN });
  });

  it('reads an ET label on the CT clock: 11:35 AM ET is 10:35 AM CT', () => {
    const quotedAt = CST_SLOT - 9 * MIN;
    expect(check({ entryTime: '11:35 AM ET', quotedAt })).toEqual(
      check({ entryTime: '10:35 AM CT', quotedAt }),
    );
    expect(check({ entryTime: '11:35 AM ET', quotedAt })).toMatchObject({
      ok: true,
      behindMs: 9 * MIN,
    });
  });

  it('reads a bare label as CT', () => {
    expect(check({ entryTime: '10:35 AM' })).toMatchObject({ ok: true });
  });
});

describe('checkQuoteFreshness: no-quote-time', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['zero', 0],
    ['NaN', Number.NaN],
    ['a negative number', -5],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses %s', (_label, quotedAt) => {
    expect(check({ quotedAt })).toMatchObject({
      ok: false,
      reason: 'no-quote-time',
      behindMs: null,
    });
  });

  it('wins over a bad entry time: nothing to compare is the first fact', () => {
    expect(check({ quotedAt: null, entryTime: 'pre-market' })).toMatchObject({
      reason: 'no-quote-time',
    });
  });
});

describe('checkQuoteFreshness: bad-entry-time', () => {
  it.each([
    ['a 24-hour label with no meridiem', '09:35'],
    ['pre-market', 'pre-market'],
    ['an empty label', ''],
    ['hour 13 with PM', '13:00 PM CT'],
    ['minute 75', '10:75 AM CT'],
    ['an unknown zone', '10:35 AM PT'],
  ])('refuses %s', (_label, entryTime) => {
    expect(check({ entryTime })).toEqual({
      ok: false,
      reason: 'bad-entry-time',
      slotMs: null,
      behindMs: null,
    });
  });

  it('refuses a date that is not on the calendar', () => {
    expect(check({ date: '2026-02-30' })).toMatchObject({
      ok: false,
      reason: 'bad-entry-time',
      slotMs: null,
    });
  });

  it('wins over a quote from the future', () => {
    expect(
      check({ entryTime: 'nonsense', quotedAt: CST_SLOT + 60 * MIN }),
    ).toMatchObject({ reason: 'bad-entry-time' });
  });
});

describe('checkQuoteFreshness: quote-from-future', () => {
  const now = CST_SLOT + 30_000;

  it('passes a quote exactly 2:00 ahead of the server clock', () => {
    expect(
      check({ nowMs: now, quotedAt: now + MAX_QUOTE_AHEAD_MS }),
    ).toMatchObject({ ok: true });
  });

  it('refuses a quote 2:00.001 ahead of the server clock', () => {
    expect(
      check({ nowMs: now, quotedAt: now + MAX_QUOTE_AHEAD_MS + 1 }),
    ).toMatchObject({ ok: false, reason: 'quote-from-future' });
  });

  it('refuses epoch microseconds, which a one-sided age check would pass', () => {
    // 1_794_001_029_801 ms read as microseconds-per-ms: 1000 times too large.
    const verdict = check({ quotedAt: 1_794_001_029_801_000 });
    expect(verdict).toMatchObject({ ok: false, reason: 'quote-from-future' });
  });

  it('refuses a value so large it is not a valid Date', () => {
    expect(check({ quotedAt: 1e17 })).toMatchObject({
      ok: false,
      reason: 'quote-from-future',
    });
  });
});

describe('checkQuoteFreshness: a units mistake the other way', () => {
  it('refuses epoch seconds as stale-quote (decades behind)', () => {
    expect(check({ quotedAt: 1_794_001_029 })).toMatchObject({
      ok: false,
      reason: 'stale-quote',
    });
  });
});

describe('isoOrNull', () => {
  it('formats a valid instant', () => {
    expect(isoOrNull(utc('2026-11-09T16:27:12Z'))).toBe(
      '2026-11-09T16:27:12.000Z',
    );
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['a value past the Date range', 1e17],
  ])('is null for %s, never a throw', (_label, value) => {
    expect(isoOrNull(value)).toBeNull();
  });
});

describe('isInSession: from the open + 10 min up to the close', () => {
  it.each([
    // CST day: open 14:30Z, close 21:00Z.
    ['CST, 1 s before open + 10:00', CST_DATE, '2026-11-09T14:39:59Z', false],
    ['CST, at open + 10:00', CST_DATE, '2026-11-09T14:40:00Z', true],
    ['CST, mid-session', CST_DATE, '2026-11-09T16:35:00Z', true],
    ['CST, 1 min before the close', CST_DATE, '2026-11-09T20:59:00Z', true],
    ['CST, at the close', CST_DATE, '2026-11-09T21:00:00Z', false],
    ['CST, before the open', CST_DATE, '2026-11-09T13:00:00Z', false],
    ['CST, after the close', CST_DATE, '2026-11-09T23:00:00Z', false],
    // CDT day: open 13:30Z, close 20:00Z.
    ['CDT, 1 s before open + 10:00', CDT_DATE, '2026-03-10T13:39:59Z', false],
    ['CDT, at open + 10:00', CDT_DATE, '2026-03-10T13:40:00Z', true],
    ['CDT, 1 min before the close', CDT_DATE, '2026-03-10T19:59:00Z', true],
    ['CDT, at the close', CDT_DATE, '2026-03-10T20:00:00Z', false],
    // Half day 2026-11-27 (Black Friday): close 13:00 ET = 18:00Z.
    [
      'a half day, 1 min before its close',
      '2026-11-27',
      '2026-11-27T17:59:00Z',
      true,
    ],
    ['a half day, at its close', '2026-11-27', '2026-11-27T18:00:00Z', false],
    [
      'a half day, at a full day’s 2:55 PM CT',
      '2026-11-27',
      '2026-11-27T20:55:00Z',
      false,
    ],
    // No session.
    ['a Saturday', '2026-11-07', '2026-11-07T16:35:00Z', false],
    ['a Sunday', '2026-11-08', '2026-11-08T16:35:00Z', false],
    ['a holiday (Thanksgiving)', '2026-11-26', '2026-11-26T16:35:00Z', false],
    ['a date not on the calendar', '2026-02-30', '2026-03-02T16:35:00Z', false],
  ])('%s', (_label, date, slotIso, expected) => {
    expect(isInSession(date, utc(slotIso))).toBe(expected);
  });
});

describe('alertsOnRefusal', () => {
  const refusal = (
    reason: Extract<QuoteVerdict, { ok: false }>['reason'],
    slotMs: number | null,
  ): QuoteVerdict => ({ ok: false, reason, slotMs, behindMs: null });

  const IN_SESSION = utc('2026-11-09T16:35:00Z');
  const BEFORE_OPEN = utc('2026-11-09T13:35:00Z'); // 7:35 AM CT
  const OPEN_GRACE = utc('2026-11-09T14:35:00Z'); // 8:35 AM CT, 9:35 ET
  const AFTER_CLOSE = utc('2026-11-09T21:30:00Z');
  const SATURDAY = utc('2026-11-07T16:35:00Z');

  it.each([
    ['alerts in session', IN_SESSION, true],
    ['is quiet before the open', BEFORE_OPEN, false],
    ['is quiet inside the 10 min after the open', OPEN_GRACE, false],
    ['is quiet after the close', AFTER_CLOSE, false],
    ['is quiet on a weekend', SATURDAY, false],
  ])('stale-quote %s', (_label, slotMs, expected) => {
    expect(alertsOnRefusal(CST_DATE, refusal('stale-quote', slotMs))).toBe(
      expected,
    );
  });

  it.each([
    ['alerts in session', IN_SESSION, true],
    ['is quiet after the close', AFTER_CLOSE, false],
  ])('quote-from-future %s', (_label, slotMs, expected) => {
    expect(
      alertsOnRefusal(CST_DATE, refusal('quote-from-future', slotMs)),
    ).toBe(expected);
  });

  it.each([
    ['in session', IN_SESSION],
    ['before the open', BEFORE_OPEN],
    ['after the close', AFTER_CLOSE],
    ['on a weekend', SATURDAY],
    ['with an unreadable slot', null],
  ])('no-quote-time always alerts, %s', (_label, slotMs) => {
    expect(alertsOnRefusal(CST_DATE, refusal('no-quote-time', slotMs))).toBe(
      true,
    );
  });

  it('bad-entry-time always alerts: it has no slot to place in a session', () => {
    expect(alertsOnRefusal(CST_DATE, refusal('bad-entry-time', null))).toBe(
      true,
    );
  });

  it('never alerts on an accepted quote', () => {
    expect(alertsOnRefusal(CST_DATE, { ok: true, behindMs: 0 })).toBe(false);
  });

  it('does not alert on a stale quote with no slot (cannot be placed)', () => {
    expect(alertsOnRefusal(CST_DATE, refusal('stale-quote', null))).toBe(false);
  });
});
