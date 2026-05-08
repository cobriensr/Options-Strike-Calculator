// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// MOCKS — declared before module under test
// ============================================================

// `synthesizeFromDb` issues four parallel queries via tagged-template
// `sql\`...\``. The mock SQL function pulls from a queue of canned
// responses so each test can script the exact rows each query returns
// (cone bounds, gamma top slot, charm top slot, charm-zero slot, then
// the strike rows for each).
const sqlQueue: unknown[][] = [];
const mockSql = vi.fn(async (): Promise<unknown[]> => sqlQueue.shift() ?? []);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

// ============================================================
// IMPORTS (after mocks)
// ============================================================

import { synthesizeFromDb } from '../_lib/periscope-synthesize.js';

// ============================================================
// HELPERS
// ============================================================

const TRADING_DATE = '2026-05-08';
const READ_TIME = '2026-05-08T13:30:00.000Z';
const SPOT = 5800;

interface SynthesizeArgs {
  tradingDate?: string;
  readTimeIso?: string;
  spot?: number;
}

function callSynthesize(overrides: SynthesizeArgs = {}) {
  return synthesizeFromDb({
    tradingDate: overrides.tradingDate ?? TRADING_DATE,
    readTimeIso: overrides.readTimeIso ?? READ_TIME,
    spot: overrides.spot ?? SPOT,
  });
}

/**
 * Queue the SQL response sequence the synthesizer issues. The four
 * fetcher functions run inside `Promise.all`, so each makes its first
 * `sql\`...\`` call synchronously in the dispatch order before any
 * awaits resolve:
 *   1. fetchConeBounds         — cone_levels SELECT
 *   2. fetchTopStrikes(gamma)  — MAX(captured_at) lookup
 *   3. fetchTopStrikes(charm)  — MAX(captured_at) lookup
 *   4. fetchCharmZeroStrike    — MAX(captured_at) lookup
 *
 * Then the second pass — conditional on each slot having data:
 *   5. fetchTopStrikes(gamma)  — strike rows
 *   6. fetchTopStrikes(charm)  — strike rows
 *   7. fetchCharmZeroStrike    — strike rows in ±100 window
 *
 * If a slot returned `captured_at: null` or `[]`, the corresponding
 * second-pass query is skipped — caller passes `[]` for the rows in
 * that case to keep the helper API uniform.
 */
function queueAll(opts: {
  cone: Array<Record<string, unknown>>;
  gammaSlot: Array<Record<string, unknown>>;
  charmSlot: Array<Record<string, unknown>>;
  charmZeroSlot: Array<Record<string, unknown>>;
  gammaRows: Array<Record<string, unknown>>;
  charmRows: Array<Record<string, unknown>>;
  charmZeroRows: Array<Record<string, unknown>>;
}) {
  // Phase 1: parallel slot lookups.
  sqlQueue.push(opts.cone, opts.gammaSlot, opts.charmSlot, opts.charmZeroSlot);
  // Phase 2: conditional row fetches. We only enqueue the row-set if the
  // matching slot had a non-null captured_at — otherwise the synthesizer
  // skips that DB call.
  const gammaHasSlot =
    opts.gammaSlot.length > 0 && opts.gammaSlot[0]?.captured_at != null;
  const charmHasSlot =
    opts.charmSlot.length > 0 && opts.charmSlot[0]?.captured_at != null;
  const charmZeroHasSlot =
    opts.charmZeroSlot.length > 0 && opts.charmZeroSlot[0]?.captured_at != null;
  if (gammaHasSlot) sqlQueue.push(opts.gammaRows);
  if (charmHasSlot) sqlQueue.push(opts.charmRows);
  if (charmZeroHasSlot) sqlQueue.push(opts.charmZeroRows);
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlQueue.length = 0;
  mockSql.mockClear();
});

// ============================================================
// EMPTY / GATING BRANCH
// ============================================================

describe('synthesizeFromDb — gating', () => {
  it('returns null when DB has no cone, no gamma, and no charm rows', async () => {
    queueAll({
      cone: [],
      gammaSlot: [{ captured_at: null }],
      gammaRows: [],
      charmSlot: [{ captured_at: null }],
      charmRows: [],
      charmZeroSlot: [{ captured_at: null }],
      charmZeroRows: [],
    });
    const result = await callSynthesize();
    expect(result).toBeNull();
  });

  it('returns null when all slot lookups come back as empty arrays', async () => {
    // Some test paths return a blank result row even when no data exists.
    queueAll({
      cone: [],
      gammaSlot: [],
      gammaRows: [],
      charmSlot: [],
      charmRows: [],
      charmZeroSlot: [],
      charmZeroRows: [],
    });
    const result = await callSynthesize();
    expect(result).toBeNull();
  });
});

