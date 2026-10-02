// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  barParityMismatches,
  barTapeLive,
  outcomeFromMinuteBars,
  periscopeFireWindow,
  type BarOutcome,
  type BarOutcomeValues,
  type MinuteBar,
  type PeriscopeFireWindow,
  type StoredOutcome,
} from '../_lib/periscope-lottery-outcome.js';

/** Bar at an HH:MM UTC minute on `day`: [open, high, low, close]. */
function bar(
  hhmm: string,
  [open, high, low, close]: [number, number, number, number],
  day = '2026-09-30',
): MinuteBar {
  return { start: new Date(`${day}T${hhmm}:00.000Z`), open, high, low, close };
}

const flat = (hhmm: string, px: number, day?: string): MinuteBar =>
  bar(hhmm, [px, px, px, px], day);

/** 10:00:10.620 ET on a regular CDT day — fire_time carries seconds. */
const CALL_FIRE = '2026-09-30T14:00:10.620Z';
const callWindow = (fireIso = CALL_FIRE): PeriscopeFireWindow =>
  periscopeFireWindow('call_lottery', new Date(fireIso), '2026-09-30');

function lockedValues(o: BarOutcome): BarOutcomeValues {
  if (o.kind !== 'locked') {
    throw new Error(`expected locked, got abstain: ${o.reason}`);
  }
  return o.values;
}

describe('periscopeFireWindow', () => {
  it.each([
    {
      name: 'regular CDT day, call (120 min hold)',
      fireType: 'call_lottery' as const,
      fire: '2026-09-30T14:00:10.620Z',
      expiry: '2026-09-30',
      horizonEnd: '2026-09-30T16:00:10.620Z',
      closeCutoff: '2026-09-30T20:00:00.000Z',
      settledAt: '2026-09-30T20:00:00.000Z',
      tailStart: '2026-09-30T19:50:00.000Z',
    },
    {
      name: 'regular CDT day, put (180 min hold)',
      fireType: 'put_lottery' as const,
      fire: '2026-09-30T14:00:10.620Z',
      expiry: '2026-09-30',
      horizonEnd: '2026-09-30T17:00:10.620Z',
      closeCutoff: '2026-09-30T20:00:00.000Z',
      settledAt: '2026-09-30T20:00:00.000Z',
      tailStart: '2026-09-30T19:50:00.000Z',
    },
    {
      name: 'regular CST day: 15:00 CT = 21:00 UTC',
      fireType: 'call_lottery' as const,
      fire: '2026-12-01T15:00:00.000Z',
      expiry: '2026-12-01',
      horizonEnd: '2026-12-01T17:00:00.000Z',
      closeCutoff: '2026-12-01T21:00:00.000Z',
      settledAt: '2026-12-01T21:00:00.000Z',
      tailStart: '2026-12-01T20:50:00.000Z',
    },
    {
      // Black Friday: 13:00 ET close. The EOD cutoff stays 15:00 CT, as in
      // the cron, but the window settles at the real 12:00 CT close.
      name: 'early close (2026-11-27): settles at 13:00 ET',
      fireType: 'call_lottery' as const,
      fire: '2026-11-27T15:00:20.000Z',
      expiry: '2026-11-27',
      horizonEnd: '2026-11-27T17:00:20.000Z',
      closeCutoff: '2026-11-27T21:00:00.000Z',
      settledAt: '2026-11-27T18:00:00.000Z',
      tailStart: '2026-11-27T17:50:00.000Z',
    },
    {
      name: 'fire near the close: horizon past the close, tail starts at the fire',
      fireType: 'put_lottery' as const,
      fire: '2026-09-30T19:55:30.000Z',
      expiry: '2026-09-30',
      horizonEnd: '2026-09-30T22:55:30.000Z',
      closeCutoff: '2026-09-30T20:00:00.000Z',
      settledAt: '2026-09-30T20:00:00.000Z',
      tailStart: '2026-09-30T19:55:30.000Z',
    },
  ])('$name', (c) => {
    const w = periscopeFireWindow(c.fireType, new Date(c.fire), c.expiry);
    expect(w.fireTime.toISOString()).toBe(new Date(c.fire).toISOString());
    expect(w.horizonEnd.toISOString()).toBe(c.horizonEnd);
    expect(w.closeCutoff.toISOString()).toBe(c.closeCutoff);
    expect(w.settledAt.toISOString()).toBe(c.settledAt);
    expect(w.tailStart.toISOString()).toBe(c.tailStart);
  });
});

