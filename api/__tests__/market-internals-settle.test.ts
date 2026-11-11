// @vitest-environment node

/**
 * The pure rules of the post-close market-internals settle
 * (api/_lib/market-internals-settle.ts): which sessions a run covers, the
 * request, the payload check, and the per-symbol plan (session filter, the
 * all-zero bar, the wrong bar count, the $TICK clamp signature).
 * Spec: docs/superpowers/specs/live-data-integrity-2026-11-06.md (P0.5).
 *
 * The clock facts used: 2026-11-06 is EST (UTC-5), so the session is
 * 14:30Z-21:00Z; 2026-03-24 is EDT (UTC-4), 13:30Z-20:00Z; 2026-11-27 is the
 * Black Friday half day (closes 13:00 ET = 18:00Z), the day after the
 * Thanksgiving holiday (2026-11-26).
 */

import { describe, it, expect } from 'vitest';

import {
  CLAMP_MIN_BARS,
  FETCH_MARGIN_MS,
  SETTLE_SESSIONS,
  SettleFailure,
  allZeroSessions,
  diffBars,
  fetchWindow,
  parsePriceHistory,
  planSymbol,
  pricehistoryPath,
  sessionProblems,
  settleSessions,
  splitPendingProblems,
  type InternalBarRow,
  type SessionProblem,
  type SettleCandle,
} from '../_lib/market-internals-settle.js';

const MIN = 60_000;

/** `count` consecutive one-minute candles from `openIso`, values from `make(i)`. */
function minuteBars(
  openIso: string,
  count: number,
  make: (i: number) => [number, number, number, number],
): SettleCandle[] {
  const start = Date.parse(openIso);
  return Array.from({ length: count }, (_, i) => {
    const [open, high, low, close] = make(i);
    return { open, high, low, close, datetime: start + i * MIN };
  });
}

/** A TICK-like series that swings through zero: every 3rd bar goes negative. */
const tickLike = (i: number): [number, number, number, number] =>
  i % 3 === 0 ? [50, 120, -80, -40] : [30, 90, 10, 60];

/** A plain positive series, as $ADD, $VOLD and $TRIN are. */
const steady = (i: number): [number, number, number, number] => [
  100 + i,
  110 + i,
  90 + i,
  105 + i,
];

const EST_OPEN = '2026-11-06T14:30:00Z';
const FULL_DAY = 390;

describe('SETTLE_SESSIONS', () => {
  it('is 5: a session that is not final the same evening, or a missed run, heals within the week', () => {
    expect(SETTLE_SESSIONS).toBe(5);
  });
});

describe('settleSessions', () => {
  it('after the Friday close: the five sessions ending that day, oldest first', () => {
    // 2026-11-06T22:30Z is 17:30 EST.
    expect(settleSessions(new Date('2026-11-06T22:30:00Z'))).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
    ]);
  });

  it('on a Saturday (forced run): the five sessions ending the day before', () => {
    expect(settleSessions(new Date('2026-11-07T15:00:00Z'))).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
    ]);
  });

  it('before the close: today is left out, its session is still being traded', () => {
    // 20:00Z is 15:00 EST on Friday 11-06.
    expect(settleSessions(new Date('2026-11-06T20:00:00Z'))).toEqual([
      '2026-10-30',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
    ]);
  });

  it('skips the Thanksgiving holiday and counts the Black Friday half day', () => {
    expect(settleSessions(new Date('2026-11-27T22:30:00Z'))).toEqual([
      '2026-11-20',
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
      '2026-11-27',
    ]);
  });

  it('a half day counts as closed from 13:00 ET, not 16:00', () => {
    // 18:00Z is 13:00 EST on the half day.
    expect(settleSessions(new Date('2026-11-27T18:00:00Z')).at(-1)).toBe(
      '2026-11-27',
    );
    expect(settleSessions(new Date('2026-11-27T17:59:00Z')).at(-1)).toBe(
      '2026-11-25',
    );
  });

  it('takes a different count', () => {
    expect(settleSessions(new Date('2026-11-06T22:30:00Z'), 2)).toEqual([
      '2026-11-05',
      '2026-11-06',
    ]);
  });
});

