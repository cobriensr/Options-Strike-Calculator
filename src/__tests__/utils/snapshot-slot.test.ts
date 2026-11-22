import { describe, it, expect } from 'vitest';
import {
  priceContextAsOf,
  spxSlotStateAsOf,
  symbolPriceAsOf,
  type SlotCandle,
} from '../../utils/snapshot-slot';

// The 9:30 ET open on a winter date (EST, UTC-5) and a summer date (EDT,
// UTC-4). The rule reads the ET wall clock, so both must give one answer.
const SESSION_OPENS = [
  ['EST', Date.UTC(2026, 10, 5, 14, 30)],
  ['EDT', Date.UTC(2026, 6, 15, 13, 30)],
] as const;

const MINUTE_MS = 60_000;

/** [minutes after the 9:30 ET open, open, high, low, close] */
type BarSpec = readonly [number, number, number, number, number];

const BARS = [
  [0, 7487, 7495, 7480, 7490], // 9:30 ET, 8:30 CT
  [5, 7490, 7502, 7488, 7500], // 9:35 ET, 8:35 CT
  [10, 7500, 7505, 7470, 7475], // 9:40 ET, 8:40 CT
] as const satisfies readonly BarSpec[];

function session(openMs: number, bars: readonly BarSpec[]): SlotCandle[] {
  return bars.map(([offset, open, high, low, close]) => ({
    datetime: openMs + offset * MINUTE_MS,
    open,
    high,
    low,
    close,
  }));
}

// Slot minutes are CT minutes since midnight, as parseEntryTimeMinutes
// returns them: 8:30 AM CT (the 9:30 ET open) is 510.
const OPEN_CT = 510;