describe('outcomeFromMinuteBars', () => {
  describe('normal day', () => {
    // Newest first, as UW returns them.
    const bars = [
      flat('20:00', 0.1), // starts AT the 15:00 CT cutoff: outside EOD
      bar('19:59', [0.05, 0.05, 0.03, 0.04]), // last bar before the cutoff
      bar('16:05', [0.5, 0.9, 0.5, 0.6]), // after the horizon: no peak
      bar('16:00', [0.3, 0.3, 0.3, 0.3]), // tail (16:00:10 horizon), low
      bar('15:10', [0.4, 0.4, 0.3, 0.31]), // ties the peak later
      bar('14:30', [0.35, 0.4, 0.35, 0.38]), // first bar at the peak
      bar('14:01', [0.25, 0.26, 0.24, 0.25]),
      bar('14:00', [0.28, 0.29, 0.26, 0.27]), // head minute
      flat('13:59', 0.6), // wholly before the fire
    ];

    it('locks peak / EOD / R exactly as the cron defines them', () => {
      const v = lockedValues(outcomeFromMinuteBars(callWindow(), 0.27, bars));
      expect(v.peakPx).toBe(0.4);
      expect(v.peakPct).toBeCloseTo(0.4 / 0.27, 12);
      expect(v.peakTime?.toISOString()).toBe('2026-09-30T14:30:00.000Z');
      expect(v.eodClosePx).toBe(0.04);
      expect(v.realizedRPeak).toBeCloseTo((0.4 - 0.27) / 0.27, 12);
      expect(v.realizedREod).toBeCloseTo((0.04 - 0.27) / 0.27, 12);
    });

    it('does not depend on bar order', () => {
      const forward = outcomeFromMinuteBars(callWindow(), 0.27, bars);
      const reversed = outcomeFromMinuteBars(
        callWindow(),
        0.27,
        [...bars].reverse(),
      );
      expect(reversed).toEqual(forward);
    });
  });

  it('early close: EOD is the last bar before the 12:00 CT close', () => {
    const day = '2026-11-27';
    const w = periscopeFireWindow(
      'call_lottery',
      new Date('2026-11-27T15:00:20.000Z'),
      day,
    );
    const bars = [
      flat('15:00', 0.5, day), // head; entry 0.50
      bar('15:01', [0.52, 0.55, 0.5, 0.55], day),
      bar('15:10', [0.6, 0.8, 0.6, 0.7], day),
      bar('17:59', [0.06, 0.06, 0.05, 0.05], day),
    ];
    const v = lockedValues(outcomeFromMinuteBars(w, 0.5, bars));
    expect(v.peakPx).toBe(0.8);
    expect(v.peakTime?.toISOString()).toBe('2026-11-27T15:10:00.000Z');
    expect(v.eodClosePx).toBe(0.05);
    expect(barTapeLive(w, bars)).toBe(true);
  });

  describe('no usable bars', () => {
    it('abstains on an empty contract-day (never R = -1)', () => {
      expect(outcomeFromMinuteBars(callWindow(), 0.27, [])).toEqual({
        kind: 'abstain',
        reason: 'bars_miss_entry',
      });
    });

    it('abstains when every bar is before the fire', () => {
      const bars = [flat('13:30', 0.27), flat('13:59', 0.27)];
      expect(outcomeFromMinuteBars(callWindow(), 0.27, bars)).toEqual({
        kind: 'abstain',
        reason: 'bars_miss_entry',
      });
    });

    it('abstains when no bar near the fire brackets entry_px', () => {
      // Bars exist, but none in [fire, fire + 5 min] ever traded at 0.27.
      const bars = [
        flat('14:01', 0.4),
        flat('14:03', 0.45),
        flat('19:59', 0.05),
      ];
      expect(outcomeFromMinuteBars(callWindow(), 0.27, bars)).toEqual({
        kind: 'abstain',
        reason: 'bars_miss_entry',
      });
    });
  });

  it('gappy bars: uses only the minutes that traded', () => {
    const bars = [
      bar('14:00', [0.27, 0.27, 0.26, 0.26]), // head; entry 0.27
      bar('14:47', [0.3, 0.33, 0.3, 0.31]),
      bar('15:30', [0.2, 0.22, 0.18, 0.19]), // last bar of the day
    ];
    const v = lockedValues(outcomeFromMinuteBars(callWindow(), 0.27, bars));
    expect(v.peakPx).toBe(0.33);
    expect(v.peakTime?.toISOString()).toBe('2026-09-30T14:47:00.000Z');
    expect(v.eodClosePx).toBe(0.19);
  });

  describe('entry-bar (head minute) edges', () => {
    it('abstains when the head high may be a pre-fire print above every in-window price', () => {
      // entry 0.27 is in the head (14:01 opens at 0.26), but the head's 0.45
      // high could be before 14:00:10.620 — the true peak is 0.30..0.45.
      const bars = [
        bar('14:00', [0.45, 0.45, 0.27, 0.27]),
        bar('14:01', [0.26, 0.3, 0.26, 0.3]),
      ];
      expect(outcomeFromMinuteBars(callWindow(), 0.27, bars)).toEqual({
        kind: 'abstain',
        reason: 'ambiguous_peak',
      });
    });

    it('resolves the head high when it is the head close and the entry is in the head', () => {
      // The close follows the entry print, so the 0.45 close is post-fire.
      const bars = [
        bar('14:00', [0.3, 0.45, 0.27, 0.45]),
        bar('14:01', [0.4, 0.4, 0.35, 0.35]),
      ];
      const v = lockedValues(outcomeFromMinuteBars(callWindow(), 0.27, bars));
      expect(v.peakPx).toBe(0.45);
      expect(v.peakTime?.toISOString()).toBe(CALL_FIRE); // clamped to fire_time
    });

    it('puts peak_time in the head when the entry print is the peak', () => {
      const bars = [
        bar('14:00', [0.29, 0.3, 0.28, 0.28]),
        bar('14:01', [0.27, 0.27, 0.22, 0.22]),
        flat('19:59', 0.05),
      ];
      const v = lockedValues(outcomeFromMinuteBars(callWindow(), 0.3, bars));
      expect(v.peakPx).toBe(0.3);
      expect(v.realizedRPeak).toBe(0);
      expect(v.peakTime?.toISOString()).toBe(CALL_FIRE);
    });

    it('locks prices but leaves peak_time NULL when the head ties the peak unproven', () => {
      // Head high 0.35 = the 14:20 high, but the head's 0.35 print may be
      // pre-fire: the cron's peak_time is in 14:00 OR 14:20 — undecidable.
      const bars = [
        bar('14:00', [0.35, 0.35, 0.27, 0.29]),
        bar('14:01', [0.3, 0.3, 0.28, 0.28]),
        bar('14:20', [0.33, 0.35, 0.33, 0.34]),
        flat('19:59', 0.05),
      ];
      const v = lockedValues(outcomeFromMinuteBars(callWindow(), 0.27, bars));
      expect(v.peakPx).toBe(0.35);
      expect(v.peakTime).toBeNull();
      expect(v.eodClosePx).toBe(0.05);
    });

    it('cannot place the entry in the head when the next bar opens at entry_px', () => {
      // The entry may be 14:01's open, so the head's 0.40 may all be
      // pre-fire: 0.35..0.40 is undecidable.
      const bars = [flat('14:00', 0.4), bar('14:01', [0.27, 0.35, 0.27, 0.3])];
      expect(outcomeFromMinuteBars(callWindow(), 0.27, bars)).toEqual({
        kind: 'abstain',
        reason: 'ambiguous_peak',
      });
    });

    it('ignores a head below the provable peak even when the entry is unplaced', () => {
      const bars = [flat('14:00', 0.3), bar('14:01', [0.27, 0.35, 0.27, 0.3])];
      const v = lockedValues(outcomeFromMinuteBars(callWindow(), 0.27, bars));
      expect(v.peakPx).toBe(0.35);
      expect(v.peakTime?.toISOString()).toBe('2026-09-30T14:01:00.000Z');
    });

    it('treats the fire minute as a whole in-window bar when fire_time is minute-aligned', () => {
      const w = callWindow('2026-09-30T14:00:00.000Z');
      const bars = [bar('14:00', [0.45, 0.5, 0.45, 0.46]), flat('14:05', 0.4)];
      const v = lockedValues(outcomeFromMinuteBars(w, 0.45, bars));
      expect(v.peakPx).toBe(0.5);
      expect(v.peakTime?.toISOString()).toBe('2026-09-30T14:00:00.000Z');
    });
  });

  describe('horizon-end edges', () => {
    it('abstains when the straddling last minute may hold the peak', () => {
      // Horizon 16:00:10.620: the 16:00 bar mixes in-window and late prints.
      const bars = [
        flat('14:00', 0.27),
        flat('15:00', 0.4),
        bar('16:00', [0.4, 0.6, 0.4, 0.5]),
      ];
      expect(outcomeFromMinuteBars(callWindow(), 0.27, bars)).toEqual({
        kind: 'abstain',
        reason: 'ambiguous_peak',
      });
    });

    it('excludes a bar starting exactly at a minute-aligned horizon end', () => {
      const w = callWindow('2026-09-30T14:00:00.000Z'); // horizon 16:00:00
      const bars = [
        flat('14:00', 0.27),
        flat('15:00', 0.4),
        flat('16:00', 0.9),
      ];
      const v = lockedValues(outcomeFromMinuteBars(w, 0.27, bars));
      expect(v.peakPx).toBe(0.4);
      expect(v.eodClosePx).toBe(0.9); // still before the 20:00 cutoff
    });
  });

  it('abstains on EOD when the only EOD bar is a head with no proven post-fire print', () => {
    // Fire 19:59:30. The 20:00 bar (at the cutoff, so outside EOD) opens at
    // entry_px inside the entry window, so the entry may be there and the
    // 19:59 close may be pre-fire.
    const w = periscopeFireWindow(
      'put_lottery',
      new Date('2026-09-30T19:59:30.000Z'),
      '2026-09-30',
    );
    const bars = [flat('19:59', 0.05), flat('20:00', 0.05)];
    expect(outcomeFromMinuteBars(w, 0.05, bars)).toEqual({
      kind: 'abstain',
      reason: 'ambiguous_eod',
    });
  });

  it('locks a late fire whose head is the only bar (no next bar proves the entry is in it)', () => {
    const w = periscopeFireWindow(
      'put_lottery',
      new Date('2026-09-30T19:59:30.000Z'),
      '2026-09-30',
    );
    const bars = [bar('19:59', [0.05, 0.05, 0.04, 0.04])];
    const v = lockedValues(outcomeFromMinuteBars(w, 0.05, bars));
    expect(v.peakPx).toBe(0.05);
    expect(v.peakTime?.toISOString()).toBe('2026-09-30T19:59:30.000Z');
    expect(v.eodClosePx).toBe(0.04); // head close: follows the entry print
  });

  it('abstains when the head must hold the entry print but never traded at entry_px', () => {
    // 14:01 does not open at 0.27, so the entry must be in the head — but
    // the head only traded at 0.40. Bars and tape disagree; the head's
    // close cannot stand in as a post-fire price.
    const bars = [flat('14:00', 0.4), bar('14:01', [0.3, 0.32, 0.25, 0.27])];
    expect(outcomeFromMinuteBars(callWindow(), 0.27, bars)).toEqual({
      kind: 'abstain',
      reason: 'bars_miss_entry',
    });
  });

  it('abstains on EOD when a bar straddles the cutoff', () => {
    // The parser rejects such bars; this guards a direct caller.
    const straddler: MinuteBar = {
      start: new Date('2026-09-30T19:59:30.000Z'),
      open: 0.05,
      high: 0.05,
      low: 0.05,
      close: 0.05,
    };
    const bars = [flat('14:00', 0.27), flat('15:00', 0.3), straddler];
    expect(outcomeFromMinuteBars(callWindow(), 0.27, bars)).toEqual({
      kind: 'abstain',
      reason: 'ambiguous_eod',
    });
  });
});