describe('fetchWindow', () => {
  it('runs from an hour before the oldest open to an hour after the newest close', () => {
    const { startMs, endMs } = fetchWindow(['2026-11-05', '2026-11-06']);
    expect(startMs).toBe(Date.parse('2026-11-05T14:30:00Z') - FETCH_MARGIN_MS);
    expect(endMs).toBe(Date.parse('2026-11-06T21:00:00Z') + FETCH_MARGIN_MS);
  });

  it('follows DST: EDT sessions open at 13:30Z', () => {
    const { startMs } = fetchWindow(['2026-03-24']);
    expect(startMs).toBe(Date.parse('2026-03-24T13:30:00Z') - FETCH_MARGIN_MS);
  });
});

describe('pricehistoryPath', () => {
  it('asks for 1-minute bars of the symbol without extended hours', () => {
    const path = pricehistoryPath('$TICK', 1_000, 2_000);
    expect(path.startsWith('/pricehistory?')).toBe(true);
    const params = new URLSearchParams(path.slice('/pricehistory?'.length));
    expect(Object.fromEntries(params)).toEqual({
      symbol: '$TICK',
      periodType: 'day',
      frequencyType: 'minute',
      frequency: '1',
      startDate: '1000',
      endDate: '2000',
      needExtendedHoursData: 'false',
      needPreviousClose: 'false',
    });
    expect(path).toContain('symbol=%24TICK');
  });
});

describe('parsePriceHistory', () => {
  const good = { open: 1, high: 2, low: 0.5, close: 1.5, datetime: 1_000 };

  it('returns the candles of a well-formed payload', () => {
    const out = parsePriceHistory({
      symbol: '$ADD',
      empty: false,
      candles: [good, { ...good, datetime: 2_000, volume: 0 }],
    });
    expect(out.malformed).toBe(0);
    expect(out.candles.map((c) => c.datetime)).toEqual([1_000, 2_000]);
  });

  it.each([
    ['null', null],
    ['a string', 'oops'],
    ['an object without candles', { symbol: '$ADD' }],
    ['candles that is not an array', { candles: 'x' }],
  ])('throws malformed_payload for %s', (_label, body) => {
    expect(() => parsePriceHistory(body)).toThrow(SettleFailure);
    try {
      parsePriceHistory(body);
    } catch (err) {
      expect((err as SettleFailure).kind).toBe('malformed_payload');
    }
  });

  it.each([
    ['an empty list', { symbol: '$ADD', empty: false, candles: [] }],
    ['empty: true', { symbol: '$ADD', empty: true, candles: [] }],
  ])('throws empty_payload for %s', (_label, body) => {
    try {
      parsePriceHistory(body);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SettleFailure);
      expect((err as SettleFailure).kind).toBe('empty_payload');
    }
  });

  it('drops a candle with a non-finite field and counts it', () => {
    const out = parsePriceHistory({
      candles: [
        good,
        { ...good, datetime: 2_000, close: null },
        { ...good, datetime: 3_000, high: 'x' },
        { ...good, datetime: Number.NaN },
        'not-an-object',
      ],
    });
    expect(out.candles).toHaveLength(1);
    expect(out.malformed).toBe(4);
  });

  it('throws malformed_payload when no candle is usable', () => {
    try {
      parsePriceHistory({ candles: [{ open: 'a' }, null] });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as SettleFailure).kind).toBe('malformed_payload');
    }
  });
});

