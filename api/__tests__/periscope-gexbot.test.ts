// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  GEXBOT_TO_MM_SIGN,
  decodeStrikes,
  decodeStrikesWithHistory,
  type GexbotStatePayload,
} from '../_lib/periscope-gexbot';

/**
 * Helper: minimal `mini_contracts` row in GEXBot's documented shape.
 * Row layout: [strike, call_val, put_val, value, [t-5m,t-15m,t-30m], 0, null]
 */
function row(strike: number, value: number, prev: unknown = []): unknown[] {
  return [strike, 0, 0, value, prev, 0, null];
}

describe('GEXBot → MM sign (owner decision D1)', () => {
  const payload: GexbotStatePayload = {
    mini_contracts: [
      row(5950, -1234, [-1200, null, 0]),
      row(5960, 700, [650, 600, 580]),
      row(5970, 0, [0, 0, 0]),
    ],
  };

  it('negates gamma only; charm and vanna keep the vendor sign', () => {
    expect(GEXBOT_TO_MM_SIGN).toEqual({ gamma: -1, charm: 1, vanna: 1 });
  });

  it('decodeStrikes negates the gamma panel', () => {
    expect(decodeStrikes(payload, 'gamma')).toEqual([
      { strike: 5950, value: 1234 },
      { strike: 5960, value: -700 },
      { strike: 5970, value: 0 },
    ]);
  });

  it('decodeStrikes leaves charm and vanna in the vendor sign', () => {
    const raw = [
      { strike: 5950, value: -1234 },
      { strike: 5960, value: 700 },
      { strike: 5970, value: 0 },
    ];
    expect(decodeStrikes(payload, 'charm')).toEqual(raw);
    expect(decodeStrikes(payload, 'vanna')).toEqual(raw);
  });

  it('decodeStrikesWithHistory negates gamma and all three priors, so deltas keep their sign', () => {
    const [a, b] = decodeStrikesWithHistory(payload, 'gamma');
    expect(a).toEqual({
      strike: 5950,
      value: 1234,
      prev5m: 1200,
      prev15m: null,
      prev30m: 0,
    });
    expect(b).toEqual({
      strike: 5960,
      value: -700,
      prev5m: -650,
      prev15m: -600,
      prev30m: -580,
    });
    // Taker gamma grew 50 over 5 min (650 → 700), so MM gamma fell 50.
    expect(b!.value - b!.prev5m!).toBe(-(700 - 650));
  });

  it('never produces negative zero for a flipped 0', () => {
    const zero = decodeStrikesWithHistory(payload, 'gamma')[2]!;
    expect(Object.is(zero.value, 0)).toBe(true);
    expect(Object.is(zero.prev5m, 0)).toBe(true);
    expect(Object.is(zero.prev30m, 0)).toBe(true);
  });

  it('decodeStrikesWithHistory leaves charm and vanna priors unchanged', () => {
    expect(decodeStrikesWithHistory(payload, 'vanna')[1]).toEqual({
      strike: 5960,
      value: 700,
      prev5m: 650,
      prev15m: 600,
      prev30m: 580,
    });
  });
});

describe('decodeStrikes (back-compat)', () => {
  it('returns parsed rows in input order with rounded strikes', () => {
    const payload: GexbotStatePayload = {
      mini_contracts: [row(5950.4, -1234), row(5960.7, 500)],
    };
    expect(decodeStrikes(payload, 'charm')).toEqual([
      { strike: 5950, value: -1234 },
      { strike: 5961, value: 500 },
    ]);
  });

  it('drops rows where strike or position-3 is null / non-finite', () => {
    const payload: GexbotStatePayload = {
      mini_contracts: [
        [null, 0, 0, 100, [], 0, null],
        [5950, 0, 0, null, [], 0, null],
        [5950, 0, 0, 'nope', [], 0, null],
        ['NaN', 0, 0, 100, [], 0, null],
        row(5970, 200),
      ],
    };
    expect(decodeStrikes(payload, 'charm')).toEqual([
      { strike: 5970, value: 200 },
    ]);
  });

  it('returns [] when mini_contracts is absent or not an array', () => {
    expect(decodeStrikes({}, 'charm')).toEqual([]);
    expect(
      decodeStrikes(
        { mini_contracts: 'oops' as unknown as unknown[][] },
        'charm',
      ),
    ).toEqual([]);
  });
});

