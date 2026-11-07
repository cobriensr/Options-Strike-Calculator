// @vitest-environment node

/**
 * closedBuckets turns UW's per-minute cumulative tide grid into the 5-minute
 * flow_data rows the live crons may store: today's session only (R-day), no
 * missing value stored as 0 or NULL (R-null), a bucket only once it closed
 * and settled (R-closed), stamped at its end (label rule).
 * Spec: docs/superpowers/specs/live-data-integrity-2026-11-06.md
 *
 * 2026-03-24 is on EDT (UTC-4): the 09:30 ET open is 13:30Z, 16:00 ET is 20:00Z.
 * 2026-11-27 is a half day on EST (UTC-5): 09:30 ET is 14:30Z, 13:00 ET is 18:00Z.
 */

import { describe, it, expect } from 'vitest';

import {
  BUCKET_MS,
  FINAL_LAG_MS,
  LAST_ATTEMPT_AFTER_CLOSE_MS,
  STUCK_AFTER_MS,
  closedBuckets,
  isDegenerate,
  isFeedStalled,
  sessionWindowIso,
  type TideMinute,
} from '../_lib/closed-buckets.js';

const DAY = '2026-03-24';
const MINUTE = 60_000;
const at = (hhmmZ: string, day = DAY): Date => new Date(`${day}T${hhmmZ}:00Z`);

/** A minute row whose cumulative ncp is its minute-of-session, so each bucket's value names its last minute. */
function minuteRow(
  start: Date,
  overrides: Partial<TideMinute> = {},
): TideMinute {
  const sinceOpen = (start.getTime() - at('13:30').getTime()) / MINUTE;
  return {
    timestamp: start.toISOString(),
    net_call_premium: String(1000 + sinceOpen),
    net_put_premium: String(-500 - sinceOpen),
    net_volume: 10 + sinceOpen,
    ...overrides,
  };
}

/**
 * UW's prefilled grid: one row per minute from `from` (inclusive) to `to`
 * (exclusive). Minutes that start at or after `filledUntil` have not happened
 * yet, so UW sends them with null values.
 */
function grid(from: Date, to: Date, filledUntil: Date): TideMinute[] {
  const rows: TideMinute[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += MINUTE) {
    const start = new Date(t);
    rows.push(
      t < filledUntil.getTime()
        ? minuteRow(start)
        : {
            timestamp: start.toISOString(),
            net_call_premium: null,
            net_put_premium: null,
            net_volume: null,
          },
    );
  }
  return rows;
}

const SESSION_OPEN = at('13:30');
const SESSION_CLOSE = at('20:00');

/** The grid with one minute's fields replaced. */
const withMinute = (
  rows: TideMinute[],
  hhmmZ: string,
  overrides: Partial<TideMinute>,
): TideMinute[] =>
  rows.map((r) =>
    r.timestamp === `${DAY}T${hhmmZ}:00.000Z` ? { ...r, ...overrides } : r,
  );