describe('planSymbol: the session filter', () => {
  it('keeps 09:30 through the last minute before 16:00 ET and drops the rest', () => {
    // 09:25-16:04 EST = 14:25Z-21:04Z: 10 bars outside, 390 inside.
    const candles = minuteBars('2026-11-06T14:25:00Z', 400, steady);
    const plan = planSymbol('$ADD', candles, ['2026-11-06']);
    expect(plan.rows).toHaveLength(FULL_DAY);
    expect(plan.rows[0]!.ts).toBe('2026-11-06T14:30:00.000Z');
    expect(plan.rows.at(-1)!.ts).toBe('2026-11-06T20:59:00.000Z');
    expect(plan.outOfSession).toBe(10);
    expect(plan.sessions).toEqual([
      {
        date: '2026-11-06',
        expected: FULL_DAY,
        bars: FULL_DAY,
        zeroBars: 0,
        status: 'complete',
      },
    ]);
  });

  it('drops the bar stamped at the close itself (16:00 ET)', () => {
    const candles = minuteBars(EST_OPEN, 391, steady); // last is 21:00Z
    const plan = planSymbol('$VOLD', candles, ['2026-11-06']);
    expect(plan.rows).toHaveLength(FULL_DAY);
    expect(plan.outOfSession).toBe(1);
  });

  it('keeps an EDT session at 13:30Z-20:00Z', () => {
    const candles = minuteBars('2026-03-24T13:30:00Z', 390, steady);
    const plan = planSymbol('$TRIN', candles, ['2026-03-24']);
    expect(plan.rows).toHaveLength(FULL_DAY);
    expect(plan.sessions[0]!.status).toBe('complete');
  });

  it('drops bars of a day that is not one of the sessions asked for', () => {
    const candles = [
      ...minuteBars('2026-11-05T14:30:00Z', 390, steady),
      ...minuteBars(EST_OPEN, 390, steady),
    ];
    const plan = planSymbol('$ADD', candles, ['2026-11-06']);
    expect(plan.rows).toHaveLength(FULL_DAY);
    expect(plan.outOfSession).toBe(FULL_DAY);
  });

  it('a half day expects 210 bars and drops anything after 13:00 ET', () => {
    // Black Friday 2026-11-27, EST: 14:30Z-18:00Z. Schwab sent 390 bars.
    const candles = minuteBars('2026-11-27T14:30:00Z', 390, steady);
    const plan = planSymbol('$ADD', candles, ['2026-11-27']);
    expect(plan.rows).toHaveLength(210);
    expect(plan.rows.at(-1)!.ts).toBe('2026-11-27T17:59:00.000Z');
    expect(plan.outOfSession).toBe(180);
    expect(plan.sessions[0]).toMatchObject({
      expected: 210,
      bars: 210,
      status: 'complete',
    });
  });

  it('a half day with only 209 bars is incomplete', () => {
    const candles = minuteBars('2026-11-27T14:30:00Z', 209, steady);
    const plan = planSymbol('$ADD', candles, ['2026-11-27']);
    expect(plan.sessions[0]).toMatchObject({
      expected: 210,
      bars: 209,
      status: 'incomplete',
    });
  });
});

