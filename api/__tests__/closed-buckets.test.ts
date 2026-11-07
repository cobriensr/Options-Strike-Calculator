// @vitest-environment node

/**
 * closedBuckets turns UW's per-minute cumulative tide grid into the 5-minute
 * flow_data rows the live crons may store: today's session only (R-day), no
 * missing value stored as 0 or NULL (R-null), a bucket only once it has
 * closed (R-closed), stamped at its end (label rule).
 * Spec: docs/superpowers/specs/live-data-integrity-2026-11-06.md
 *
 * 2026-03-24 is on EDT (UTC-4): the 09:30 ET open is 13:30Z, 16:00 ET is 20:00Z.
 */

import { describe, it, expect } from 'vitest';

import {
  BUCKET_MS,
  closedBuckets,
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
    expect(result.unusable).toBe(0);
  });

  it('stores nothing at 09:32 ET from the prefilled grid, because no bucket has closed', () => {
    const rows = grid(SESSION_OPEN, SESSION_CLOSE, at('13:32'));
    const result = closedBuckets(rows, at('13:32'));
    expect(result.sessionRows).toBe(390);
    expect(result.buckets).toEqual([]);
    expect(result.unusable).toBe(0);
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
    expect(result.unusable).toBe(0);
  });

  it("takes each bucket's value from its last minute, whatever order UW sent the rows in", () => {
    const rows = grid(SESSION_OPEN, SESSION_CLOSE, at('13:40')).reverse();
    const result = closedBuckets(rows, at('13:40'));
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

  it('treats a bucket as closed at exactly its end', () => {
    const rows = grid(SESSION_OPEN, SESSION_CLOSE, at('13:35'));
    expect(closedBuckets(rows, at('13:35')).buckets).toHaveLength(1);
    expect(
      closedBuckets(rows, new Date(at('13:35').getTime() - 1)).buckets,
    ).toHaveLength(0);
  });

  it('stores the last bucket of the day (15:55-16:00 ET) as soon as 16:00 ET has passed', () => {
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

  it('leaves out a closed bucket whose last minute is null and counts it', () => {
    const rows = grid(SESSION_OPEN, SESSION_CLOSE, at('14:02'));
    const broken = rows.map((r) =>
      r.timestamp === '2026-03-24T13:44:00.000Z'
        ? { ...r, net_call_premium: null, net_put_premium: null }
        : r,
    );
    const result = closedBuckets(broken, at('14:02'));
    expect(result.buckets.map((b) => b.timestamp)).not.toContain(
      '2026-03-24T13:45:00.000Z',
    );
    expect(result.buckets).toHaveLength(5);
    expect(result.unusable).toBe(1);
  });

  it('leaves out a closed bucket whose last minute row is absent, even when earlier minutes exist', () => {
    const rows = grid(SESSION_OPEN, SESSION_CLOSE, at('14:02')).filter(
      (r) => r.timestamp !== '2026-03-24T13:44:00.000Z',
    );
    const result = closedBuckets(rows, at('14:02'));
    expect(result.buckets.map((b) => b.timestamp)).not.toContain(
      '2026-03-24T13:45:00.000Z',
    );
    expect(result.unusable).toBe(1);
  });

  it.each([
    ['NaN premium', { net_call_premium: 'not-a-number' }],
    ['blank premium', { net_put_premium: '   ' }],
    ['missing premium', { net_call_premium: undefined }],
    ['infinite premium', { net_put_premium: 'Infinity' }],
    ['null net_volume', { net_volume: null }],
    ['unparseable net_volume', { net_volume: 'n/a' }],
  ])(
    'never stores a past minute with a %s as 0 or NULL',
    (_label, overrides) => {
      const rows = grid(SESSION_OPEN, SESSION_CLOSE, at('14:02')).map((r) =>
        r.timestamp === '2026-03-24T13:49:00.000Z' ? { ...r, ...overrides } : r,
      );
      const result = closedBuckets(rows, at('14:02'));
      expect(result.buckets.map((b) => b.timestamp)).not.toContain(
        '2026-03-24T13:50:00.000Z',
      );
      expect(result.unusable).toBe(1);
      for (const b of result.buckets) {
        expect(Number.isFinite(b.ncp)).toBe(true);
        expect(Number.isFinite(b.npp)).toBe(true);
        expect(Number.isFinite(b.netVolume)).toBe(true);
      }
    },
  );

  it('does not look at a bad value in the middle of a bucket, since only the last minute is stored', () => {
    const rows = grid(SESSION_OPEN, SESSION_CLOSE, at('14:02')).map((r) =>
      r.timestamp === '2026-03-24T13:47:00.000Z'
        ? { ...r, net_call_premium: 'garbage' }
        : r,
    );
    const result = closedBuckets(rows, at('14:02'));
    expect(result.buckets).toHaveLength(6);
    expect(result.unusable).toBe(0);
  });

  it('stores a real zero: only a missing value is refused', () => {
    const rows = grid(SESSION_OPEN, SESSION_CLOSE, at('13:40')).map((r) =>
      r.timestamp === '2026-03-24T13:34:00.000Z'
        ? {
            ...r,
            net_call_premium: '0',
            net_put_premium: 0,
            net_volume: 0,
          }
        : r,
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
    expect(closedBuckets(rows, at('13:36')).buckets).toEqual([
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
    const result = closedBuckets(rows, at('13:36'));
    expect(result.sessionRows).toBe(2);
    expect(result.buckets).toHaveLength(1);
  });

  it('applies the 09:30 ET open on an EST date too (14:30Z)', () => {
    const est = (hhmm: string) => new Date(`2026-01-15T${hhmm}:00Z`);
    const rows = [minuteRow(est('14:29')), minuteRow(est('14:34'))];
    const result = closedBuckets(rows, est('14:36'));
    expect(result.sessionRows).toBe(1);
    expect(result.buckets.map((b) => b.timestamp)).toEqual([
      '2026-01-15T14:35:00.000Z',
    ]);
  });

  it('ignores a row whose timestamp does not parse', () => {
    const rows = [
      { ...minuteRow(at('13:34')), timestamp: 'garbage' },
      minuteRow(at('13:34')),
    ];
    const result = closedBuckets(rows, at('13:36'));
    expect(result.sessionRows).toBe(1);
    expect(result.buckets).toHaveLength(1);
  });

  it('returns an empty result for an empty payload', () => {
    expect(closedBuckets([], at('14:00'))).toEqual({
      buckets: [],
      sessionRows: 0,
      unusable: 0,
    });
  });

  it('exposes a 5-minute bucket', () => {
    expect(BUCKET_MS).toBe(5 * MINUTE);
  });
});

describe('sessionWindowIso', () => {
  it.each([
    ['2026-04-17', '2026-04-17T13:30:00.000Z', '2026-04-17T20:00:00.000Z'],
    ['2026-01-15', '2026-01-15T14:30:00.000Z', '2026-01-15T21:00:00.000Z'],
  ])('is 09:30 to 16:00 ET on %s', (day, openIso, closeIso) => {
    expect(sessionWindowIso(day)).toEqual({ openIso, closeIso });
  });

  it('throws on a malformed date rather than building an unbounded query', () => {
    expect(() => sessionWindowIso('not-a-date')).toThrow(/not-a-date/);
  });
});
