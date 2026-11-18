import { describe, it, expect } from 'vitest';
import { priceContextAsOf, type SlotCandle } from '../../utils/snapshot-slot';

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