describe.each(SESSION_OPENS)('priceContextAsOf (%s session)', (_zone, open) => {
  const candles = session(open, BARS);

  describe('before the first bar starts', () => {
    it.each([500, 505, 509])('slot %i has no price context', (slot) => {
      expect(priceContextAsOf(candles, slot)).toBeNull();
    });
  });

  describe('as-of table, three bars', () => {
    const FIRST_BAR_OPEN = { open: 7487, high: 7487, low: 7487 };
    const AFTER_FIRST = { open: 7487, high: 7495, low: 7480 };
    const AFTER_SECOND = { open: 7487, high: 7502, low: 7480 };
    const AFTER_THIRD = { open: 7487, high: 7505, low: 7470 };

    it.each([
      // 8:30 CT: the first bar has started but not ended, so only its open is
      // known. Its 7495 high and 7480 low come later.
      [510, FIRST_BAR_OPEN],
      [514, FIRST_BAR_OPEN],
      // A bar counts at the slot its end minute falls on: 9:30 + 5 = 9:35 ET.
      [515, AFTER_FIRST],
      // Slots between bar ends keep the last ended bar's state.
      [517, AFTER_FIRST],
      [519, AFTER_FIRST],
      [520, AFTER_SECOND],
      [525, AFTER_THIRD],
      // 12:00 CT and 2:55 PM CT, long after the last bar.
      [720, AFTER_THIRD],
      [895, AFTER_THIRD],
    ])('slot %i gives the context of the bars ended by then', (slot, want) => {
      expect(priceContextAsOf(candles, slot)).toEqual(want);
    });
  });

  describe('a single-candle session', () => {
    const one = session(open, BARS.slice(0, 1));

    it('has no context before the bar starts', () => {
      expect(priceContextAsOf(one, 509)).toBeNull();
    });

    it('knows only the open while the bar runs', () => {
      expect(priceContextAsOf(one, 510)).toEqual({
        open: 7487,
        high: 7487,
        low: 7487,
      });
    });

    it('takes the bar once it ends', () => {
      expect(priceContextAsOf(one, 515)).toEqual({
        open: 7487,
        high: 7495,
        low: 7480,
      });
      expect(priceContextAsOf(one, 895)).toEqual({
        open: 7487,
        high: 7495,
        low: 7480,
      });
    });
  });

  it('keeps the running range when a later bar sits inside it', () => {
    const inside = session(open, [
      [0, 7487, 7495, 7480, 7490],
      [5, 7490, 7492, 7485, 7488], // lower high and higher low than bar 1
    ]);
    expect(priceContextAsOf(inside, 520)).toEqual({
      open: 7487,
      high: 7495,
      low: 7480,
    });
  });

  // parseEntryTimeMinutes returns NaN for "pre-market" and free-form labels.
  // NaN compares false against every bound, so without a guard it would read
  // as "every bar has ended": the whole session's range at one slot.
  describe('a slot that is not a finite number', () => {
    it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
      'slot %s has no price context',
      (slot) => {
        expect(priceContextAsOf(candles, slot)).toBeNull();
      },
    );
  });

  // The first bar is the session open. A feed that starts late (the 9:30 bar
  // missing) or early (a 9:25 bar) would otherwise store another bar's open
  // as the day's open.
  describe('a first bar that is not the 9:30 ET bar', () => {
    const late = session(open, BARS.slice(1)); // 9:35 and 9:40 only
    const early = session(open, [
      [-5, 7485, 7488, 7483, 7487], // 9:25 ET
      ...BARS,
    ]);

    it.each([510, 515, 895])('a 9:35 first bar: slot %i is null', (slot) => {
      expect(priceContextAsOf(late, slot)).toBeNull();
    });

    it.each([510, 515, 895])('a 9:25 first bar: slot %i is null', (slot) => {
      expect(priceContextAsOf(early, slot)).toBeNull();
    });
  });

  // NULL over a guessed value: the callers store NULL, so one bad price
  // must not become a confident range.
  describe('bad prices', () => {
    const BAD_PRICES = [
      ['NaN', Number.NaN],
      ['zero', 0],
      ['negative', -1],
      ['Infinity', Number.POSITIVE_INFINITY],
    ] as const;

    it.each(BAD_PRICES)(
      'a %s first open gives null at every slot',
      (_name, bad) => {
        const bars = session(open, [
          [0, bad, 7495, 7480, 7490],
          ...BARS.slice(1),
        ]);
        for (const slot of [510, 515, 520, 525, 895]) {
          expect(priceContextAsOf(bars, slot), `slot ${slot}`).toBeNull();
        }
      },
    );

    // The bad bar starts at 9:35 ET, so it has ended from slot 520 on.
    it.each(BAD_PRICES)(
      'a %s high on a later bar gives null once it has ended',
      (_name, bad) => {
        const bars = session(open, [
          BARS[0],
          [5, 7490, bad, 7488, 7500],
          BARS[2],
        ]);
        expect(priceContextAsOf(bars, 510)).toEqual({
          open: 7487,
          high: 7487,
          low: 7487,
        });
        expect(priceContextAsOf(bars, 515)).toEqual({
          open: 7487,
          high: 7495,
          low: 7480,
        });
        for (const slot of [520, 525, 895]) {
          expect(priceContextAsOf(bars, slot), `slot ${slot}`).toBeNull();
        }
      },
    );

    it.each(BAD_PRICES)(
      'a %s low on a later bar gives null once it has ended',
      (_name, bad) => {
        const bars = session(open, [
          BARS[0],
          [5, 7490, 7502, bad, 7500],
          BARS[2],
        ]);
        expect(priceContextAsOf(bars, 515)).toEqual({
          open: 7487,
          high: 7495,
          low: 7480,
        });
        for (const slot of [520, 525, 895]) {
          expect(priceContextAsOf(bars, slot), `slot ${slot}`).toBeNull();
        }
      },
    );

    it('a bad price on the first bar matters once that bar has ended, not before', () => {
      const bars = session(open, [[0, 7487, 7495, Number.NaN, 7490]]);
      expect(priceContextAsOf(bars, 510)).toEqual({
        open: 7487,
        high: 7487,
        low: 7487,
      });
      expect(priceContextAsOf(bars, 515)).toBeNull();
    });

    it('a bad bar that has not ended by the slot leaves the result alone', () => {
      // A 9:45 ET bar with NaN high and zero low ends at slot 530.
      const bars = session(open, [...BARS, [15, 7475, Number.NaN, 0, 7480]]);
      for (let slot = OPEN_CT; slot < 530; slot += 1) {
        expect(priceContextAsOf(bars, slot), `slot ${slot}`).toEqual(
          priceContextAsOf(candles, slot),
        );
      }
      expect(priceContextAsOf(bars, 530)).toBeNull();
    });
  });

  // A bar with no usable start time can't be placed on the clock, so there
  // is no telling whether it has ended: the range can't be trusted at any
  // slot. An invalid Date makes the ET formatter throw "Invalid time value",
  // so the check has to run before any bar is placed on the clock.
  describe('a candle whose datetime is not a valid time', () => {
    const withDatetime = (index: number, datetime: number): SlotCandle[] =>
      candles.map((c, i) => (i === index ? { ...c, datetime } : c));

    it.each([510, 895])('a NaN first datetime: slot %i is null', (slot) => {
      expect(priceContextAsOf(withDatetime(0, Number.NaN), slot)).toBeNull();
    });

    it.each([510, 515, 895])(
      'a NaN third datetime: slot %i is null',
      (slot) => {
        expect(priceContextAsOf(withDatetime(2, Number.NaN), slot)).toBeNull();
      },
    );

    it.each([
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('a %s datetime on a later candle is null', (_name, bad) => {
      for (const slot of [510, 520, 895]) {
        expect(
          priceContextAsOf(withDatetime(1, bad), slot),
          `slot ${slot}`,
        ).toBeNull();
      }
    });

    // Finite but past the range a Date can hold (8.64e15 ms): the ET
    // formatter throws on these just as it does on NaN.
    it.each([
      ['a nanosecond epoch', 1.7e18],
      ['one past the Date range', 8.64e15 + 1],
    ])('%s as a later datetime is null', (_name, bad) => {
      for (const slot of [510, 895]) {
        expect(
          priceContextAsOf(withDatetime(1, bad), slot),
          `slot ${slot}`,
        ).toBeNull();
      }
    });

    it('an Infinity datetime on the first candle is null', () => {
      expect(
        priceContextAsOf(withDatetime(0, Number.POSITIVE_INFINITY), 520),
      ).toBeNull();
    });
  });

  // The high and low scan reads every bar, so the order of the bars after
  // the first does not change them. The first bar must still be 9:30 ET.
  it('does not depend on the order of the bars after the first', () => {
    const shuffled = session(open, [BARS[0], BARS[2], BARS[1]]);
    for (const slot of [510, 515, 520, 525, 895]) {
      expect(priceContextAsOf(shuffled, slot), `slot ${slot}`).toEqual(
        priceContextAsOf(candles, slot),
      );
    }
  });

  // An early-close day: 42 bars, 9:30 to 12:55 ET. The last bar ends at 1:00
  // PM ET, slot 720 CT.
  describe('a half-day session of 42 bars', () => {
    const halfDay = session(
      open,
      Array.from({ length: 42 }, (_, i): BarSpec => {
        // High rises 1 a bar and the low holds at 7480, except the last bar,
        // which breaks both.
        return i === 41
          ? [205, 7500, 7600, 7400, 7500]
          : [i * 5, 7487 + i, 7500 + i, 7480, 7490];
      }),
    );

    it.each([
      [719, { open: 7487, high: 7540, low: 7480 }], // 41 bars ended
      [720, { open: 7487, high: 7600, low: 7400 }], // 12:55 bar ended
      [725, { open: 7487, high: 7600, low: 7400 }],
      [895, { open: 7487, high: 7600, low: 7400 }],
    ])('slot %i', (slot, want) => {
      expect(priceContextAsOf(halfDay, slot)).toEqual(want);
    });
  });

  it('returns null for every slot when there are no candles', () => {
    expect(priceContextAsOf([], OPEN_CT)).toBeNull();
    expect(priceContextAsOf([], 895)).toBeNull();
  });

  describe('look-ahead (spec G2)', () => {
    // A later bar with an extreme range, starting at 9:45 ET (8:45 CT) so it
    // ends at 8:50 CT = slot 530.
    const LATER_BAR: BarSpec = [15, 7475, 9999, 1, 7480];
    const withLater = session(open, [...BARS, LATER_BAR]);

    it('an appended later bar never changes the result for slots before it ends', () => {
      for (let slot = OPEN_CT; slot < 530; slot += 1) {
        expect(priceContextAsOf(withLater, slot), `slot ${slot}`).toEqual(
          priceContextAsOf(candles, slot),
        );
      }
    });

    it('the appended bar does count at the slot it ends', () => {
      expect(priceContextAsOf(withLater, 530)).toEqual({
        open: 7487,
        high: 9999,
        low: 1,
      });
    });

    it('open never moves, high never falls and low never rises as the slot advances', () => {
      let prev = priceContextAsOf(withLater, OPEN_CT);
      expect(prev).not.toBeNull();
      for (let slot = OPEN_CT + 1; slot <= 895; slot += 1) {
        const next = priceContextAsOf(withLater, slot);
        expect(next, `slot ${slot}`).not.toBeNull();
        expect(next!.open, `slot ${slot}`).toBe(prev!.open);
        expect(next!.high, `slot ${slot}`).toBeGreaterThanOrEqual(prev!.high);
        expect(next!.low, `slot ${slot}`).toBeLessThanOrEqual(prev!.low);
        prev = next;
      }
    });
  });
});

// ── As-of slot state (snapshot builder phase 2, call 1) ─────────────────────
//
// A bar that starts at ET minute s has ended at slot T when s + 5 <= T. A day
// of bars here starts at 9:30 ET on 2026-07-15 (EDT, so 13:30 UTC) and bar i
// starts 5 * i minutes later. Slots are CT minutes since midnight, so 8:30 CT
// (the 9:30 ET open) is 510 and 9:00 CT (10:00 ET) is 540.

const AS_OF_OPEN_MS = Date.UTC(2026, 6, 15, 13, 30);
const BAR_MS = 5 * MINUTE_MS;
const OPEN_MIN_ET = 570; // 9:30 ET
const CT_BEHIND_ET_MIN = 60;

/** Bar i: open 6000 + i, high 6003 + i, low 5998 + i, close 6001 + i. */
function asOfDay(count: number): SlotCandle[] {
  return Array.from({ length: count }, (_, i) => ({
    datetime: AS_OF_OPEN_MS + i * BAR_MS,
    open: 6000 + i,
    high: 6003 + i,
    low: 5998 + i,
    close: 6001 + i,
  }));
}

/** ET minute of day a candle of `asOfDay` starts at, read off its datetime. */
function startMinuteOf(candle: SlotCandle): number {
  return OPEN_MIN_ET + (candle.datetime - AS_OF_OPEN_MS) / MINUTE_MS;
}

/**
 * A copy of `day` with everything the as-of rule forbids at `slot` replaced
 * by `bad`: all four prices of a bar that has not started, and the high, low
 * and close of a bar that has started but not ended. A bar that has ended is
 * left alone, and so is the open of a running bar, which is a print.
 */
function withFutureReplaced(
  day: readonly SlotCandle[],
  slotMinuteCT: number,
  bad: number,
): SlotCandle[] {
  const slotET = slotMinuteCT + CT_BEHIND_ET_MIN;
  return day.map((c) => {
    const start = startMinuteOf(c);
    if (start + 5 <= slotET) return c;
    if (start <= slotET) return { ...c, high: bad, low: bad, close: bad };
    return { ...c, open: bad, high: bad, low: bad, close: bad };
  });
}

type OpeningRangeWant = {
  high: number;
  low: number;
  rangePts: number;
  complete: boolean;
} | null;

// 8:30 to 3:05 PM CT, the slots the sweeps run (505 is before the open).
const SWEEP_SLOTS = Array.from({ length: 401 }, (_, i) => 505 + i);

const FUTURE_VALUES = [
  ['9999', 9999],
  ['NaN', Number.NaN],
] as const;

describe('withFutureReplaced (the sweeps’ perturbation)', () => {
  it('leaves ended bars and the running bar’s open alone, and replaces the rest', () => {
    const day = asOfDay(8);
    // 8:40 CT = 9:40 ET: bars 0 and 1 ended, bar 2 is running (9:40 start).
    const copy = withFutureReplaced(day, 520, 9999);
    expect(copy.slice(0, 2)).toEqual(day.slice(0, 2));
    expect(copy[2]).toEqual({
      datetime: day[2]!.datetime,
      open: 6002,
      high: 9999,
      low: 9999,
      close: 9999,
    });
    for (const c of copy.slice(3)) {
      expect([c.open, c.high, c.low, c.close]).toEqual([
        9999, 9999, 9999, 9999,
      ]);
    }
  });
});

describe('spxSlotStateAsOf: the as-of table (78 bars)', () => {
  const day = asOfDay(78);

  it.each<[string, number, number, number, number, OpeningRangeWant, number]>([
    // [label, slotMinuteCT, spot, high, low, openingRange, entryIndex]
    ['8:30', 510, 6000, 6000, 6000, null, -1],
    [
      '8:35',
      515,
      6001,
      6003,
      5998,
      { high: 6003, low: 5998, rangePts: 5, complete: false },
      0,
    ],
    [
      '8:55',
      535,
      6005,
      6007,
      5998,
      { high: 6007, low: 5998, rangePts: 9, complete: false },
      4,
    ],
    [
      '9:00',
      540,
      6006,
      6008,
      5998,
      { high: 6008, low: 5998, rangePts: 10, complete: true },
      5,
    ],
    [
      '9:05',
      545,
      6007,
      6009,
      5998,
      { high: 6008, low: 5998, rangePts: 10, complete: true },
      6,
    ],
    [
      '2:55 PM',
      895,
      6077,
      6079,
      5998,
      { high: 6008, low: 5998, rangePts: 10, complete: true },
      76,
    ],
    [
      '3:00 PM',
      900,
      6078,
      6080,
      5998,
      { high: 6008, low: 5998, rangePts: 10, complete: true },
      77,
    ],
  ])('%s CT', (_label, slot, spot, high, low, openingRange, entryIndex) => {
    expect(spxSlotStateAsOf(day, slot)).toEqual({
      spot,
      runningOHLC: { open: 6000, high, low, last: spot },
      openingRange,
      entryIndex,
    });
  });
});

describe('spxSlotStateAsOf: a half day (42 bars)', () => {
  const half = asOfDay(42); // the last bar starts 12:55 ET and ends 1:00 PM ET

  it.each([
    ['11:55 CT, the last bar still running', 715, 6041, 40],
    ['12:00 CT, the last bar has ended', 720, 6042, 41],
    ['12:30 CT, after the close', 750, 6042, 41],
  ])('%s', (_label, slot, spot, entryIndex) => {
    const state = spxSlotStateAsOf(half, slot);
    expect(state?.spot).toBe(spot);
    expect(state?.entryIndex).toBe(entryIndex);
    expect(state?.runningOHLC.last).toBe(spot);
  });
});

describe('spxSlotStateAsOf: today’s partial session (10 bars)', () => {
  // The page fetches today's candles once, so the last bar may still run.
  // The last bar starts 10:15 ET and ends 10:20 ET (9:20 CT).
  const partial = asOfDay(10);

  it.each([
    ['9:17 CT, inside the last bar: the bar before it', 557, 6009, 8],
    ['9:20 CT, the last bar has ended', 560, 6010, 9],
    ['10:00 CT, long after every bar', 600, 6010, 9],
  ])('%s', (_label, slot, spot, entryIndex) => {
    const state = spxSlotStateAsOf(partial, slot);
    expect(state?.spot).toBe(spot);
    expect(state?.entryIndex).toBe(entryIndex);
  });
});

describe('spxSlotStateAsOf: a slot between 5-minute marks', () => {
  // The time picker and the live sync snap to 5 minutes, but the server
  // builder takes any minute.
  const day = asOfDay(78);

  it('8:37 CT: the first bar has ended, the second is running', () => {
    const state = spxSlotStateAsOf(day, 517);
    expect(state?.spot).toBe(6001);
    expect(state?.entryIndex).toBe(0);
    expect(state?.runningOHLC).toEqual({
      open: 6000,
      high: 6003,
      low: 5998,
      last: 6001,
    });
  });

  it('8:34 CT: no bar has ended yet, so the first bar’s open', () => {
    expect(spxSlotStateAsOf(day, 514)).toEqual({
      spot: 6000,
      runningOHLC: { open: 6000, high: 6000, low: 6000, last: 6000 },
      openingRange: null,
      entryIndex: -1,
    });
  });

  it('8:59 CT: the opening range is still partial, 9:00 CT completes it', () => {
    expect(spxSlotStateAsOf(day, 539)?.openingRange).toEqual({
      high: 6007,
      low: 5998,
      rangePts: 9,
      complete: false,
    });
    expect(spxSlotStateAsOf(day, 540)?.openingRange?.complete).toBe(true);
  });
});

describe('spxSlotStateAsOf: a gap mid-session', () => {
  // Drop the 9:45 ET bar (index 3). The 9:50 ET bar moves to index 3.
  const gap = asOfDay(78).filter((_, i) => i !== 3);

  it('8:55 CT: the last ended bar is the one after the gap, at its array index', () => {
    const state = spxSlotStateAsOf(gap, 535);
    expect(state?.spot).toBe(6005);
    expect(state?.entryIndex).toBe(3);
  });

  it('8:50 CT: the last ended bar is the one before the gap', () => {
    // 9:50 ET = 590: the 9:45 bar (missing) would have ended here; the 9:40
    // bar (index 2) is the last that did.
    const state = spxSlotStateAsOf(gap, 530);
    expect(state?.spot).toBe(6003);
    expect(state?.entryIndex).toBe(2);
  });

  it('9:00 CT: the opening range still completes', () => {
    expect(spxSlotStateAsOf(gap, 540)?.openingRange).toEqual({
      high: 6008,
      low: 5998,
      rangePts: 10,
      complete: true,
    });
  });
});

describe('spxSlotStateAsOf: the opening range', () => {
  it('takes bars that start before 10:00 ET, not the bar that starts at 10:00', () => {
    const day = asOfDay(78).map((c, i) =>
      i === 6 ? { ...c, high: 7000, low: 5000 } : c,
    );
    // 9:05 CT: bar 6 (10:00 ET) has ended. It moves the running range, not
    // the opening range.
    const state = spxSlotStateAsOf(day, 545);
    expect(state?.runningOHLC).toEqual({
      open: 6000,
      high: 7000,
      low: 5000,
      last: 6007,
    });
    expect(state?.openingRange).toEqual({
      high: 6008,
      low: 5998,
      rangePts: 10,
      complete: true,
    });
  });

  it('rounds the range to 2 decimals', () => {
    // 7000.3 - 6990.1 is 10.199999999999818 in floating point.
    const day = [
      {
        datetime: AS_OF_OPEN_MS,
        open: 6995,
        high: 7000.3,
        low: 6990.1,
        close: 6996,
      },
      {
        datetime: AS_OF_OPEN_MS + BAR_MS,
        open: 6996,
        high: 6999,
        low: 6991,
        close: 6997,
      },
    ];
    expect(spxSlotStateAsOf(day, 520)?.openingRange).toEqual({
      high: 7000.3,
      low: 6990.1,
      rangePts: 10.2,
      complete: false,
    });
  });

  it('is null, not zero-width, while no opening-range bar has ended', () => {
    const state = spxSlotStateAsOf(asOfDay(78), 510);
    expect(state).not.toBeNull();
    expect(state?.openingRange).toBeNull();
  });
});

describe('spxSlotStateAsOf: before the open and bad input', () => {
  const day = asOfDay(78);

  it('8:29 CT, before the open, is null', () => {
    expect(spxSlotStateAsOf(day, 509)).toBeNull();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'a slot of %s is null',
    (slot) => {
      expect(spxSlotStateAsOf(day, slot)).toBeNull();
    },
  );

  it('no candles is null', () => {
    expect(spxSlotStateAsOf([], 540)).toBeNull();
  });

  it('a session whose first bar starts 9:35 ET is null', () => {
    expect(spxSlotStateAsOf(day.slice(1), 540)).toBeNull();
    expect(spxSlotStateAsOf(day.slice(1), 510)).toBeNull();
  });

  it.each([
    ['NaN', Number.NaN],
    ['zero', 0],
    ['negative', -1],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])(
    'a %s close on the last ended bar is null, not another bar’s close',
    (_n, bad) => {
      const bars = day.map((c, i) => (i === 5 ? { ...c, close: bad } : c));
      // 9:00 CT: bar 5 is the last ended bar.
      expect(spxSlotStateAsOf(bars, 540)).toBeNull();
      // 8:55 CT: bar 5 is still running, so its close is not read.
      expect(spxSlotStateAsOf(bars, 535)?.spot).toBe(6005);
      // 9:05 CT: bar 6 is the last ended bar, with a good close.
      expect(spxSlotStateAsOf(bars, 545)?.spot).toBe(6007);
    },
  );

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['nanosecond-epoch', 1.7e18],
  ])(
    'a %s datetime on any bar is null at every slot, and never throws',
    (_n, bad) => {
      const bars = day.map((c, i) => (i === 2 ? { ...c, datetime: bad } : c));
      for (const slot of [510, 515, 545, 895]) {
        expect(spxSlotStateAsOf(bars, slot), `slot ${slot}`).toBeNull();
      }
    },
  );
});