// ============================================================
// HAPPY PATHS — cone-only / heat-maps / both
// ============================================================

describe('synthesizeFromDb — cone-only path', () => {
  it('returns extraction with cone bounds and null heatMaps when only cone exists', async () => {
    queueAll({
      cone: [{ cone_lower: '5750.5', cone_upper: '5849.25' }],
      gammaSlot: [{ captured_at: null }],
      gammaRows: [],
      charmSlot: [{ captured_at: null }],
      charmRows: [],
      charmZeroSlot: [{ captured_at: null }],
      charmZeroRows: [],
    });

    const result = await callSynthesize();
    expect(result).not.toBeNull();
    expect(result!.heatMaps).toBeNull();
    expect(result!.charmZeroStrike).toBeNull();
    expect(result!.extraction.chartDate).toBe(TRADING_DATE);
    expect(result!.extraction.structured.spot).toBe(SPOT);
    expect(result!.extraction.structured.cone_lower).toBeCloseTo(5750.5, 5);
    expect(result!.extraction.structured.cone_upper).toBeCloseTo(5849.25, 5);
    expect(result!.extraction.structured.long_trigger).toBeNull();
    expect(result!.extraction.structured.bias).toBeNull();
    expect(result!.extraction.structured.trade_types_recommended).toEqual([]);
  });

  it('handles numeric (non-string) cone columns', async () => {
    queueAll({
      cone: [{ cone_lower: 5700, cone_upper: 5900 }],
      gammaSlot: [],
      gammaRows: [],
      charmSlot: [],
      charmRows: [],
      charmZeroSlot: [],
      charmZeroRows: [],
    });
    const result = await callSynthesize();
    expect(result).not.toBeNull();
    expect(result!.extraction.structured.cone_lower).toBe(5700);
    expect(result!.extraction.structured.cone_upper).toBe(5900);
  });
});

describe('synthesizeFromDb — heat-map path', () => {
  it('returns top-N positive + top-N negative strikes, sorted by strike', async () => {
    // 8 positive + 8 negative gamma rows; we expect 6 + 6 returned.
    const gammaRows = [
      { panel: 'gamma', strike: 5810, value: 1.0 },
      { panel: 'gamma', strike: 5820, value: 9.0 }, // top
      { panel: 'gamma', strike: 5830, value: 5.0 },
      { panel: 'gamma', strike: 5840, value: 7.0 },
      { panel: 'gamma', strike: 5850, value: 3.0 },
      { panel: 'gamma', strike: 5860, value: 6.0 },
      { panel: 'gamma', strike: 5870, value: '4.0' }, // string-typed
      { panel: 'gamma', strike: 5880, value: 0.5 }, // weakest, dropped
      { panel: 'gamma', strike: 5790, value: -1.0 }, // weakest neg, dropped
      { panel: 'gamma', strike: 5780, value: -9.0 }, // strongest neg
      { panel: 'gamma', strike: 5770, value: -5.0 },
      { panel: 'gamma', strike: 5760, value: -7.0 },
      { panel: 'gamma', strike: 5750, value: -3.0 },
      { panel: 'gamma', strike: 5740, value: -6.0 },
      { panel: 'gamma', strike: 5730, value: '-4.0' }, // string
      { panel: 'gamma', strike: 5800, value: 0 }, // zero — excluded
    ];

    queueAll({
      cone: [],
      gammaSlot: [{ captured_at: '2026-05-08T13:30:00Z' }],
      gammaRows,
      charmSlot: [{ captured_at: null }],
      charmRows: [],
      charmZeroSlot: [{ captured_at: null }],
      charmZeroRows: [],
    });

    const result = await callSynthesize();
    expect(result).not.toBeNull();
    expect(result!.heatMaps).not.toBeNull();
    const gex = result!.heatMaps!.gex;
    // 6 pos + 6 neg = 12 total, sorted ascending by strike.
    expect(gex.length).toBe(12);
    for (let i = 1; i < gex.length; i++) {
      expect(gex[i]!.strike).toBeGreaterThanOrEqual(gex[i - 1]!.strike);
    }
    // Top positive must be the 9.0 row at 5820, color green.
    const topPos = gex
      .filter((s) => s.color === 'green')
      .sort((a, b) => b.value - a.value)[0];
    expect(topPos!.strike).toBe(5820);
    expect(topPos!.value).toBe(9);
    // Strongest negative is -9 @ 5780, color red.
    const topNeg = gex
      .filter((s) => s.color === 'red')
      .sort((a, b) => a.value - b.value)[0];
    expect(topNeg!.strike).toBe(5780);
    // Zero-valued strike must NOT appear.
    expect(gex.find((s) => s.strike === 5800)).toBeUndefined();
    // Weakest pos (0.5) and weakest neg (-1) excluded.
    expect(gex.find((s) => s.strike === 5880)).toBeUndefined();
    expect(gex.find((s) => s.strike === 5790)).toBeUndefined();
  });

  it('handles a panel with no rows gracefully (returns [])', async () => {
    queueAll({
      cone: [{ cone_lower: 5700, cone_upper: 5900 }],
      gammaSlot: [{ captured_at: '2026-05-08T13:30:00Z' }],
      gammaRows: [], // captured_at exists but no rows
      charmSlot: [{ captured_at: null }],
      charmRows: [],
      charmZeroSlot: [{ captured_at: null }],
      charmZeroRows: [],
    });

    const result = await callSynthesize();
    expect(result).not.toBeNull();
    // gammaSlot returned a captured_at but the second query had no rows
    // → fetchTopStrikes returns []. Both panels empty → heatMaps null.
    expect(result!.heatMaps).toBeNull();
  });
});

