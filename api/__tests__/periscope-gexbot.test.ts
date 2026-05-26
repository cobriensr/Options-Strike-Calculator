// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  decodeStrikes,
  decodeStrikesWithHistory,
  type GexbotStatePayload,
} from '../_lib/periscope-gexbot';

/**
 * Helper: minimal `mini_contracts` row in GEXBot's documented shape.
 * Row layout: [strike, call_val, put_val, value, [t-1m,t-5m,t-10m], 0, null]
 */
function row(strike: number, value: number, prev: unknown = []): unknown[] {
  return [strike, 0, 0, value, prev, 0, null];
}

describe('decodeStrikes (back-compat)', () => {
  it('returns parsed rows in input order with rounded strikes', () => {
    const payload: GexbotStatePayload = {
      mini_contracts: [row(5950.4, -1234), row(5960.7, 500)],
    };
    expect(decodeStrikes(payload)).toEqual([
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
    expect(decodeStrikes(payload)).toEqual([{ strike: 5970, value: 200 }]);
  });

  it('returns [] when mini_contracts is absent or not an array', () => {
    expect(decodeStrikes({})).toEqual([]);
    expect(
      decodeStrikes({ mini_contracts: 'oops' as unknown as unknown[][] }),
    ).toEqual([]);
  });
});

describe('decodeStrikesWithHistory', () => {
  it('populates prev1m / prev5m / prev10m from position-4 when fully filled', () => {
    const payload: GexbotStatePayload = {
      mini_contracts: [row(5950, -1234, [-1200, -1100, -1000])],
    };
    expect(decodeStrikesWithHistory(payload)).toEqual([
      {
        strike: 5950,
        value: -1234,
        prev1m: -1200,
        prev5m: -1100,
        prev10m: -1000,
      },
    ]);
  });

  it('returns all prev fields null when position-4 is missing entirely', () => {
    const payload: GexbotStatePayload = {
      mini_contracts: [[5950, 0, 0, 200]],
    };
    const decoded = decodeStrikesWithHistory(payload);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toMatchObject({
      strike: 5950,
      value: 200,
      prev1m: null,
      prev5m: null,
      prev10m: null,
    });
  });

  it('returns all prev fields null when position-4 is not an array', () => {
    const payload: GexbotStatePayload = {
      mini_contracts: [row(5950, 200, null as unknown as unknown[])],
    };
    expect(decodeStrikesWithHistory(payload)).toEqual([
      { strike: 5950, value: 200, prev1m: null, prev5m: null, prev10m: null },
    ]);
  });

  it('fills the missing slots with null when position-4 is shorter than 3', () => {
    const payload: GexbotStatePayload = {
      mini_contracts: [row(5950, 200, [-1200])],
    };
    expect(decodeStrikesWithHistory(payload)).toEqual([
      {
        strike: 5950,
        value: 200,
        prev1m: -1200,
        prev5m: null,
        prev10m: null,
      },
    ]);
  });

  it('maps null / NaN / undefined entries inside position-4 to null', () => {
    const payload: GexbotStatePayload = {
      mini_contracts: [row(5950, 200, [null, 'NaN', undefined])],
    };
    expect(decodeStrikesWithHistory(payload)).toEqual([
      { strike: 5950, value: 200, prev1m: null, prev5m: null, prev10m: null },
    ]);
  });

  it('propagates literal 0 in position-4 as 0 (not null)', () => {
    // Locks the null-vs-0 distinction: `Number(null)` is 0 and `0` is
    // a perfectly valid prior value. We must not coalesce them.
    const payload: GexbotStatePayload = {
      mini_contracts: [[5950, 100, 100, 200, [0, 0, 0], 0, null]],
    };
    expect(decodeStrikesWithHistory(payload)).toEqual([
      { strike: 5950, value: 200, prev1m: 0, prev5m: 0, prev10m: 0 },
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
    expect(decodeStrikesWithHistory(payload)).toEqual([
      {
        strike: 5970,
        value: 200,
        prev1m: -1,
        prev5m: -2,
        prev10m: -3,
      },
    ]);
  });

  it('returns [] when mini_contracts is absent', () => {
    expect(decodeStrikesWithHistory({})).toEqual([]);
  });
});