describe('look-ahead sweep (spec G2): spxSlotStateAsOf', () => {
  const day = asOfDay(78);

  it.each(FUTURE_VALUES)(
    'bars the slot has not ended, replaced with %s, change nothing',
    (_name, bad) => {
      for (const slot of SWEEP_SLOTS) {
        const want = spxSlotStateAsOf(day, slot);
        // Not vacuous: from the open on there is a state to compare.
        if (slot >= 510) expect(want, `slot ${slot}`).not.toBeNull();
        expect(
          spxSlotStateAsOf(withFutureReplaced(day, slot, bad), slot),
          `slot ${slot}`,
        ).toEqual(want);
      }
    },
  );
});

describe('symbolPriceAsOf', () => {
  describe('a full day of bars (78)', () => {
    const day = asOfDay(78);

    it.each([
      ['8:30 CT, the first bar running: its open', 510, 6000],
      ['8:35 CT: the first bar’s close', 515, 6001],
      ['9:00 CT: bar 5’s close', 540, 6006],
      ['2:55 PM CT: bar 76’s close', 895, 6077],
      ['3:05 PM CT, after every bar: the last close', 905, 6078],
    ])('%s', (_label, slot, want) => {
      expect(symbolPriceAsOf(day, slot)).toBe(want);
    });

    it('is null before the first bar starts', () => {
      expect(symbolPriceAsOf(day, 509)).toBeNull();
    });
  });

  describe('a sparse series, one bar starting 11:00 ET', () => {
    const sparse: SlotCandle[] = [
      {
        datetime: AS_OF_OPEN_MS + 90 * MINUTE_MS, // 11:00 ET
        open: 15.1,
        high: 15.6,
        low: 15,
        close: 15.3,
      },
    ];

    it.each([
      ['9:55 CT, before the bar starts', 595, null],
      ['10:00 CT, the bar starts: its open', 600, 15.1],
      ['10:04 CT, the bar still runs: its open', 604, 15.1],
      ['10:05 CT, the bar has ended: its close', 605, 15.3],
      ['3:00 PM CT: its close', 900, 15.3],
    ])('%s', (_label, slot, want) => {
      expect(symbolPriceAsOf(sparse, slot)).toBe(want);
    });
  });

  describe('a series with a gap', () => {
    // 10:00 ET and 10:30 ET bars only.
    const gappy: SlotCandle[] = [
      {
        datetime: AS_OF_OPEN_MS + 30 * MINUTE_MS,
        open: 15,
        high: 15.5,
        low: 14.9,
        close: 15.2,
      },
      {
        datetime: AS_OF_OPEN_MS + 60 * MINUTE_MS,
        open: 16,
        high: 16.5,
        low: 15.9,
        close: 16.2,
      },
    ];

    it.each([
      ['9:00 CT, first bar running: its open', 540, 15],
      ['9:05 CT, first bar ended: its close', 545, 15.2],
      // The second bar has started but not ended, and a bar has ended, so
      // the first bar's close wins over the second bar's open.
      ['9:30 CT, second bar running: the first bar’s close', 570, 15.2],
      ['9:35 CT, second bar ended: its close', 575, 16.2],
    ])('%s', (_label, slot, want) => {
      expect(symbolPriceAsOf(gappy, slot)).toBe(want);
    });
  });

  describe('bad input', () => {
    const day = asOfDay(78);

    it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
      'a slot of %s is null',
      (slot) => {
        expect(symbolPriceAsOf(day, slot)).toBeNull();
      },
    );

    it('no candles is null', () => {
      expect(symbolPriceAsOf([], 540)).toBeNull();
    });

    it.each([
      ['NaN', Number.NaN],
      ['zero', 0],
      ['negative', -1],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])(
      'a %s close on the last ended bar is null, not another bar’s value',
      (_n, bad) => {
        const bars = day.map((c, i) => (i === 5 ? { ...c, close: bad } : c));
        expect(symbolPriceAsOf(bars, 540)).toBeNull();
        expect(symbolPriceAsOf(bars, 535)).toBe(6005);
      },
    );

    it.each([
      ['NaN', Number.NaN],
      ['zero', 0],
    ])('a %s open on the first bar, while it runs, is null', (_n, bad) => {
      const bars = day.map((c, i) => (i === 0 ? { ...c, open: bad } : c));
      expect(symbolPriceAsOf(bars, 510)).toBeNull();
      expect(symbolPriceAsOf(bars, 515)).toBe(6001);
    });

    // The module-wide rule, as priceContextAsOf has it: a bar that can't be
    // placed on the clock makes the whole series null at every slot.
    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['nanosecond-epoch', 1.7e18],
    ])(
      'a %s datetime on bar 2 is null at every slot, and never throws',
      (_n, bad) => {
        const bars = day.map((c, i) => (i === 2 ? { ...c, datetime: bad } : c));
        for (const slot of [515, 545, 895]) {
          expect(symbolPriceAsOf(bars, slot), `slot ${slot}`).toBeNull();
        }
      },
    );
  });
});

describe('look-ahead sweep (spec G2): symbolPriceAsOf', () => {
  const day = asOfDay(78);

  it.each(FUTURE_VALUES)(
    'bars the slot has not ended, replaced with %s, change nothing',
    (_name, bad) => {
      for (const slot of SWEEP_SLOTS) {
        const want = symbolPriceAsOf(day, slot);
        if (slot >= 510) expect(want, `slot ${slot}`).not.toBeNull();
        expect(
          symbolPriceAsOf(withFutureReplaced(day, slot, bad), slot),
          `slot ${slot}`,
        ).toBe(want);
      }
    },
  );
});
