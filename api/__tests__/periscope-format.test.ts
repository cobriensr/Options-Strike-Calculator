// @vitest-environment node

/**
 * Unit tests for periscope-format.ts.
 *
 * The pure formatter (`formatPeriscopeForClaude`) and the helper
 * (`findGammaSignFlips`) are tested directly with hand-built fixtures
 * so we can lock the output shape independent of the DB. The DB-fetch
 * functions (`fetchLatestPeriscopeSlot`, `fetchPriorPeriscopeSlot`,
 * `buildPeriscopeContextBlock`) are tested with a mocked `getDb`.
 */

import { vi, beforeEach, describe, it, expect } from 'vitest';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: () => mockSql,
}));

import {
  findGammaSignFlips,
  formatPeriscopeForClaude,
  fetchLatestPeriscopeSlot,
  buildPeriscopeContextBlock,
  type PeriscopeSlot,
} from '../_lib/periscope-format.js';

beforeEach(() => {
  mockSql.mockReset();
});

// Real ±50 sample from 2026-05-07's last RTH slot, used to make the
// fixture realistic enough that magnitudes match what Claude will see
// in production.
const realGamma2026_05_07: Array<[number, number]> = [
  [7290, -97],
  [7295, -438],
  [7300, 420],
  [7305, 181],
  [7310, 97],
  [7315, 634],
  [7320, -548],
  [7325, -108],
  [7330, -460],
  [7335, 332],
  [7340, 270],
  [7345, 200],
  [7350, 3187],
  [7355, 95],
  [7360, 240],
  [7365, -1174],
  [7370, 278],
  [7375, -1122],
  [7380, -438],
  [7385, -48],
];

const realCharm2026_05_07: Array<[number, number]> = [
  [7290, -16704],
  [7295, -60452],
  [7300, 45160],
  [7305, 14417],
  [7310, 5251],
  [7315, 19042],
  [7320, -4108],
  [7325, 1533],
  [7330, 16317],
  [7335, -18829],
  [7340, -21141],
  [7345, -20209],
  [7350, -401000],
  [7355, -14533],
  [7360, -44172],
  [7365, 258000],
  [7370, -73090],
  [7375, 351000],
  [7380, 164000],
  [7385, 21718],
];

const realVanna2026_05_07: Array<[number, number]> = [
  [7290, 11838],
  [7295, 46784],
  [7300, -39105],
  [7305, -14595],
  [7310, -6700],
  [7315, -36621],
  [7320, 25998],
  [7325, 4008],
  [7330, 12544],
  [7335, -5761],
  [7340, -1964],
  [7345, 637],
  [7350, 46073],
  [7355, 2547],
  [7360, 9751],
  [7365, -66414],
  [7370, 21027],
  [7375, -109000],
  [7380, -54807],
  [7385, -7648],
];

function makeSlot(
  capturedAt: string,
  expiry: string,
  gamma: Array<[number, number]>,
  charm: Array<[number, number]>,
  vanna: Array<[number, number]>,
): PeriscopeSlot {
  return {
    capturedAt,
    expiry,
    gamma: gamma.map(([strike, value]) => ({ strike, value })),
    charm: charm.map(([strike, value]) => ({ strike, value })),
    vanna: vanna.map(([strike, value]) => ({ strike, value })),
  };
}

describe('findGammaSignFlips', () => {
  it('returns empty array when no flips occur', () => {
    const latest = [{ strike: 7300, value: 100 }];
    const prior = [{ strike: 7300, value: 50 }];
    expect(findGammaSignFlips(latest, prior)).toEqual([]);
  });

  it('detects sign flip at strike with non-trivial new value', () => {
    const latest = [{ strike: 7300, value: 1000 }];
    const prior = [{ strike: 7300, value: -500 }];
    const flips = findGammaSignFlips(latest, prior);
    expect(flips).toEqual([{ strike: 7300, from: -500, to: 1000 }]);
  });

  it('filters out trivial flips (under 10% of slice max)', () => {
    const latest = [
      { strike: 7300, value: 5000 },
      { strike: 7350, value: 100 },
    ];
    const prior = [
      { strike: 7300, value: 100 },
      { strike: 7350, value: -100 },
    ];
    // 7350 flipped sign but 100 is < 10% of slice max (5000), so filtered.
    const flips = findGammaSignFlips(latest, prior);
    expect(flips).toEqual([]);
  });

  it('skips strikes missing from prior slice (fresh strikes)', () => {
    const latest = [{ strike: 7300, value: 1000 }];
    const prior: Array<{ strike: number; value: number }> = [];
    expect(findGammaSignFlips(latest, prior)).toEqual([]);
  });

  it('skips strikes where prior was 0 (no prior position to flip from)', () => {
    const latest = [{ strike: 7300, value: 1000 }];
    const prior = [{ strike: 7300, value: 0 }];
    expect(findGammaSignFlips(latest, prior)).toEqual([]);
  });
});

