// @vitest-environment node

import { describe, it, expect } from 'vitest';

import {
  computeExpectedMove,
  fractionalDte,
  isPreOpenStamp,
  isSessionOver,
  smoothedAtmIv,
} from '../_lib/gexbot-expected-move.js';
import type { DecodedStrikeIv } from '../_lib/periscope-gexbot.js';

function iv(
  strike: number,
  callIv: number | null,
  putIv: number | null,
): DecodedStrikeIv {
  return { strike, callIv, putIv };
}

/** 6325 is the strike nearest 6326.27; its mean IV is 0.11. */
const CHAIN: DecodedStrikeIv[] = [
  iv(6320, 0.12, 0.12),
  iv(6325, 0.1, 0.12),
  iv(6330, 0.1, 0.1),
];

describe('smoothedAtmIv', () => {
  it('weights the strike nearest spot 50% and its two neighbours 25% each', () => {
    // 0.5 x 0.11 + 0.25 x 0.12 + 0.25 x 0.10
    const got = smoothedAtmIv(CHAIN, 6326.27);
    expect(got?.atmStrike).toBe(6325);
    expect(got?.iv).toBeCloseTo(0.11, 12);
  });

  it('does not depend on the order of the rows', () => {
    const shuffled = [CHAIN[2]!, CHAIN[0]!, CHAIN[1]!];
    const got = smoothedAtmIv(shuffled, 6326.27);
    expect(got?.atmStrike).toBe(6325);
    expect(got?.iv).toBeCloseTo(0.11, 12);
  });

  it('uses the one quoted side when the other is missing', () => {
    const got = smoothedAtmIv(
      [iv(6320, null, 0.12), iv(6325, 0.11, null), iv(6330, 0.1, null)],
      6326,
    );
    expect(got?.iv).toBeCloseTo(0.11, 12);
  });

  it('re-weights over the strikes that have an IV when a neighbour has none', () => {
    // (0.5 x 0.11 + 0.25 x 0.10) / 0.75
    const got = smoothedAtmIv(
      [iv(6320, null, null), iv(6325, 0.11, 0.11), iv(6330, 0.1, 0.1)],
      6326,
    );
    expect(got?.iv).toBeCloseTo(0.10666666666666667, 12);
  });

  it('re-weights when the ATM strike is the first or last listed', () => {
    const got = smoothedAtmIv([iv(6325, 0.11, 0.11), iv(6330, 0.1, 0.1)], 6300);
    expect(got?.atmStrike).toBe(6325);
    expect(got?.iv).toBeCloseTo(0.10666666666666667, 12);
  });

  it('returns the ATM IV alone when it is the only strike', () => {
    expect(smoothedAtmIv([iv(6325, 0.11, 0.13)], 6326)).toEqual({
      atmStrike: 6325,
      iv: 0.12,
    });
  });

  it('breaks an exact tie toward the lower strike', () => {
    const got = smoothedAtmIv(
      [iv(6325, 0.11, 0.11), iv(6330, 0.2, 0.2)],
      6327.5,
    );
    expect(got?.atmStrike).toBe(6325);
  });

  it('returns null when the ATM strike has no IV, even if its neighbours do', () => {
    expect(
      smoothedAtmIv(
        [iv(6320, 0.12, 0.12), iv(6325, null, null), iv(6330, 0.1, 0.1)],
        6326,
      ),
    ).toBeNull();
  });

  it('returns null for an empty chain', () => {
    expect(smoothedAtmIv([], 6326)).toBeNull();
  });
});