describe('barTapeLive', () => {
  const w = callWindow(); // tail [19:50, 20:00]

  it('is live when any bar lies wholly inside the tail', () => {
    expect(barTapeLive(w, [flat('14:00', 0.3), flat('19:55', 0.05)])).toBe(
      true,
    );
  });

  it('is dead when the last bar ends before the tail', () => {
    expect(barTapeLive(w, [flat('14:00', 0.3), flat('19:49', 0.05)])).toBe(
      false,
    );
  });

  it('is dead for a fire too close to the close for any whole bar to fit', () => {
    const late = periscopeFireWindow(
      'put_lottery',
      new Date('2026-09-30T19:59:34.053Z'),
      '2026-09-30',
    );
    expect(barTapeLive(late, [flat('19:59', 0.03)])).toBe(false);
  });
});

describe('barParityMismatches', () => {
  const bars: BarOutcomeValues = {
    peakPx: 0.4,
    peakPct: 0.4 / 0.27,
    peakTime: new Date('2026-09-30T14:30:00.000Z'),
    eodClosePx: 0.04,
    realizedRPeak: (0.4 - 0.27) / 0.27,
    realizedREod: (0.04 - 0.27) / 0.27,
  };
  // What the cron stores: NUMERIC(10,4), exact print time.
  const stored: StoredOutcome = {
    peakPx: 0.4,
    peakPct: 1.4815,
    peakTime: new Date('2026-09-30T14:30:47.231Z'),
    eodClosePx: 0.04,
    realizedRPeak: 0.4815,
    realizedREod: -0.8519, // -0.851851…: half a unit away, still a match
  };

  it('matches within NUMERIC(10,4) rounding and minute precision', () => {
    expect(barParityMismatches(stored, bars)).toEqual([]);
  });

  it('names a one-tick price difference with both values', () => {
    expect(barParityMismatches({ ...stored, peakPx: 0.41 }, bars)).toEqual([
      { column: 'peak_px', cron: '0.41', bars: '0.4' },
    ]);
  });

  it('flags a peak_time in a different minute', () => {
    const diffs = barParityMismatches(
      { ...stored, peakTime: new Date('2026-09-30T14:31:02.000Z') },
      bars,
    );
    expect(diffs.map((d) => d.column)).toEqual(['peak_time']);
  });

  it('does not count an undecidable (NULL) bar peak_time as a mismatch', () => {
    expect(barParityMismatches(stored, { ...bars, peakTime: null })).toEqual(
      [],
    );
  });

  it('flags NULL vs value on EOD in either direction', () => {
    expect(
      barParityMismatches({ ...stored, eodClosePx: null }, bars).map(
        (d) => d.column,
      ),
    ).toEqual(['eod_close_px']);
    expect(
      barParityMismatches(stored, { ...bars, eodClosePx: null }).map(
        (d) => d.column,
      ),
    ).toEqual(['eod_close_px']);
  });
});