describe('formatPeriscopeForClaude', () => {
  it('emits ceiling, floor, charm tally, and cone block for real 05/07 data', () => {
    const latest = makeSlot(
      '2026-05-07T19:50:00Z',
      '2026-05-07',
      realGamma2026_05_07,
      realCharm2026_05_07,
      realVanna2026_05_07,
    );
    const out = formatPeriscopeForClaude({
      latest,
      prior: null,
      spot: 7337,
      cone: {
        coneUpper: 7395,
        coneLower: 7280,
        coneWidth: 115,
        asymmetryPts: -2.5,
        spotAtCalc: 7337.5,
      },
      breaches: [],
    });

    // The dominant +γ ceiling above 7337 in this sample is 7350 (+3187).
    expect(out).toMatch(/\+γ ceiling: 7350 \(\+3\.2K\) — 13\.0 pts above spot/);
    // The strongest +γ below spot is 7315 (+634), not 7335 — peak +γ wins
    // over proximity-to-spot in this read (deliberate, mirrors the skill's
    // "biggest +γ acts as floor" rule).
    expect(out).toMatch(/\+γ floor: 7315 \(\+634\) — 22\.0 pts below spot/);
    // Top -γ acceleration includes 7365 and 7375.
    expect(out).toMatch(/−γ acceleration/);
    expect(out).toMatch(/7365|7375/);
    // Cone block. asymmetryPts: -2.5 = call_mark > put_mark = upside-skewed
    // (the convention from compute-cone.ts: asymmetry = put_mark - call_mark).
    expect(out).toMatch(/Straddle cone/);
    expect(out).toMatch(/upper 7395\.0/);
    expect(out).toMatch(/upper-skewed \(upside priced richer\)/);
    // No-breach distance reporting.
    expect(out).toMatch(/No breach yet/);
  });

  it('labels positive asymmetry as lower-skewed (downside priced richer)', () => {
    // Source-of-truth convention from compute-cone.ts:
    //   asymmetry_pts = put_mark - call_mark
    //   POSITIVE = puts richer = downside priced richer = lower bound
    //              farther from calc spot than upper bound.
    // Locks the corrected mapping so a future inversion regression is
    // caught by the test, not by Claude misreading the cone in prod.
    const latest = makeSlot(
      '2026-05-07T19:50:00Z',
      '2026-05-07',
      [[7300, 100]],
      [],
      [],
    );
    const out = formatPeriscopeForClaude({
      latest,
      prior: null,
      spot: 7300,
      cone: {
        coneUpper: 7330,
        coneLower: 7250,
        coneWidth: 80,
        asymmetryPts: 5.0,
        spotAtCalc: 7300,
      },
      breaches: [],
    });
    expect(out).toMatch(/asymmetry \+5\.0 pts \(lower-skewed \(downside priced richer\)\)/);
  });

  it('produces a coherent block when no strikes are near spot', () => {
    // All gamma strikes >100 pts from spot — ceiling/floor branches
    // hit the "none within ±100" fallback. Block must still render
    // cleanly without throwing or producing garbage.
    const latest = makeSlot(
      '2026-05-07T19:50:00Z',
      '2026-05-07',
      [[8000, 1000]],
      [],
      [],
    );
    const out = formatPeriscopeForClaude({
      latest,
      prior: null,
      spot: 7000,
      cone: null,
      breaches: [],
    });
    expect(out).toMatch(/\+γ ceiling: none within ±100/);
    expect(out).toMatch(/\+γ floor: none within ±100/);
    expect(out).toMatch(/−γ acceleration \(top 3\): none/);
  });

  it('detects a real charm-zero crossing, not the leftmost strike', () => {
    // Cumulative starts negative (-100), crosses to positive at 7320
    // (cum = -100 + -50 + 200 = 50). Charm-zero strike must be 7320,
    // NOT 7300 (the old buggy "first non-negative" detector would have
    // returned the leftmost on a different fixture).
    const latest = makeSlot(
      '2026-05-07T19:50:00Z',
      '2026-05-07',
      [],
      [
        [7300, -100],
        [7310, -50],
        [7320, 200],
        [7330, 100],
      ],
      [],
    );
    const out = formatPeriscopeForClaude({
      latest,
      prior: null,
      spot: 7320,
      cone: null,
      breaches: [],
    });
    expect(out).toMatch(/Charm-zero strike: 7320/);
  });

  it('omits charm-zero line when cumulative never crosses', () => {
    // All-positive cumulative — no genuine sign change. The old buggy
    // detector would have returned 7300 (first non-negative running
    // sum). The fix must omit the line entirely.
    const latest = makeSlot(
      '2026-05-07T19:50:00Z',
      '2026-05-07',
      [],
      [
        [7300, 100],
        [7310, 200],
        [7320, 300],
      ],
      [],
    );
    const out = formatPeriscopeForClaude({
      latest,
      prior: null,
      spot: 7310,
      cone: null,
      breaches: [],
    });
    expect(out).not.toMatch(/Charm-zero strike/);
  });

  it('emits a line per breach when multiple are recorded', () => {
    const latest = makeSlot(
      '2026-05-07T19:50:00Z',
      '2026-05-07',
      [[7300, 100]],
      [],
      [],
    );
    const out = formatPeriscopeForClaude({
      latest,
      prior: null,
      spot: 7300,
      cone: {
        coneUpper: 7330,
        coneLower: 7250,
        coneWidth: 80,
        asymmetryPts: 0,
        spotAtCalc: 7300,
      },
      breaches: [
        {
          direction: 'lower',
          breachTime: '2026-05-07T15:30:00Z',
          spotAtBreach: 7245,
          ptsPastBound: 5,
        },
        {
          direction: 'upper',
          breachTime: '2026-05-07T19:00:00Z',
          spotAtBreach: 7335,
          ptsPastBound: 5,
        },
      ],
    });
    expect(out).toMatch(/LOWER BREACH/);
    expect(out).toMatch(/UPPER BREACH/);
  });

  it('reports cone breach when present', () => {
    const latest = makeSlot(
      '2026-05-07T19:50:00Z',
      '2026-05-07',
      realGamma2026_05_07,
      realCharm2026_05_07,
      realVanna2026_05_07,
    );
    const out = formatPeriscopeForClaude({
      latest,
      prior: null,
      spot: 7337,
      cone: {
        coneUpper: 7395,
        coneLower: 7280,
        coneWidth: 115,
        asymmetryPts: -2.5,
        spotAtCalc: 7337.5,
      },
      breaches: [
        {
          direction: 'upper',
          breachTime: '2026-05-07T18:30:00Z',
          spotAtBreach: 7398.5,
          ptsPastBound: 3.5,
        },
      ],
    });
    expect(out).toMatch(/UPPER BREACH/);
    expect(out).toMatch(/Vol-extension setup; do not fade/);
  });

  it('reports gamma sign flips when prior slice is provided', () => {
    const latest = makeSlot(
      '2026-05-07T19:50:00Z',
      '2026-05-07',
      [
        [7330, 1500],
        [7340, -800],
      ],
      [],
      [],
    );
    const prior = makeSlot(
      '2026-05-07T19:40:00Z',
      '2026-05-07',
      [
        [7330, -1200],
        [7340, 600],
      ],
      [],
      [],
    );
    const out = formatPeriscopeForClaude({
      latest,
      prior,
      spot: 7337,
      cone: null,
      breaches: [],
    });
    expect(out).toMatch(/Gamma sign flips since prior slice/);
    expect(out).toMatch(/7330: −γ -1\.2K → \+γ \+1\.5K/);
  });

  it('omits cone section when cone is null', () => {
    const latest = makeSlot(
      '2026-05-07T19:50:00Z',
      '2026-05-07',
      realGamma2026_05_07,
      realCharm2026_05_07,
      realVanna2026_05_07,
    );
    const out = formatPeriscopeForClaude({
      latest,
      prior: null,
      spot: 7337,
      cone: null,
      breaches: [],
    });
    expect(out).not.toMatch(/Straddle cone/);
  });

  it('reports charm tally with K formatting', () => {
    const latest = makeSlot(
      '2026-05-07T19:50:00Z',
      '2026-05-07',
      realGamma2026_05_07,
      realCharm2026_05_07,
      realVanna2026_05_07,
    );
    const out = formatPeriscopeForClaude({
      latest,
      prior: null,
      spot: 7337,
      cone: null,
      breaches: [],
    });
    // Net charm tally ±50 from real data ≈ 80K (sum of 7287..7387).
    expect(out).toMatch(/Net tally ±50:/);
    expect(out).toMatch(/Net tally ±100:/);
  });
});