// ============================================================
// CHARM-ZERO COMPUTATION
// ============================================================

describe('synthesizeFromDb — charm zero', () => {
  it('finds the strike where cumulative charm flips sign within ±100 of spot', async () => {
    // Cumulative sum walking from low → high strike:
    //   strike  value   cumulative
    //   5750    -3      -3
    //   5780    -2      -5
    //   5800    +4      -1   (still negative)
    //   5820    +6      +5   ← sign flip happens here
    //   5840    +1      +6
    queueAll({
      cone: [{ cone_lower: 5700, cone_upper: 5900 }],
      gammaSlot: [{ captured_at: null }],
      gammaRows: [],
      charmSlot: [{ captured_at: null }],
      charmRows: [],
      charmZeroSlot: [{ captured_at: '2026-05-08T13:30:00Z' }],
      charmZeroRows: [
        { strike: 5750, value: -3 },
        { strike: 5780, value: -2 },
        { strike: 5800, value: 4 },
        { strike: 5820, value: 6 },
        { strike: 5840, value: 1 },
      ],
    });

    const result = await callSynthesize();
    expect(result).not.toBeNull();
    expect(result!.charmZeroStrike).toBe(5820);
  });

  it('handles string-typed value rows when computing cumulative sign change', async () => {
    queueAll({
      cone: [{ cone_lower: 5700, cone_upper: 5900 }],
      gammaSlot: [{ captured_at: null }],
      gammaRows: [],
      charmSlot: [{ captured_at: null }],
      charmRows: [],
      charmZeroSlot: [{ captured_at: '2026-05-08T13:30:00Z' }],
      charmZeroRows: [
        { strike: 5780, value: '-5' },
        { strike: 5810, value: '8' }, // sign flips here
      ],
    });
    const result = await callSynthesize();
    expect(result!.charmZeroStrike).toBe(5810);
  });

  it('returns null when cumulative sum never crosses zero', async () => {
    queueAll({
      cone: [{ cone_lower: 5700, cone_upper: 5900 }],
      gammaSlot: [{ captured_at: null }],
      gammaRows: [],
      charmSlot: [{ captured_at: null }],
      charmRows: [],
      charmZeroSlot: [{ captured_at: '2026-05-08T13:30:00Z' }],
      charmZeroRows: [
        { strike: 5780, value: 1 },
        { strike: 5800, value: 2 },
        { strike: 5820, value: 3 },
      ],
    });
    const result = await callSynthesize();
    expect(result!.charmZeroStrike).toBeNull();
  });

  it('returns null when no charm-zero slot exists', async () => {
    queueAll({
      cone: [{ cone_lower: 5700, cone_upper: 5900 }],
      gammaSlot: [{ captured_at: null }],
      gammaRows: [],
      charmSlot: [{ captured_at: null }],
      charmRows: [],
      charmZeroSlot: [{ captured_at: null }],
      charmZeroRows: [],
    });
    const result = await callSynthesize();
    expect(result!.charmZeroStrike).toBeNull();
  });

  it('returns null when charm-zero slot exists but has no in-window rows', async () => {
    queueAll({
      cone: [{ cone_lower: 5700, cone_upper: 5900 }],
      gammaSlot: [{ captured_at: null }],
      gammaRows: [],
      charmSlot: [{ captured_at: null }],
      charmRows: [],
      charmZeroSlot: [{ captured_at: '2026-05-08T13:30:00Z' }],
      charmZeroRows: [],
    });
    const result = await callSynthesize();
    expect(result!.charmZeroStrike).toBeNull();
  });
});