describe('decodeStrikesWithHistory', () => {
  it('populates prev5m / prev15m / prev30m from position-4 when fully filled', () => {
    const payload: GexbotStatePayload = {
      mini_contracts: [row(5950, -1234, [-1200, -1100, -1000])],
    };
    expect(decodeStrikesWithHistory(payload, 'charm')).toEqual([
      {
        strike: 5950,
        value: -1234,
        prev5m: -1200,
        prev15m: -1100,
        prev30m: -1000,
      },
    ]);
  });

  it('maps row[4] = [a, b, c] to prev5m = a, prev15m = b, prev30m = c (vendor windows t-5 / t-15 / t-30)', () => {
    const payload: GexbotStatePayload = {
      mini_contracts: [row(5950, 100, [11, 22, 33])],
    };
    const [decoded] = decodeStrikesWithHistory(payload, 'charm');
    expect(decoded?.prev5m).toBe(11);
    expect(decoded?.prev15m).toBe(22);
    expect(decoded?.prev30m).toBe(33);
    expect(decoded).not.toHaveProperty('prev1m');
    expect(decoded).not.toHaveProperty('prev10m');
  });

  it('returns all prev fields null when position-4 is missing entirely', () => {
    const payload: GexbotStatePayload = {
      mini_contracts: [[5950, 0, 0, 200]],
    };
    const decoded = decodeStrikesWithHistory(payload, 'charm');
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toMatchObject({
      strike: 5950,
      value: 200,
      prev5m: null,
      prev15m: null,
      prev30m: null,
    });
  });

  it('returns all prev fields null when position-4 is not an array', () => {
    const payload: GexbotStatePayload = {
      mini_contracts: [row(5950, 200, null as unknown as unknown[])],
    };
    expect(decodeStrikesWithHistory(payload, 'charm')).toEqual([
      { strike: 5950, value: 200, prev5m: null, prev15m: null, prev30m: null },
    ]);
  });

  it('fills the missing slots with null when position-4 is shorter than 3', () => {
    const payload: GexbotStatePayload = {
      mini_contracts: [row(5950, 200, [-1200])],
    };
    expect(decodeStrikesWithHistory(payload, 'charm')).toEqual([
      {
        strike: 5950,
        value: 200,
        prev5m: -1200,
        prev15m: null,
        prev30m: null,
      },
    ]);
  });

  it('maps null / NaN / undefined entries inside position-4 to null', () => {
    const payload: GexbotStatePayload = {
      mini_contracts: [row(5950, 200, [null, 'NaN', undefined])],
    };
    expect(decodeStrikesWithHistory(payload, 'charm')).toEqual([
      { strike: 5950, value: 200, prev5m: null, prev15m: null, prev30m: null },
    ]);
  });

  it('propagates literal 0 in position-4 as 0 (not null)', () => {
    // Locks the null-vs-0 distinction: `Number(null)` is 0 and `0` is
    // a perfectly valid prior value. We must not coalesce them.
    const payload: GexbotStatePayload = {
      mini_contracts: [[5950, 100, 100, 200, [0, 0, 0], 0, null]],
    };
    expect(decodeStrikesWithHistory(payload, 'charm')).toEqual([
      { strike: 5950, value: 200, prev5m: 0, prev15m: 0, prev30m: 0 },
    ]);
  });

  it('applies the same row-validity gates as decodeStrikes', () => {
    const payload: GexbotStatePayload = {
      mini_contracts: [
        [null, 0, 0, 100, [1, 2, 3], 0, null],
        [5950, 0, 0, null, [1, 2, 3], 0, null],
        row(5970, 200, [-1, -2, -3]),
      ],
    };
    expect(decodeStrikesWithHistory(payload, 'charm')).toEqual([
      {
        strike: 5970,
        value: 200,
        prev5m: -1,
        prev15m: -2,
        prev30m: -3,
      },
    ]);
  });

  it('returns [] when mini_contracts is absent', () => {
    expect(decodeStrikesWithHistory({}, 'charm')).toEqual([]);
  });
});