describe('fractionalDte', () => {
  it('is the seconds left to the 16:00 ET close over 86,400 on a 0DTE (EDT)', () => {
    // 11:13:12 ET, 17,208 s before the close.
    const asOf = new Date('2025-07-23T15:13:12Z');
    expect(fractionalDte(asOf, 0)).toBeCloseTo(17208 / 86400, 12);
  });

  it('uses the same close in winter (EST)', () => {
    // 10:00 ET, six hours before the 21:00 UTC close.
    expect(fractionalDte(new Date('2026-01-15T15:00:00Z'), 0)).toBeCloseTo(
      0.25,
      12,
    );
  });

  // Owner decision 2026-11-25: the SIZE of the move uses GEXBot's documented
  // clock (seconds to 4:00 PM ET) on every day. On a half day the IV is most
  // likely solved against that clock, so 16:00 keeps sigma x sqrt(T) equal to
  // the priced move. The session itself still ends at the calendar close
  // (see `isSessionOver`).
  it('counts a half day down to 16:00 ET too, as the vendor documents', () => {
    // Black Friday 2026, 12:00 ET: four hours to 16:00, not one hour to 13:00.
    expect(fractionalDte(new Date('2026-11-27T17:00:00Z'), 0)).toBeCloseTo(
      (4 * 3600) / 86400,
      12,
    );
  });

  it('keeps counting on a half day after 13:00 ET until 16:00', () => {
    // 13:30 ET: the session is over, but the vendor clock has 2.5 h left.
    expect(fractionalDte(new Date('2026-11-27T18:30:00Z'), 0)).toBeCloseTo(
      (2.5 * 3600) / 86400,
      12,
    );
  });

  it('adds whole days for an expiry that is not today', () => {
    expect(fractionalDte(new Date('2026-01-15T15:00:00Z'), 1)).toBeCloseTo(
      1.25,
      12,
    );
  });

  it('never goes negative after the close', () => {
    const afterClose = new Date('2026-01-15T22:30:00Z');
    expect(fractionalDte(afterClose, 0)).toBe(0);
    expect(fractionalDte(afterClose, 2)).toBe(2);
  });

  it('returns null on a market holiday', () => {
    expect(fractionalDte(new Date('2026-12-25T15:00:00Z'), 0)).toBeNull();
  });

  it('returns null for a DTE that is negative or not finite', () => {
    const asOf = new Date('2026-01-15T15:00:00Z');
    expect(fractionalDte(asOf, -1)).toBeNull();
    expect(fractionalDte(asOf, Number.NaN)).toBeNull();
  });

  it('returns null for an invalid date', () => {
    expect(fractionalDte(new Date('nope'), 0)).toBeNull();
  });
});

describe('isSessionOver', () => {
  it.each([
    // [label, instant (UTC), over]
    ['one second before the 16:00 ET close', '2026-01-15T20:59:59Z', false],
    ['at the 16:00 ET close', '2026-01-15T21:00:00Z', true],
    ['after the 16:00 ET close', '2026-01-15T22:30:00Z', true],
    [
      'one second before the 13:00 ET half-day close',
      '2026-11-27T17:59:59Z',
      false,
    ],
    ['at the 13:00 ET half-day close', '2026-11-27T18:00:00Z', true],
    ['one second after the half-day close', '2026-11-27T18:00:01Z', true],
    ['mid-morning on a half day', '2026-11-27T15:00:00Z', false],
  ])('%s', (_label, iso, over) => {
    expect(isSessionOver(new Date(iso))).toBe(over);
  });

  it('is false on a market holiday and for an invalid date', () => {
    expect(isSessionOver(new Date('2026-12-25T22:00:00Z'))).toBe(false);
    expect(isSessionOver(new Date('nope'))).toBe(false);
  });
});