describe('closedBuckets', () => {
  it('stores nothing from a payload holding only the previous session (the 09:27 ET answer)', () => {
    const yesterday = grid(
      at('13:30', '2026-03-23'),
      at('20:00', '2026-03-23'),
      at('20:00', '2026-03-23'),
    );
    const result = closedBuckets(yesterday, at('13:27'));
    expect(result.buckets).toEqual([]);
    expect(result.sessionRows).toBe(0);
    expect(result.pending).toBe(0);
    expect(result.stuck).toBe(0);
  });

  it('stores nothing at 09:32 ET from the prefilled grid, because no bucket has closed', () => {
    const rows = grid(SESSION_OPEN, SESSION_CLOSE, at('13:32'));
    const result = closedBuckets(rows, at('13:32'));
    expect(result.sessionRows).toBe(390);
    expect(result.buckets).toEqual([]);
    expect(result.pending).toBe(0);
    expect(result.stuck).toBe(0);
  });

  it('stores only the closed, filled buckets at bucket-end labels (10:02 ET)', () => {
    const rows = grid(SESSION_OPEN, SESSION_CLOSE, at('14:02'));
    const result = closedBuckets(rows, at('14:02'));
    expect(result.buckets.map((b) => b.timestamp)).toEqual([
      '2026-03-24T13:35:00.000Z',
      '2026-03-24T13:40:00.000Z',
      '2026-03-24T13:45:00.000Z',
      '2026-03-24T13:50:00.000Z',
      '2026-03-24T13:55:00.000Z',
      '2026-03-24T14:00:00.000Z',
    ]);
    // The 14:00-14:05 bucket is open: its minutes 14:00 and 14:01 have values
    // but its last minute (14:04) is still null. Not stored, not counted bad.
    expect(result.pending).toBe(0);
    expect(result.stuck).toBe(0);
  });

  it("takes each bucket's value from its last minute, whatever order UW sent the rows in", () => {
    const rows = grid(SESSION_OPEN, SESSION_CLOSE, at('13:42')).reverse();
    const result = closedBuckets(rows, at('13:42'));
    // 13:30-13:35 bucket: last minute 13:34 is minute 4 of the session.
    // 13:35-13:40 bucket: last minute 13:39 is minute 9.
    expect(result.buckets).toEqual([
      {
        timestamp: '2026-03-24T13:35:00.000Z',
        ncp: 1004,
        npp: -504,
        netVolume: 14,
      },
      {
        timestamp: '2026-03-24T13:40:00.000Z',
        ncp: 1009,
        npp: -509,
        netVolume: 19,
      },
    ]);
  });

  it('waits FINAL_LAG_MS after a bucket ends before calling it closed (R-closed)', () => {
    const rows = grid(SESSION_OPEN, SESSION_CLOSE, at('13:50'));
    const end = at('13:35').getTime();
    expect(FINAL_LAG_MS).toBe(90_000);
    // Ended, but not settled: the 13:34 minute may still be provisional.
    expect(closedBuckets(rows, new Date(end)).buckets).toHaveLength(0);
    expect(
      closedBuckets(rows, new Date(end + FINAL_LAG_MS - 1)).buckets,
    ).toHaveLength(0);
    expect(
      closedBuckets(rows, new Date(end + FINAL_LAG_MS)).buckets,
    ).toHaveLength(1);
  });

  it('does not count a bucket that has not settled as pending or stuck', () => {
    const rows = withMinute(
      grid(SESSION_OPEN, SESSION_CLOSE, at('13:50')),
      '13:34',
      { net_call_premium: null },
    );
    const result = closedBuckets(rows, new Date(at('13:35').getTime() + 1000));
    expect(result.buckets).toHaveLength(0);
    expect(result.pending).toBe(0);
    expect(result.stuck).toBe(0);
  });

  it('stores the last bucket of the day (15:55-16:00 ET) once it has settled', () => {
    const rows = grid(SESSION_OPEN, SESSION_CLOSE, SESSION_CLOSE);
    const early = closedBuckets(rows, at('19:59'));
    expect(early.buckets.at(-1)?.timestamp).toBe('2026-03-24T19:55:00.000Z');
    const afterClose = closedBuckets(rows, at('20:02'));
    expect(afterClose.buckets).toHaveLength(78);
    expect(afterClose.buckets.at(-1)).toEqual({
      timestamp: '2026-03-24T20:00:00.000Z',
      // Last minute 15:59 ET is minute 389 of the session.
      ncp: 1389,
      npp: -889,
      netVolume: 399,
    });
  });

  it('leaves out a closed bucket whose last minute is null and counts it as stuck once it is 10 minutes old', () => {
    const rows = withMinute(
      grid(SESSION_OPEN, SESSION_CLOSE, at('14:02')),
      '13:44',
      { net_call_premium: null, net_put_premium: null },
    );
    const result = closedBuckets(rows, at('14:02'));
    expect(result.buckets.map((b) => b.timestamp)).not.toContain(
      '2026-03-24T13:45:00.000Z',
    );
    expect(result.buckets).toHaveLength(5);
    // The bucket ended 13:45, 17 minutes before 14:02.
    expect(result.stuck).toBe(1);
    expect(result.pending).toBe(0);
    expect(result.oldestStuck).toBe('2026-03-24T13:45:00.000Z');
  });

  it('leaves out a closed bucket whose last minute row is absent, even when earlier minutes exist', () => {
    const rows = grid(SESSION_OPEN, SESSION_CLOSE, at('14:02')).filter(
      (r) => r.timestamp !== '2026-03-24T13:44:00.000Z',
    );
    const result = closedBuckets(rows, at('14:02'));
    expect(result.buckets.map((b) => b.timestamp)).not.toContain(
      '2026-03-24T13:45:00.000Z',
    );
    expect(result.stuck).toBe(1);
  });

  it('calls an unusable bucket pending until it is STUCK_AFTER_MS old, and stuck from then on', () => {
    const rows = withMinute(
      grid(SESSION_OPEN, SESSION_CLOSE, at('14:30')),
      '13:44',
      { net_call_premium: null },
    );
    const end = at('13:45').getTime();
    expect(STUCK_AFTER_MS).toBe(10 * MINUTE);

    const justBefore = closedBuckets(rows, new Date(end + STUCK_AFTER_MS - 1));
    expect(justBefore.pending).toBe(1);
    expect(justBefore.stuck).toBe(0);
    expect(justBefore.oldestStuck).toBeNull();

    const atLimit = closedBuckets(rows, new Date(end + STUCK_AFTER_MS));
    expect(atLimit.pending).toBe(0);
    expect(atLimit.stuck).toBe(1);
  });

  it('names the OLDEST stuck bucket', () => {
    let rows = withMinute(
      grid(SESSION_OPEN, SESSION_CLOSE, at('14:30')),
      '13:54',
      { net_call_premium: null },
    );
    rows = withMinute(rows, '13:44', { net_put_premium: 'garbage' });
    const result = closedBuckets(rows, at('14:30'));
    expect(result.stuck).toBe(2);
    expect(result.oldestStuck).toBe('2026-03-24T13:45:00.000Z');
  });

  it.each([
    ['16:02 ET, the ETF first attempt', '20:02:00', 'pending'],
    ['16:04 ET, the zero-DTE first attempt', '20:04:00', 'pending'],
    ['16:04:59 ET, a second before close + 5 min', '20:04:59', 'pending'],
    ['16:05:00 ET, close + 5 min', '20:05:00', 'stuck'],
    ['16:07 ET, the ETF last attempt', '20:07:00', 'stuck'],
    ['16:09 ET, the zero-DTE last attempt', '20:09:00', 'stuck'],
  ])(
    'the final bucket (15:55-16:00) with a null last minute at %s is %s',
    (_label, timeZ, expected) => {
      // The bucket ended 2 to 9 minutes before, so by the age rule alone it is
      // pending at every one of these times and its loss would be silent.
      const rows = withMinute(
        grid(SESSION_OPEN, SESSION_CLOSE, SESSION_CLOSE),
        '19:59',
        { net_call_premium: null },
      );
      const result = closedBuckets(rows, new Date(`${DAY}T${timeZ}Z`));
      expect(result.buckets).toHaveLength(77);
      expect(result.stuck).toBe(expected === 'stuck' ? 1 : 0);
      expect(result.pending).toBe(expected === 'pending' ? 1 : 0);
      expect(result.oldestStuck).toBe(
        expected === 'stuck' ? '2026-03-24T20:00:00.000Z' : null,
      );
    },
  );

  it('keeps the after-close rule to the final bucket: LAST_ATTEMPT_AFTER_CLOSE_MS + BUCKET_MS <= STUCK_AFTER_MS', () => {
    // Every other bucket ended at least BUCKET_MS before the final one, so at
    // close + LAST_ATTEMPT_AFTER_CLOSE_MS it is already STUCK_AFTER_MS old and
    // the age rule had stuck it. Raise LAST_ATTEMPT_AFTER_CLOSE_MS past this
    // bound and the rule would call a bucket stuck that the age rule calls
    // pending.
    expect(LAST_ATTEMPT_AFTER_CLOSE_MS + BUCKET_MS).toBeLessThanOrEqual(
      STUCK_AFTER_MS,
    );
  });

  it.each([
    ['16:04:59 ET, a second before close + 5 min', '20:04:59', 'pending'],
    ['16:05:00 ET, close + 5 min', '20:05:00', 'stuck'],
    ['16:09 ET, the zero-DTE last attempt', '20:09:00', 'stuck'],
  ])(
    'the bucket before the final one (15:50-15:55) with a null last minute at %s is %s, exactly as its age says',
    (_label, timeZ, expected) => {
      // It ended 10 minutes before close + 5: the age rule (STUCK_AFTER_MS)
      // and the after-close rule agree to the millisecond, so the after-close
      // rule never decides for it. The final bucket stays the only one the
      // rule touches.
      const rows = withMinute(
        grid(SESSION_OPEN, SESSION_CLOSE, SESSION_CLOSE),
        '19:54',
        { net_call_premium: null },
      );
      const result = closedBuckets(rows, new Date(`${DAY}T${timeZ}Z`));
      expect(result.stuck).toBe(expected === 'stuck' ? 1 : 0);
      expect(result.pending).toBe(expected === 'pending' ? 1 : 0);
      expect(result.oldestStuck).toBe(
        expected === 'stuck' ? '2026-03-24T19:55:00.000Z' : null,
      );
    },
  );

  it('the final bucket on an early-close day is stuck from 13:05 ET, not from 16:05', () => {
    const half = '2026-11-27'; // EST: 13:00 ET is 18:00Z
    const rows = grid(
      new Date(`${half}T14:30:00Z`),
      new Date(`${half}T18:00:00Z`),
      new Date(`${half}T18:00:00Z`),
    ).map((r) =>
      r.timestamp === `${half}T17:59:00.000Z`
        ? { ...r, net_put_premium: 'garbage' }
        : r,
    );

    const before = closedBuckets(rows, new Date(`${half}T18:04:59Z`));
    expect(before.pending).toBe(1);
    expect(before.stuck).toBe(0);

    const after = closedBuckets(rows, new Date(`${half}T18:05:00Z`));
    expect(after.pending).toBe(0);
    expect(after.stuck).toBe(1);
    expect(after.oldestStuck).toBe(`${half}T18:00:00.000Z`);
  });

  it('keeps a bucket that is only a few minutes late pending during the session', () => {
    // The same 7 minutes of age as the ETF last attempt, but mid-session.
    const rows = withMinute(
      grid(SESSION_OPEN, SESSION_CLOSE, at('14:12')),
      '14:04',
      { net_call_premium: null },
    );
    const result = closedBuckets(rows, at('14:12'));
    expect(result.pending).toBe(1);
    expect(result.stuck).toBe(0);
    expect(LAST_ATTEMPT_AFTER_CLOSE_MS).toBe(5 * MINUTE);
  });

  it.each([
    ['NaN premium', { net_call_premium: 'not-a-number' }],
    ['blank premium', { net_put_premium: '   ' }],
    ['missing premium', { net_call_premium: undefined }],
    ['infinite premium', { net_put_premium: 'Infinity' }],
    ['blank net_volume', { net_volume: '  ' }],
    ['unparseable net_volume', { net_volume: 'n/a' }],
    ['fractional net_volume', { net_volume: 12.5 }],
    ['net_volume above INTEGER', { net_volume: 2_147_483_648 }],
    ['net_volume below INTEGER', { net_volume: -2_147_483_649 }],
    ['premium of 1e13 (outside DECIMAL(14,2))', { net_call_premium: 1e13 }],
    ['premium of 1e12 as a string', { net_put_premium: '1000000000000' }],
    ['negative premium of 1e13', { net_put_premium: -1e13 }],
  ])(
    'never stores a past minute with a %s as 0 or NULL',
    (_label, overrides) => {
      const rows = withMinute(
        grid(SESSION_OPEN, SESSION_CLOSE, at('14:02')),
        '13:49',
        overrides,
      );
      const result = closedBuckets(rows, at('14:02'));
      expect(result.buckets.map((b) => b.timestamp)).not.toContain(
        '2026-03-24T13:50:00.000Z',
      );
      expect(result.stuck).toBe(1);
      for (const b of result.buckets) {
        expect(Number.isFinite(b.ncp)).toBe(true);
        expect(Number.isFinite(b.npp)).toBe(true);
      }
    },
  );

  it.each([
    ['net_volume null', { net_volume: null }],
    ['net_volume undefined', { net_volume: undefined }],
  ])(
    'stores NULL for a bucket whose last minute has %s, as the backfill does',
    (_label, overrides) => {
      const rows = withMinute(
        grid(SESSION_OPEN, SESSION_CLOSE, at('13:42')),
        '13:34',
        overrides,
      );
      expect(closedBuckets(rows, at('13:42')).buckets[0]).toEqual({
        timestamp: '2026-03-24T13:35:00.000Z',
        ncp: 1004,
        npp: -504,
        netVolume: null,
      });
    },
  );

  it.each([
    [
      'the largest INTEGER',
      { net_volume: 2_147_483_647 },
      'netVolume',
      2_147_483_647,
    ],
    [
      'the smallest INTEGER',
      { net_volume: '-2147483648' },
      'netVolume',
      -2_147_483_648,
    ],
    [
      'the largest DECIMAL(14,2) premium',
      { net_call_premium: '999999999999.99' },
      'ncp',
      999_999_999_999.99,
    ],
    [
      'the smallest DECIMAL(14,2) premium',
      { net_put_premium: -999_999_999_999.99 },
      'npp',
      -999_999_999_999.99,
    ],
  ] as const)('stores %s', (_label, overrides, field, expected) => {
    const rows = withMinute(
      grid(SESSION_OPEN, SESSION_CLOSE, at('13:42')),
      '13:34',
      overrides,
    );
    const first = closedBuckets(rows, at('13:42')).buckets[0];
    expect(first?.[field]).toBe(expected);
  });

  it('does not look at a bad value in the middle of a bucket, since only the last minute is stored', () => {
    const rows = withMinute(
      grid(SESSION_OPEN, SESSION_CLOSE, at('14:02')),
      '13:47',
      { net_call_premium: 'garbage' },
    );
    const result = closedBuckets(rows, at('14:02'));
    expect(result.buckets).toHaveLength(6);
    expect(result.stuck + result.pending).toBe(0);
  });

  it('stores a real zero: only a missing value is refused', () => {
    const rows = withMinute(
      grid(SESSION_OPEN, SESSION_CLOSE, at('13:40')),
      '13:34',
      { net_call_premium: '0', net_put_premium: 0, net_volume: 0 },
    );
    const first = closedBuckets(rows, at('13:40')).buckets[0];
    expect(first).toEqual({
      timestamp: '2026-03-24T13:35:00.000Z',
      ncp: 0,
      npp: 0,
      netVolume: 0,
    });
  });

  it('accepts numbers and numeric strings for every value', () => {
    const rows = [
      {
        timestamp: '2026-03-24T13:34:00.000Z',
        net_call_premium: 12.5,
        net_put_premium: '-3.25',
        net_volume: '7',
      },
    ];
    expect(closedBuckets(rows, at('13:37')).buckets).toEqual([
      {
        timestamp: '2026-03-24T13:35:00.000Z',
        ncp: 12.5,
        npp: -3.25,
        netVolume: 7,
      },
    ]);
  });

  it('drops pre-open rows, keeping 09:30:00 ET itself (EDT)', () => {
    const rows = [
      minuteRow(at('13:29')),
      minuteRow(at('13:30')),
      minuteRow(at('13:34')),
    ];
    const result = closedBuckets(rows, at('13:37'));
    expect(result.sessionRows).toBe(2);
    expect(result.buckets).toHaveLength(1);
  });

  it('applies the 09:30 ET open on an EST date too (14:30Z)', () => {
    const est = (hhmm: string) => new Date(`2026-01-15T${hhmm}:00Z`);
    const rows = [minuteRow(est('14:29')), minuteRow(est('14:34'))];
    const result = closedBuckets(rows, est('14:37'));
    expect(result.sessionRows).toBe(1);
    expect(result.buckets.map((b) => b.timestamp)).toEqual([
      '2026-01-15T14:35:00.000Z',
    ]);
  });

  it('leaves out rows at or after 16:00 ET (R-day upper bound)', () => {
    // 15:59 is the last row UW sends. A row at 16:00 ET (20:00Z) would open a
    // 16:00-16:05 bucket that does not exist in the session.
    const rows = [
      minuteRow(at('19:59')),
      minuteRow(at('20:00')),
      minuteRow(at('20:04')),
    ];
    const result = closedBuckets(rows, at('20:12'));
    expect(result.sessionRows).toBe(1);
    expect(result.buckets.map((b) => b.timestamp)).toEqual([
      '2026-03-24T20:00:00.000Z',
    ]);
  });

  it('ends the session at 13:00 ET on an early-close day', () => {
    const half = '2026-11-27';
    const est = (hhmm: string) => new Date(`${half}T${hhmm}:00Z`);
    // 12:59 ET (17:59Z) is the last minute of the half day; 13:00 and 13:04 ET
    // are not session rows.
    const rows = [
      minuteRow(est('17:59')),
      minuteRow(est('18:00')),
      minuteRow(est('18:04')),
    ];
    const result = closedBuckets(rows, est('18:12'));
    expect(result.sessionRows).toBe(1);
    expect(result.buckets.map((b) => b.timestamp)).toEqual([
      '2026-11-27T18:00:00.000Z',
    ]);
  });

  it('ignores a row whose timestamp does not parse', () => {
    const rows = [
      { ...minuteRow(at('13:34')), timestamp: 'garbage' },
      minuteRow(at('13:34')),
    ];
    const result = closedBuckets(rows, at('13:37'));
    expect(result.sessionRows).toBe(1);
    expect(result.buckets).toHaveLength(1);
  });

  it('returns an empty result for an empty payload', () => {
    expect(closedBuckets([], at('14:00'))).toMatchObject({
      buckets: [],
      sessionRows: 0,
      pending: 0,
      stuck: 0,
      oldestStuck: null,
    });
  });

  it('exposes a 5-minute bucket', () => {
    expect(BUCKET_MS).toBe(5 * MINUTE);
  });
});

