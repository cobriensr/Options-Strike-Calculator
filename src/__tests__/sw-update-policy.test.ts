import { describe, expect, it } from 'vitest';
import { isSafeToApplyUpdate } from '../lib/sw-update-policy';

/** A visible tab, nothing holding the update, at the given UTC instant. */
function safeAt(
  iso: string,
  overrides: { hidden?: boolean; busy?: boolean } = {},
) {
  return isSafeToApplyUpdate({
    hidden: false,
    busy: false,
    ...overrides,
    now: new Date(iso),
  });
}

// Each row is one instant, written in UTC with its CT wall time beside it. The
// cash session is 08:30 CT (09:30 ET) to the day's close in ET: 16:00 on a
// full day, 13:00 (12:00 CT) on a half-day.
describe('isSafeToApplyUpdate: visible tab, nothing holding the update', () => {
  describe.each([
    // Standard time (EST/CST): Wednesday 2026-12-02.
    [
      'winter Wed 08:29 CT, a minute before the open',
      '2026-12-02T14:29:00Z',
      true,
    ],
    ['winter Wed 08:30 CT, the open', '2026-12-02T14:30:00Z', false],
    ['winter Wed 12:00 CT, midday', '2026-12-02T18:00:00Z', false],
    [
      'winter Wed 14:59 CT, a minute before the close',
      '2026-12-02T20:59:00Z',
      false,
    ],
    ['winter Wed 15:00 CT, the close', '2026-12-02T21:00:00Z', true],
    // Daylight time (EDT/CDT): Wednesday 2026-07-15.
    [
      'summer Wed 08:29 CT, a minute before the open',
      '2026-07-15T13:29:00Z',
      true,
    ],
    ['summer Wed 08:30 CT, the open', '2026-07-15T13:30:00Z', false],
    [
      'summer Wed 14:59 CT, a minute before the close',
      '2026-07-15T19:59:00Z',
      false,
    ],
    ['summer Wed 15:00 CT, the close', '2026-07-15T20:00:00Z', true],
    // The first weekday after each clock change.
    [
      'Mon 2026-03-09 08:29 CDT, after spring forward',
      '2026-03-09T13:29:00Z',
      true,
    ],
    [
      'Mon 2026-03-09 08:30 CDT, after spring forward',
      '2026-03-09T13:30:00Z',
      false,
    ],
    ['Mon 2026-11-02 08:29 CST, after fall back', '2026-11-02T14:29:00Z', true],
    [
      'Mon 2026-11-02 08:30 CST, after fall back',
      '2026-11-02T14:30:00Z',
      false,
    ],
  ])('%s', (_label, iso, expected) => {
    it(`is ${expected ? 'safe' : 'not safe'}`, () => {
      expect(safeAt(iso)).toBe(expected);
    });
  });

  it('reads the same UTC clock time differently in each regime', () => {
    // 14:00 UTC is 08:00 CT before the open in winter, 09:00 CT in the session
    // in summer; a fixed UTC offset gets one of the two wrong.
    expect(safeAt('2026-12-02T14:00:00Z')).toBe(true);
    expect(safeAt('2026-07-15T14:00:00Z')).toBe(false);
  });
});

describe('isSafeToApplyUpdate: half-days close at noon CT', () => {
  describe.each([
    // Standard time: the Friday after Thanksgiving and Christmas Eve.
    ['2026-11-27 08:30 CST', '2026-11-27T14:30:00Z', false],
    [
      '2026-11-27 11:59 CST, a minute before the close',
      '2026-11-27T17:59:00Z',
      false,
    ],
    ['2026-11-27 12:00 CST, the close', '2026-11-27T18:00:00Z', true],
    [
      '2026-11-27 14:00 CST, when a full day is still open',
      '2026-11-27T20:00:00Z',
      true,
    ],
    [
      '2026-12-24 11:59 CST, a minute before the close',
      '2026-12-24T17:59:00Z',
      false,
    ],
    ['2026-12-24 12:00 CST, the close', '2026-12-24T18:00:00Z', true],
    // Daylight time: the day before Independence Day, 2028.
    [
      '2028-07-03 11:59 CDT, a minute before the close',
      '2028-07-03T16:59:00Z',
      false,
    ],
    ['2028-07-03 12:00 CDT, the close', '2028-07-03T17:00:00Z', true],
  ])('%s', (_label, iso, expected) => {
    it(`is ${expected ? 'safe' : 'not safe'}`, () => {
      expect(safeAt(iso)).toBe(expected);
    });
  });

  it('keeps a full day open at the same wall time', () => {
    // Wednesday 2026-12-02 12:00 CT is mid-session; the half-day rows above
    // show the same wall time is after the close on 2026-11-27.
    expect(safeAt('2026-12-02T18:00:00Z')).toBe(false);
  });
});

describe('isSafeToApplyUpdate: weekends and holidays are outside the session', () => {
  it.each([
    ['Saturday 10:00 CST', '2026-12-05T16:00:00Z'],
    ['Sunday 10:00 CST', '2026-12-06T16:00:00Z'],
    ['Saturday 10:00 CDT', '2026-07-11T15:00:00Z'],
    ['Sunday 10:00 CDT', '2026-07-12T15:00:00Z'],
    ['Thanksgiving 2026-11-26 10:00 CST', '2026-11-26T16:00:00Z'],
    ['Christmas 2026-12-25 10:00 CST', '2026-12-25T16:00:00Z'],
    ['Independence Day observed 2026-07-03 10:00 CDT', '2026-07-03T15:00:00Z'],
  ])('%s is safe', (_label, iso) => {
    expect(safeAt(iso)).toBe(true);
  });
});

describe('isSafeToApplyUpdate: a hidden tab', () => {
  it.each([
    ['mid-session on a full day', '2026-12-02T18:00:00Z'],
    ['mid-session in summer', '2026-07-15T17:00:00Z'],
    ['mid-session on a half-day', '2026-11-27T16:00:00Z'],
    ['outside the session', '2026-12-05T16:00:00Z'],
  ])('is safe %s', (_label, iso) => {
    expect(safeAt(iso, { hidden: true })).toBe(true);
  });
});

describe('isSafeToApplyUpdate: a hold on the update', () => {
  it.each([
    ['a hidden tab mid-session', '2026-12-02T18:00:00Z', { hidden: true }],
    ['a visible tab mid-session', '2026-12-02T18:00:00Z', { hidden: false }],
    ['a visible tab on a weekend', '2026-12-05T16:00:00Z', { hidden: false }],
    ['a hidden tab on a holiday', '2026-11-26T16:00:00Z', { hidden: true }],
    ['a hidden tab after the close', '2026-12-02T21:30:00Z', { hidden: true }],
  ])('is never safe for %s', (_label, iso, tab) => {
    expect(safeAt(iso, { ...tab, busy: true })).toBe(false);
  });
});