describe('isPreOpenStamp', () => {
  const captured = new Date('2025-07-23T15:13:14Z'); // 11:13 ET

  it('is true when the vendor stamp is on an earlier ET date than the capture', () => {
    expect(isPreOpenStamp(new Date('2025-07-22T20:00:00Z'), captured)).toBe(
      true,
    );
  });

  it('is true for a same-day stamp from the vendor premarket roll (08:20 ET)', () => {
    expect(
      isPreOpenStamp(
        new Date('2025-07-23T12:20:00Z'),
        new Date('2025-07-23T13:30:05Z'),
      ),
    ).toBe(true);
  });

  it.each([
    // [label, stamp (UTC), stamp is before the open]
    ['one second before 09:30 ET (EDT)', '2025-07-23T13:29:59Z', true],
    ['at 09:30:00 ET (EDT)', '2025-07-23T13:30:00Z', false],
    ['one second after 09:30 ET (EDT)', '2025-07-23T13:30:01Z', false],
    ['one second before 09:30 ET (EST)', '2025-12-10T14:29:59Z', true],
    ['at 09:30:00 ET (EST)', '2025-12-10T14:30:00Z', false],
  ])('%s', (_label, stamp, before) => {
    // The capture sits a few seconds after the open on the stamp's own date.
    const capturedAt = new Date(new Date(stamp).getTime() + 10_000);
    expect(isPreOpenStamp(new Date(stamp), capturedAt)).toBe(before);
  });

  it('compares ET dates, not UTC dates', () => {
    // 03:00Z on the 23rd is 23:00 ET on the 22nd: the same UTC day as the
    // 13:31Z capture, a different ET day.
    expect(
      isPreOpenStamp(
        new Date('2025-07-23T03:00:00Z'),
        new Date('2025-07-23T13:31:00Z'),
      ),
    ).toBe(true);
  });

  it('takes the open from the capture ET date when the UTC date has rolled', () => {
    // 21:00 ET on the 23rd is 01:00Z on the 24th: the ET day is the 23rd, so
    // the bound is the 23rd 09:30 ET and a stamp after it is kept.
    expect(
      isPreOpenStamp(
        new Date('2025-07-24T01:00:00Z'),
        new Date('2025-07-24T01:00:02Z'),
      ),
    ).toBe(false);
  });

  it('is false for a stamp after the open on the same ET date, before or after the close', () => {
    expect(isPreOpenStamp(new Date('2025-07-23T15:13:12Z'), captured)).toBe(
      false,
    );
    expect(
      isPreOpenStamp(
        new Date('2025-07-23T20:00:00Z'),
        new Date('2025-07-23T20:03:00Z'),
      ),
    ).toBe(false);
  });

  it('is false for a stamp later than the capture', () => {
    expect(isPreOpenStamp(new Date('2025-07-24T15:00:00Z'), captured)).toBe(
      false,
    );
  });
});