describe('isDegenerate', () => {
  const zero = { timestamp: 'x', ncp: 0, npp: 0, netVolume: 0 };
  const signal = { timestamp: 'y', ncp: 5, npp: 0, netVolume: 0 };

  it.each([
    ['no usable bucket and a stuck one', { buckets: [], stuck: 1 }, true],
    [
      'no usable bucket and none stuck (UW is just late)',
      { buckets: [], stuck: 0 },
      false,
    ],
    ['only zero buckets', { buckets: [zero, zero], stuck: 0 }, true],
    [
      'a zero bucket and a bucket with premium',
      { buckets: [zero, signal], stuck: 0 },
      false,
    ],
    [
      'a bucket with premium and a stuck one',
      { buckets: [signal], stuck: 3 },
      false,
    ],
  ])('%s', (_label, result, expected) => {
    expect(isDegenerate(result)).toBe(expected);
  });
});

describe('isFeedStalled', () => {
  it.each([
    [
      '09:27 ET, nothing for today: normal pre-open state',
      '2026-03-24T13:27:00Z',
      0,
      false,
    ],
    [
      '09:39 ET, nothing for today: UW may still be rolling over',
      '2026-03-24T13:39:00Z',
      0,
      false,
    ],
    ['09:40 ET, nothing for today', '2026-03-24T13:40:00Z', 0, true],
    ['10:12 ET, nothing for today', '2026-03-24T14:12:00Z', 0, true],
    ['09:40 ET on EST, nothing for today', '2026-01-15T14:40:00Z', 0, true],
    ['10:12 ET, rows for today', '2026-03-24T14:12:00Z', 390, false],
  ])('%s', (_label, iso, sessionRows, expected) => {
    expect(isFeedStalled(sessionRows, new Date(iso))).toBe(expected);
  });
});

describe('sessionWindowIso', () => {
  it.each([
    ['2026-04-17', '2026-04-17T13:30:00.000Z', '2026-04-17T20:00:00.000Z'],
    ['2026-01-15', '2026-01-15T14:30:00.000Z', '2026-01-15T21:00:00.000Z'],
    // Early close: 13:00 ET.
    ['2026-11-27', '2026-11-27T14:30:00.000Z', '2026-11-27T18:00:00.000Z'],
  ])('is the open to the close in ET on %s', (day, openIso, closeIso) => {
    expect(sessionWindowIso(day)).toEqual({ openIso, closeIso });
  });

  it('throws on a malformed date rather than building an unbounded query', () => {
    expect(() => sessionWindowIso('not-a-date')).toThrow(/not-a-date/);
  });
});