describe('planSymbol: validation', () => {
  it('rejects an all-zero bar, counts it, and still writes the rest', () => {
    const candles = minuteBars(EST_OPEN, FULL_DAY, steady);
    candles[100] = { ...candles[100]!, open: 0, high: 0, low: 0, close: 0 };
    const plan = planSymbol('$ADD', candles, ['2026-11-06']);
    expect(plan.rows).toHaveLength(FULL_DAY - 1);
    expect(plan.sessions[0]).toMatchObject({
      zeroBars: 1,
      bars: FULL_DAY - 1,
      status: 'incomplete',
    });
  });

  it('keeps a bar that is zero in only some fields (a $TICK close of 0 is real)', () => {
    const candles = minuteBars(EST_OPEN, FULL_DAY, tickLike);
    candles[7] = { ...candles[7]!, open: 4, high: 9, low: -3, close: 0 };
    candles[8] = { ...candles[8]!, open: 0, high: 0, low: -2, close: 0 };
    const plan = planSymbol('$TICK', candles, ['2026-11-06']);
    expect(plan.rows).toHaveLength(FULL_DAY);
    expect(plan.sessions[0]!.zeroBars).toBe(0);
  });

  it('a session with 389 bars is incomplete and names the count', () => {
    const candles = minuteBars(EST_OPEN, FULL_DAY - 1, steady);
    const plan = planSymbol('$VOLD', candles, ['2026-11-06']);
    expect(plan.rows).toHaveLength(FULL_DAY - 1);
    expect(plan.sessions[0]).toMatchObject({
      expected: FULL_DAY,
      bars: FULL_DAY - 1,
      status: 'incomplete',
    });
  });

  it('a session with no bar at all is incomplete (0 of 390), not absent', () => {
    const plan = planSymbol('$VOLD', [], ['2026-11-06']);
    expect(plan.rows).toEqual([]);
    expect(plan.sessions).toEqual([
      {
        date: '2026-11-06',
        expected: FULL_DAY,
        bars: 0,
        zeroBars: 0,
        status: 'incomplete',
      },
    ]);
  });

  it('keeps one bar per timestamp and counts the duplicates', () => {
    const candles = minuteBars(EST_OPEN, FULL_DAY, steady);
    candles.push({ ...candles[5]!, close: 999 }); // same minute again, later
    const plan = planSymbol('$ADD', candles, ['2026-11-06']);
    expect(plan.rows).toHaveLength(FULL_DAY);
    expect(plan.duplicates).toBe(1);
    expect(plan.sessions[0]!.status).toBe('complete');
    // The later bar wins.
    expect(plan.rows[5]!.close).toBe(999);
  });

  it('returns rows oldest first as ISO strings with the symbol', () => {
    const candles = minuteBars(EST_OPEN, 3, steady).reverse();
    const plan = planSymbol('$TRIN', candles, ['2026-11-06']);
    expect(plan.rows.map((r) => r.ts)).toEqual([
      '2026-11-06T14:30:00.000Z',
      '2026-11-06T14:31:00.000Z',
      '2026-11-06T14:32:00.000Z',
    ]);
    expect(plan.rows[0]).toEqual({
      ts: '2026-11-06T14:30:00.000Z',
      symbol: '$TRIN',
      open: 100,
      high: 110,
      low: 90,
      close: 105,
    } satisfies InternalBarRow);
  });

  it('plans each session on its own', () => {
    const candles = [
      ...minuteBars('2026-11-05T14:30:00Z', FULL_DAY, steady),
      ...minuteBars(EST_OPEN, 100, steady),
    ];
    const plan = planSymbol('$ADD', candles, ['2026-11-05', '2026-11-06']);
    expect(plan.sessions.map((s) => [s.date, s.bars, s.status])).toEqual([
      ['2026-11-05', FULL_DAY, 'complete'],
      ['2026-11-06', 100, 'incomplete'],
    ]);
    expect(plan.rows).toHaveLength(FULL_DAY + 100);
  });
});