describe('computeExpectedMove', () => {
  const asOf = new Date('2025-07-23T15:13:12Z');

  it('is spot x smoothed ATM IV x sqrt(fractional DTE / 365)', () => {
    const got = computeExpectedMove({
      spot: 6326.27,
      minDte: 0,
      strikes: CHAIN,
      asOf,
    });
    expect(got.unavailable).toBeNull();
    expect(got.atmStrike).toBe(6325);
    expect(got.atmIv).toBeCloseTo(0.11, 12);
    expect(got.dteFraction).toBeCloseTo(0.19916666666666666, 12);
    // 6326.27 x 0.11 x sqrt(0.199166... / 365), worked by hand.
    expect(got.expectedMove).toBeCloseTo(16.25557378390728, 9);
    expect(got.lower).toBeCloseTo(6310.014426216093, 9);
    expect(got.upper).toBeCloseTo(6342.525573783908, 9);
  });

  it.each([
    ['null', null],
    ['zero', 0],
    ['negative', -5],
    ['not finite', Number.NaN],
  ])('reports no_spot for a %s spot', (_label, spot) => {
    const got = computeExpectedMove({ spot, minDte: 0, strikes: CHAIN, asOf });
    expect(got).toEqual({
      spot: null,
      minDte: 0,
      atmStrike: null,
      atmIv: null,
      dteFraction: null,
      expectedMove: null,
      lower: null,
      upper: null,
      unavailable: 'no_spot',
    });
  });

  it('reports no_dte when the vendor did not send min_dte', () => {
    const got = computeExpectedMove({
      spot: 6326.27,
      minDte: null,
      strikes: CHAIN,
      asOf,
    });
    expect(got.unavailable).toBe('no_dte');
    expect(got.spot).toBe(6326.27);
    expect(got.expectedMove).toBeNull();
  });

  it('reports no_dte on a market holiday', () => {
    const got = computeExpectedMove({
      spot: 6326.27,
      minDte: 0,
      strikes: CHAIN,
      asOf: new Date('2026-12-25T15:00:00Z'),
    });
    expect(got.unavailable).toBe('no_dte');
  });

  it('reports expired for a 0DTE read at or after the close', () => {
    const got = computeExpectedMove({
      spot: 6326.27,
      minDte: 0,
      strikes: CHAIN,
      asOf: new Date('2025-07-23T20:00:00Z'),
    });
    expect(got.unavailable).toBe('expired');
    expect(got.dteFraction).toBe(0);
    expect(got.expectedMove).toBeNull();
  });

  describe('on a half day (2026-11-27, closes 13:00 ET)', () => {
    const run = (iso: string, minDte = 0) =>
      computeExpectedMove({
        spot: 6326.27,
        minDte,
        strikes: CHAIN,
        asOf: new Date(iso),
      });

    it('sizes the move with 4 h of time left at 12:00 ET, on the 16:00 clock', () => {
      const got = run('2026-11-27T17:00:00Z');
      expect(got.unavailable).toBeNull();
      expect(got.dteFraction).toBeCloseTo(4 / 24, 12);
      // 6326.27 x 0.11 x sqrt((4/24) / 365), worked by hand.
      expect(got.expectedMove).toBeCloseTo(14.87, 2);
    });

    it('is still live at 12:59:59 ET', () => {
      const got = run('2026-11-27T17:59:59Z');
      expect(got.unavailable).toBeNull();
      expect(got.expectedMove).not.toBeNull();
    });

    it.each([
      ['13:00:00 ET', '2026-11-27T18:00:00Z'],
      ['13:00:01 ET', '2026-11-27T18:00:01Z'],
      ['15:30 ET', '2026-11-27T20:30:00Z'],
    ])('is expired at %s: the session has closed', (_label, iso) => {
      const got = run(iso);
      expect(got.unavailable).toBe('expired');
      expect(got.dteFraction).toBe(0);
      expect(got.expectedMove).toBeNull();
      expect(got.lower).toBeNull();
      expect(got.upper).toBeNull();
    });

    it('does not expire a 1DTE read after the half-day close', () => {
      // 13:30 ET: 2.5 h to 16:00 on top of the whole day to the next expiry.
      const got = run('2026-11-27T18:30:00Z', 1);
      expect(got.unavailable).toBeNull();
      expect(got.dteFraction).toBeCloseTo(1 + 2.5 / 24, 12);
    });
  });

  it('is unchanged on a normal day: live at 15:59:59 ET, expired at 16:00', () => {
    const live = computeExpectedMove({
      spot: 6326.27,
      minDte: 0,
      strikes: CHAIN,
      asOf: new Date('2025-07-23T19:59:59Z'),
    });
    expect(live.unavailable).toBeNull();
    expect(live.dteFraction).toBeCloseTo(1 / 86400, 12);
    const closed = computeExpectedMove({
      spot: 6326.27,
      minDte: 0,
      strikes: CHAIN,
      asOf: new Date('2025-07-23T20:00:00Z'),
    });
    expect(closed.unavailable).toBe('expired');
  });

  it('reports no_atm_iv when the ATM strike carries no IV', () => {
    const got = computeExpectedMove({
      spot: 6326.27,
      minDte: 0,
      strikes: [iv(6325, null, null), iv(6330, 0.1, 0.1)],
      asOf,
    });
    expect(got.unavailable).toBe('no_atm_iv');
    expect(got.dteFraction).toBeCloseTo(0.19916666666666666, 12);
    expect(got.atmIv).toBeNull();
    expect(got.expectedMove).toBeNull();
  });
});
