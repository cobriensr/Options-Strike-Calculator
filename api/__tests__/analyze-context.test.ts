// @vitest-environment node

import { describe, it, expect } from 'vitest';

/**
 * Tests for pure helper functions exported from analyze-context.ts.
 * These functions have no external dependencies — no mocks needed.
 *
 * The main buildAnalysisContext is integration-heavy and tested
 * indirectly through analyze.test.ts. These tests cover the pure
 * utilities: numOrUndef and formatMlFindingsForClaude.
 */

import { numOrUndef } from '../_lib/analyze-context.js';

// ── numOrUndef ─────────────────────────────────────────────

describe('numOrUndef', () => {
  it('returns the number for finite numbers', () => {
    expect(numOrUndef(42)).toBe(42);
    expect(numOrUndef(0)).toBe(0);
    expect(numOrUndef(-3.14)).toBe(-3.14);
    expect(numOrUndef(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('returns undefined for NaN', () => {
    expect(numOrUndef(NaN)).toBeUndefined();
  });

  it('returns undefined for Infinity', () => {
    expect(numOrUndef(Infinity)).toBeUndefined();
    expect(numOrUndef(-Infinity)).toBeUndefined();
  });

  it('returns undefined for non-number types', () => {
    expect(numOrUndef('42')).toBeUndefined();
    expect(numOrUndef(null)).toBeUndefined();
    expect(numOrUndef(undefined)).toBeUndefined();
    expect(numOrUndef(true)).toBeUndefined();
    expect(numOrUndef({})).toBeUndefined();
    expect(numOrUndef([])).toBeUndefined();
  });
});

// ── formatMlFindingsForClaude ──────────────────────────────
// This is a private function — we test it via a re-export trick.
// Since it's not exported, we test it indirectly by importing the module
// and using the function through buildAnalysisContext's DB fetch path.
// However, since we want to test it directly, we'll test the behavior
// through the module's internal wiring by providing crafted mock data
// to buildAnalysisContext.
//
// Actually — formatMlFindingsForClaude is NOT exported, so we need to
// test its behavior indirectly. We can test the crash scenario by
// validating that the function handles undefined dataset gracefully
// via the buildAnalysisContext integration path. But to keep tests
// focused, we'll use a dynamic import workaround.

// Since formatMlFindingsForClaude is private, we can only test it
// indirectly through buildAnalysisContext. The key coverage targets are:
// - Valid findings with all fields → formatted output
// - Missing dataset → runtime error (the known bug)
// - Missing top_correctness_predictors → graceful skip
//
// We test these via buildAnalysisContext with mocked DB responses.

// We need to import buildAnalysisContext with mocks for its deps.
// This is done in a separate describe block with vi.mock calls.

import { vi, beforeEach } from 'vitest';

// ── Mocks for buildAnalysisContext (to reach formatMlFindingsForClaude) ──

const mockSql = Object.assign(vi.fn(), {
  begin: vi.fn(),
});

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  getLatestPositions: vi.fn().mockResolvedValue(null),
  getPreviousRecommendation: vi.fn().mockResolvedValue(null),
  getFlowData: vi.fn().mockResolvedValue([]),
  formatFlowDataForClaude: vi.fn().mockReturnValue(null),
  getGreekExposure: vi.fn().mockResolvedValue([]),
  formatGreekExposureForClaude: vi.fn().mockReturnValue(null),
  getSpotExposures: vi.fn().mockResolvedValue([]),
  formatSpotExposuresForClaude: vi.fn().mockReturnValue(null),
}));

vi.mock('../_lib/db-strike-helpers.js', () => ({
  getStrikeExposures: vi.fn().mockResolvedValue([]),
  formatStrikeExposuresForClaude: vi.fn().mockReturnValue(null),
  getAllExpiryStrikeExposures: vi.fn().mockResolvedValue([]),
  formatAllExpiryStrikesForClaude: vi.fn().mockReturnValue(null),
  formatGreekFlowForClaude: vi.fn().mockReturnValue(null),
}));

vi.mock('../_lib/db-oi-change.js', () => ({
  getOiChangeData: vi.fn().mockResolvedValue([]),
  formatOiChangeForClaude: vi.fn().mockReturnValue(null),
}));

vi.mock('../_lib/spx-candles.js', () => ({
  fetchSPXCandles: vi
    .fn()
    .mockResolvedValue({ candles: [], previousClose: null }),
  formatSPXCandlesForClaude: vi.fn().mockReturnValue(null),
}));

vi.mock('../_lib/darkpool.js', () => ({
  fetchDarkPoolBlocks: vi.fn().mockResolvedValue([]),
  clusterDarkPoolTrades: vi.fn().mockReturnValue([]),
  formatDarkPoolForClaude: vi.fn().mockReturnValue(null),
}));

vi.mock('../_lib/max-pain.js', () => ({
  fetchMaxPain: vi.fn().mockResolvedValue([]),
  formatMaxPainForClaude: vi.fn().mockReturnValue(null),
}));

vi.mock('../_lib/lessons.js', () => ({
  getActiveLessons: vi.fn().mockResolvedValue([]),
  formatLessonsBlock: vi.fn().mockReturnValue(''),
  getHistoricalWinRate: vi.fn().mockResolvedValue(null),
  formatWinRateForClaude: vi.fn().mockReturnValue(''),
}));

vi.mock('../_lib/overnight-gap.js', () => ({
  formatOvernightForClaude: vi.fn().mockReturnValue(null),
}));

vi.mock('../iv-term-structure.js', () => ({
  formatIvTermStructureForClaude: vi.fn().mockReturnValue(null),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  schwabFetch: vi.fn().mockResolvedValue({ ok: false, status: 401 }),
}));

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../_lib/logger.js', () => ({ default: mockLogger }));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: {
    request: vi.fn(() => vi.fn()),
    schwabCall: vi.fn(() => vi.fn()),
    rateLimited: vi.fn(),
    tokenRefresh: vi.fn(),
    analyzeCall: vi.fn(),
    dbSave: vi.fn(),
    cacheResult: vi.fn(),
    increment: vi.fn(),
  },
}));