describe('planSymbol: the $TICK clamp signature', () => {
  /** What the live feed did: negatives clamped to 0, so ~1/3 of bars are all zero. */
  const clamped = (i: number): [number, number, number, number] => {
    const [o, h, l, c] = tickLike(i);
    return [Math.max(o, 0), Math.max(h, 0), Math.max(l, 0), Math.max(c, 0)];
  };

  it('CLAMP_MIN_BARS is 60: past the longest (44-bar) non-negative run in the 35 settled sessions', () => {
    expect(CLAMP_MIN_BARS).toBe(60);
  });

  it('refuses a full $TICK session with no negative value: writes nothing and says so', () => {
    const candles = minuteBars(EST_OPEN, FULL_DAY, clamped);
    const plan = planSymbol('$TICK', candles, ['2026-11-06']);
    expect(plan.rows).toEqual([]);
    expect(plan.sessions).toEqual([
      {
        date: '2026-11-06',
        expected: FULL_DAY,
        bars: 0,
        zeroBars: 0,
        status: 'tick_clamped',
      },
    ]);
  });

  it('refuses a partial session too, from 60 raw bars on', () => {
    const atLimit = planSymbol(
      '$TICK',
      minuteBars(EST_OPEN, CLAMP_MIN_BARS, clamped),
      ['2026-11-06'],
    );
    expect(atLimit.sessions[0]!.status).toBe('tick_clamped');
    expect(atLimit.rows).toEqual([]);

    const below = planSymbol(
      '$TICK',
      minuteBars(EST_OPEN, CLAMP_MIN_BARS - 1, clamped),
      ['2026-11-06'],
    );
    // Too few bars to judge: written, and reported as incomplete.
    expect(below.sessions[0]!.status).toBe('incomplete');
    expect(below.rows).toHaveLength(CLAMP_MIN_BARS - 1);
  });

  it('accepts a session with a single negative value', () => {
    const candles = minuteBars(EST_OPEN, FULL_DAY, (i) =>
      i === 200 ? [4, 9, -1, 2] : [30, 90, 10, 60],
    );
    const plan = planSymbol('$TICK', candles, ['2026-11-06']);
    expect(plan.sessions[0]!.status).toBe('complete');
    expect(plan.rows).toHaveLength(FULL_DAY);
  });

  it('judges each session on its own: one clamped, one real', () => {
    const candles = [
      ...minuteBars('2026-11-05T14:30:00Z', FULL_DAY, tickLike),
      ...minuteBars(EST_OPEN, FULL_DAY, clamped),
    ];
    const plan = planSymbol('$TICK', candles, ['2026-11-05', '2026-11-06']);
    expect(plan.sessions.map((s) => [s.date, s.status])).toEqual([
      ['2026-11-05', 'complete'],
      ['2026-11-06', 'tick_clamped'],
    ]);
    expect(plan.rows).toHaveLength(FULL_DAY);
    expect(plan.rows.every((r) => r.ts.startsWith('2026-11-05'))).toBe(true);
  });

  it.each(['$ADD', '$VOLD', '$TRIN'] as const)(
    'is not applied to %s, which has no negative values to clamp',
    (symbol) => {
      const plan = planSymbol(symbol, minuteBars(EST_OPEN, FULL_DAY, steady), [
        '2026-11-06',
      ]);
      expect(plan.sessions[0]!.status).toBe('complete');
    },
  );
});

describe('sessionProblems', () => {
  it('lists each session that is not complete, with the counts and the zero bars', () => {
    const tick = planSymbol(
      '$TICK',
      minuteBars(EST_OPEN, FULL_DAY, (i) => {
        const [o, h, l, c] = tickLike(i);
        return [Math.max(o, 0), Math.max(h, 0), Math.max(l, 0), Math.max(c, 0)];
      }),
      ['2026-11-06'],
    );
    const addCandles = minuteBars(EST_OPEN, FULL_DAY, steady);
    addCandles[0] = { ...addCandles[0]!, open: 0, high: 0, low: 0, close: 0 };
    const add = planSymbol('$ADD', addCandles, ['2026-11-06']);
    const trin = planSymbol('$TRIN', minuteBars(EST_OPEN, FULL_DAY, steady), [
      '2026-11-06',
    ]);

    expect([tick, add, trin].flatMap((p) => sessionProblems(p))).toEqual([
      {
        symbol: '$TICK',
        date: '2026-11-06',
        kind: 'tick_clamped',
        bars: 0,
        expected: FULL_DAY,
        zeroBars: 0,
      },
      {
        symbol: '$ADD',
        date: '2026-11-06',
        kind: 'incomplete',
        bars: FULL_DAY - 1,
        expected: FULL_DAY,
        zeroBars: 1,
      },
    ]);
  });
});