describe('fetchLatestPeriscopeSlot', () => {
  it('returns null when no rows for expiry', async () => {
    mockSql.mockResolvedValueOnce([{ captured_at: null }]);
    const out = await fetchLatestPeriscopeSlot('2026-05-08');
    expect(out).toBeNull();
  });

  it('loads gamma/charm/vanna rows for the latest slot', async () => {
    mockSql
      .mockResolvedValueOnce([{ captured_at: '2026-05-07T19:50:00Z' }])
      .mockResolvedValueOnce([
        { panel: 'gamma', strike: 7300, value: '420.00' },
        { panel: 'charm', strike: 7300, value: '45160.00' },
        { panel: 'vanna', strike: 7300, value: '-39105.00' },
      ]);
    const out = await fetchLatestPeriscopeSlot('2026-05-07');
    expect(out).not.toBeNull();
    expect(out!.gamma).toEqual([{ strike: 7300, value: 420 }]);
    expect(out!.charm).toEqual([{ strike: 7300, value: 45160 }]);
    expect(out!.vanna).toEqual([{ strike: 7300, value: -39105 }]);
  });
});

describe('buildPeriscopeContextBlock', () => {
  it('returns null when no slot exists', async () => {
    mockSql.mockResolvedValueOnce([{ captured_at: null }]);
    const out = await buildPeriscopeContextBlock({
      date: '2026-05-08',
      expiry: '2026-05-08',
      spot: 7337,
    });
    expect(out).toBeNull();
  });

  it('assembles end-to-end formatted block for a real-shaped fixture', async () => {
    // Sequence:
    //   1. latest captured_at lookup (fetchLatestPeriscopeSlot)
    //   2. latest panel rows
    //   3. Promise.all starts — sync order is prior captured_at, cone, breaches
    //      (each fetcher's first sql call registers in order).
    //   3. prior captured_at lookup
    //   4. cone_levels
    //   5. cone_breach_events
    //   6. prior panel rows (resolves after prior captured_at returns)
    mockSql
      .mockResolvedValueOnce([{ captured_at: '2026-05-07T19:50:00Z' }])
      .mockResolvedValueOnce(
        [...realGamma2026_05_07, ...realCharm2026_05_07, ...realVanna2026_05_07].map(
          ([strike, value], idx) => {
            const total = realGamma2026_05_07.length;
            const charmTotal = realCharm2026_05_07.length;
            let panel: string;
            if (idx < total) panel = 'gamma';
            else if (idx < total + charmTotal) panel = 'charm';
            else panel = 'vanna';
            return { panel, strike, value: String(value) };
          },
        ),
      )
      .mockResolvedValueOnce([{ captured_at: '2026-05-07T19:40:00Z' }])
      .mockResolvedValueOnce([
        {
          cone_upper: '7395.00',
          cone_lower: '7280.00',
          cone_width: '115.00',
          asymmetry_pts: '-2.50',
          spot_at_calc: '7337.50',
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const out = await buildPeriscopeContextBlock({
      date: '2026-05-07',
      expiry: '2026-05-07',
      spot: 7337,
    });
    expect(out).not.toBeNull();
    expect(out).toMatch(/Straddle cone/);
    expect(out).toMatch(/\+γ ceiling: 7350/);
  });
});