import { buildAnalysisContext } from '../_lib/analyze-context.js';

describe('formatMlFindingsForClaude (via buildAnalysisContext)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
    // Reset mockSql to return empty by default
    mockSql.mockReset();
    mockSql.mockResolvedValue([]);
    // Restore global fetch mock
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve(''),
      }),
    );
  });

  it('includes ML calibration context when findings have valid dataset', async () => {
    const validFindings = {
      dataset: {
        total_days: 39,
        labeled_days: 36,
        date_range: ['2026-02-09', '2026-04-03'],
        overall_accuracy: 0.917,
      },
      structure_accuracy: {
        'PUT CREDIT SPREAD': { correct: 13, total: 13, rate: 1.0 },
        'CALL CREDIT SPREAD': { correct: 17, total: 19, rate: 0.895 },
      },
      confidence_calibration: {
        HIGH: { correct: 22, total: 23, rate: 0.957 },
        MODERATE: { correct: 10, total: 12, rate: 0.833 },
      },
      flow_reliability: {
        'Market Tide': { correct: 22, total: 36, rate: 0.611 },
      },
      majority_baseline: {
        structure: 'CALL CREDIT SPREAD',
        rate: 0.528,
      },
      top_correctness_predictors: [
        { feature: 'gamma_asymmetry', r: -0.997, p: 0.0 },
        { feature: 'spy_ncp_t2', r: -0.573, p: 0.0 },
      ],
    };

    // mockSql is called multiple times in buildAnalysisContext:
    // 1. vol_realized query
    // 2. pre_market_data query
    // 3. ml_findings query
    mockSql
      .mockResolvedValueOnce([]) // vol_realized
      .mockResolvedValueOnce([]) // pre_market_data
      .mockResolvedValueOnce([
        {
          findings: validFindings,
          updated_at: new Date('2026-04-04T09:37:49Z'),
        },
      ]); // ml_findings

    const result = await buildAnalysisContext([], {
      mode: 'entry',
      spx: 5700,
      selectedDate: '2026-04-04',
    });

    // The context text should contain the ML calibration section
    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('ML Calibration'),
    );
    expect(textBlock).toBeDefined();
    const text = (textBlock as { type: 'text'; text: string }).text;

    // Check key output elements
    expect(text).toContain('Overall accuracy: 91.7%');
    expect(text).toContain('Structure accuracy:');
    expect(text).toContain('PUT CREDIT SPREAD: 13/13 (100%)');
    expect(text).toContain('CALL CREDIT SPREAD: 17/19 (90%)');
    expect(text).toContain('Confidence calibration:');
    expect(text).toContain('HIGH: 22/23 (96%)');
    expect(text).toContain('Flow source accuracy');
    expect(text).toContain('Market Tide: 22/36 (61%)');
    expect(text).toContain('Previous-day baseline');
    expect(text).toContain('Top correctness predictors:');
    expect(text).toContain('gamma_asymmetry');
    expect(text).toContain('higher = LESS correct');
    vi.unstubAllGlobals();
  });

  it('includes positive r direction label for positive predictor', async () => {
    const findings = {
      dataset: {
        total_days: 10,
        labeled_days: 8,
        date_range: ['2026-01-01', '2026-01-10'],
        overall_accuracy: 0.8,
      },
      structure_accuracy: {},
      confidence_calibration: {},
      flow_reliability: {},
      majority_baseline: { structure: 'IC', rate: 0.5 },
      top_correctness_predictors: [{ feature: 'delta_flow', r: 0.264, p: 0.1 }],
    };

    mockSql
      .mockResolvedValueOnce([]) // vol_realized
      .mockResolvedValueOnce([]) // pre_market_data
      .mockResolvedValueOnce([
        { findings, updated_at: new Date('2026-01-10') },
      ]);

    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-01-10',
    });

    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('ML Calibration'),
    );
    expect(textBlock).toBeDefined();
    const text = (textBlock as { type: 'text'; text: string }).text;
    expect(text).toContain('higher = MORE correct');
    vi.unstubAllGlobals();
  });

  it('omits top predictors section when not present', async () => {
    const findings = {
      dataset: {
        total_days: 10,
        labeled_days: 8,
        date_range: ['2026-01-01', '2026-01-10'],
        overall_accuracy: 0.8,
      },
      structure_accuracy: {},
      confidence_calibration: {},
      flow_reliability: {},
      majority_baseline: { structure: 'IC', rate: 0.5 },
      // no top_correctness_predictors
    };

    mockSql
      .mockResolvedValueOnce([]) // vol_realized
      .mockResolvedValueOnce([]) // pre_market_data
      .mockResolvedValueOnce([
        { findings, updated_at: new Date('2026-01-10') },
      ]);

    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-01-10',
    });

    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('ML Calibration'),
    );
    expect(textBlock).toBeDefined();
    const text = (textBlock as { type: 'text'; text: string }).text;
    expect(text).not.toContain('Top correctness predictors');
    vi.unstubAllGlobals();
  });

  it('handles ML findings fetch failure gracefully', async () => {
    mockSql
      .mockResolvedValueOnce([]) // vol_realized
      .mockResolvedValueOnce([]) // pre_market_data
      .mockRejectedValueOnce(new Error('DB connection lost')); // ml_findings

    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-01-10',
    });

    // Should complete without crashing
    expect(result.content.length).toBeGreaterThan(0);
    // Should NOT have ML calibration section
    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('ML Calibration'),
    );
    expect(textBlock).toBeUndefined();
    // Should have logged the warning
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('ML findings fetch failed'),
    );
    vi.unstubAllGlobals();
  });

  it('handles empty ML findings rows', async () => {
    mockSql
      .mockResolvedValueOnce([]) // vol_realized
      .mockResolvedValueOnce([]) // pre_market_data
      .mockResolvedValueOnce([]); // ml_findings — empty

    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-01-10',
    });

    // Should NOT have ML calibration section
    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('ML Calibration'),
    );
    expect(textBlock).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('limits top predictors to 5', async () => {
    const findings = {
      dataset: {
        total_days: 10,
        labeled_days: 8,
        date_range: ['2026-01-01', '2026-01-10'],
        overall_accuracy: 0.8,
      },
      structure_accuracy: {},
      confidence_calibration: {},
      flow_reliability: {},
      majority_baseline: { structure: 'IC', rate: 0.5 },
      top_correctness_predictors: Array.from({ length: 10 }, (_, i) => ({
        feature: `feat_${i}`,
        r: -0.5 + i * 0.1,
        p: 0.01,
      })),
    };

    mockSql
      .mockResolvedValueOnce([]) // vol_realized
      .mockResolvedValueOnce([]) // pre_market_data
      .mockResolvedValueOnce([
        { findings, updated_at: new Date('2026-01-10') },
      ]);

    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-01-10',
    });

    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('ML Calibration'),
    );
    const text = (textBlock as { type: 'text'; text: string }).text;

    // Should show first 5 features only
    expect(text).toContain('feat_0');
    expect(text).toContain('feat_4');
    expect(text).not.toContain('feat_5');
    vi.unstubAllGlobals();
  });
});