describe('splitPendingProblems', () => {
  const problem = (symbol: string, date: string): SessionProblem => ({
    symbol: symbol as SessionProblem['symbol'],
    date,
    kind: 'incomplete',
    bars: 0,
    expected: FULL_DAY,
    zeroBars: 0,
  });
  const SESSIONS = ['2026-11-04', '2026-11-05', '2026-11-06'];

  it("a problem on the newest session is pending only when that is the run's own ET day", () => {
    const todays = problem('$ADD', '2026-11-06');

    expect(splitPendingProblems([todays], SESSIONS, '2026-11-06')).toEqual({
      pending: [todays],
      unusable: [],
    });
    // A forced Saturday run: the newest session is a day old, so it is not.
    expect(splitPendingProblems([todays], SESSIONS, '2026-11-07')).toEqual({
      pending: [],
      unusable: [todays],
    });
  });

  it('a problem on any older session is unusable, and the two are told apart in one list', () => {
    const old = problem('$VOLD', '2026-11-05');
    const older = problem('$TRIN', '2026-11-04');
    const todays = problem('$TICK', '2026-11-06');

    expect(
      splitPendingProblems([old, todays, older], SESSIONS, '2026-11-06'),
    ).toEqual({ pending: [todays], unusable: [old, older] });
  });

  it('no problems, or an empty window, give nothing pending and nothing unusable', () => {
    expect(splitPendingProblems([], SESSIONS, '2026-11-06')).toEqual({
      pending: [],
      unusable: [],
    });
    expect(
      splitPendingProblems([problem('$ADD', '2026-11-06')], [], '2026-11-06'),
    ).toEqual({
      pending: [],
      unusable: [problem('$ADD', '2026-11-06')],
    });
  });
});

describe('allZeroSessions', () => {
  it('flags a symbol-session with more than 10 rows and every row all-zero', () => {
    expect(
      allZeroSessions([
        { symbol: '$ADD', date: '2026-11-06', total: 390, nonzero: 0 },
        { symbol: '$TICK', date: '2026-11-06', total: 390, nonzero: 388 },
        { symbol: '$VOLD', date: '2026-11-06', total: 11, nonzero: 0 },
        { symbol: '$TRIN', date: '2026-11-06', total: 10, nonzero: 0 },
        { symbol: '$TRIN', date: '2026-11-05', total: 390, nonzero: 1 },
      ]),
    ).toEqual([
      { symbol: '$ADD', date: '2026-11-06', total: 390, nonzero: 0 },
      { symbol: '$VOLD', date: '2026-11-06', total: 11, nonzero: 0 },
    ]);
  });

  it('is judged per symbol: $TICK healthy does not hide $ADD all zero', () => {
    const flagged = allZeroSessions([
      { symbol: '$TICK', date: '2026-11-06', total: 390, nonzero: 390 },
      { symbol: '$ADD', date: '2026-11-06', total: 390, nonzero: 0 },
    ]);
    expect(flagged.map((f) => f.symbol)).toEqual(['$ADD']);
  });
});

describe('diffBars', () => {
  const row = (ts: string, close: number): InternalBarRow => ({
    ts,
    symbol: '$TICK',
    open: 1,
    high: 2,
    low: 0,
    close,
  });

  it('classifies new, revised and identical rows against what is stored', () => {
    const planned = [
      row('2026-11-06T14:30:00.000Z', 5),
      row('2026-11-06T14:31:00.000Z', 6),
      row('2026-11-06T14:32:00.000Z', 7),
    ];
    const stored = [
      { ...row('2026-11-06T14:30:00.000Z', 5) }, // same
      { ...row('2026-11-06T14:31:00.000Z', 0) }, // revised (was clamped)
    ];
    const { counts, changed } = diffBars(planned, stored);
    expect(counts).toEqual({ inserted: 1, updated: 1, unchanged: 1 });
    expect([...changed]).toEqual([
      ['2026-11-06T14:31:00.000Z', 'updated'],
      ['2026-11-06T14:32:00.000Z', 'inserted'],
    ]);
  });
});