// ── buildAnalysisContext mode / image handling ───────────────

describe('buildAnalysisContext', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
    mockSql.mockReset();
    mockSql.mockResolvedValue([]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve(''),
      }),
    );
  });

  it('includes image blocks with labels', async () => {
    const result = await buildAnalysisContext(
      [
        {
          data: 'base64data1',
          mediaType: 'image/png',
          label: 'Market Tide',
        },
        {
          data: 'base64data2',
          mediaType: 'image/jpeg',
        },
      ],
      { mode: 'entry', selectedDate: '2026-04-04' },
    );

    // Should have 2 image labels + 2 image blocks + final text
    const textBlocks = result.content.filter((b) => b.type === 'text');
    const imageBlocks = result.content.filter((b) => b.type === 'image');

    expect(imageBlocks).toHaveLength(2);
    expect(textBlocks[0]).toMatchObject({
      type: 'text',
      text: '[Image 1: Market Tide]',
    });
    expect(textBlocks[1]).toMatchObject({
      type: 'text',
      text: '[Image 2: Unlabeled]',
    });
    vi.unstubAllGlobals();
  });

  it('defaults to entry mode when not specified', async () => {
    const result = await buildAnalysisContext([], {
      selectedDate: '2026-04-04',
    });

    expect(result.mode).toBe('entry');
    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('PRE-TRADE ENTRY'),
    );
    expect(textBlock).toBeDefined();
    vi.unstubAllGlobals();
  });

  it('sets midday mode correctly', async () => {
    const result = await buildAnalysisContext([], {
      mode: 'midday',
      selectedDate: '2026-04-04',
    });

    expect(result.mode).toBe('midday');
    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('MID-DAY RE-ANALYSIS'),
    );
    expect(textBlock).toBeDefined();
    vi.unstubAllGlobals();
  });

  it('sets review mode correctly', async () => {
    const result = await buildAnalysisContext([], {
      mode: 'review',
      selectedDate: '2026-04-04',
    });

    expect(result.mode).toBe('review');
    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('END-OF-DAY REVIEW'),
    );
    expect(textBlock).toBeDefined();
    vi.unstubAllGlobals();
  });

  it('populates unavailable data manifest when nothing is fetched', async () => {
    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-04',
    });

    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('Data Sources Unavailable'),
    );
    expect(textBlock).toBeDefined();
    const text = (textBlock as { type: 'text'; text: string }).text;
    expect(text).toContain('SPX Net Flow');
    expect(text).toContain('Dark Pool Blocks');
    expect(text).toContain('Max Pain');
    vi.unstubAllGlobals();
  });

  it('returns empty lessonsBlock when lessons fetch fails', async () => {
    const { getActiveLessons } = await import('../_lib/lessons.js');
    vi.mocked(getActiveLessons).mockRejectedValueOnce(
      new Error('lessons DB down'),
    );

    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-04',
    });

    expect(result.lessonsBlock).toBe('');
    vi.unstubAllGlobals();
  });

  it('returns null darkPoolClusters when no dark pool data', async () => {
    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-04',
    });

    expect(result.darkPoolClusters).toBeNull();
    vi.unstubAllGlobals();
  });
});
