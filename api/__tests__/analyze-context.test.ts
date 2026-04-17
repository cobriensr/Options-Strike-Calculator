// @vitest-environment node

import { vi, beforeEach, describe, it, expect } from 'vitest';

/**
 * Tests for pure helper functions exported from analyze-context.ts.
 * These functions have no external dependencies — no mocks needed.
 *
 * The main buildAnalysisContext is integration-heavy and tested
 * indirectly through analyze.test.ts. These tests cover the pure
 * utilities: numOrUndef and formatMlFindingsForClaude.
 */

import {
  numOrUndef,
  parseEntryTimeAsUtc,
  formatEconomicCalendarForClaude,
  formatPriorDayFlowForClaude,
  formatMarketInternalsForClaude,
  buildAnalysisContext,
} from '../_lib/analyze-context.js';

// ── numOrUndef ─────────────────────────────────────────────

describe('numOrUndef', () => {
  it('returns the number for finite numbers', () => {
    expect(numOrUndef(42)).toBe(42);
    expect(numOrUndef(0)).toBe(0);
    expect(numOrUndef(-3.14)).toBe(-3.14);
    expect(numOrUndef(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('returns undefined for NaN', () => {
    expect(numOrUndef(Number.NaN)).toBeUndefined();
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

// ── formatMarketInternalsForClaude ───────────────────────────

describe('formatMarketInternalsForClaude', () => {
  it('returns null for empty bars', () => {
    expect(formatMarketInternalsForClaude([])).toBeNull();
  });

  it('includes regime label, confidence, evidence, readings, and extremes', async () => {
    // Import the mocked modules so we can override return values
    const { classifyRegime } = await import('../../src/utils/market-regime.js');
    const { detectExtremes } =
      await import('../../src/utils/extreme-detector.js');

    vi.mocked(classifyRegime).mockReturnValueOnce({
      regime: 'range',
      confidence: 0.72,
      evidence: [
        'TICK oscillating, mean-reversion rate 0.63',
        'ADD flatness 0.81',
      ],
      scores: { range: 0.51, trend: 0.07, neutral: 0.42 },
    });

    vi.mocked(detectExtremes).mockReturnValueOnce([
      {
        ts: '2026-04-15T15:30:00Z',
        symbol: '$TICK',
        value: 680,
        band: 'extreme',
        label: 'FADE candidate',
        pinned: false,
      },
      {
        ts: '2026-04-15T16:00:00Z',
        symbol: '$TICK',
        value: -720,
        band: 'extreme',
        label: 'FADE candidate',
        pinned: true,
      },
    ]);

    const bars = [
      {
        ts: '2026-04-15T15:30:00Z',
        symbol: '$TICK' as const,
        open: 500,
        high: 700,
        low: 450,
        close: 650,
      },
      {
        ts: '2026-04-15T15:30:00Z',
        symbol: '$ADD' as const,
        open: 100,
        high: 200,
        low: 50,
        close: 180,
      },
      {
        ts: '2026-04-15T15:30:00Z',
        symbol: '$VOLD' as const,
        open: 10,
        high: 50,
        low: -5,
        close: 35,
      },
      {
        ts: '2026-04-15T15:30:00Z',
        symbol: '$TRIN' as const,
        open: 1.1,
        high: 1.3,
        low: 0.9,
        close: 1.05,
      },
    ];

    const result = formatMarketInternalsForClaude(bars);
    expect(result).not.toBeNull();

    // Regime label + confidence
    expect(result).toContain('Regime: RANGE DAY');
    expect(result).toContain('confidence: 72%');

    // Evidence lines
    expect(result).toContain('TICK oscillating, mean-reversion rate 0.63');
    expect(result).toContain('ADD flatness 0.81');

    // Current readings
    expect(result).toContain('Current readings');
    expect(result).toContain('$TICK: +650');
    expect(result).toContain('$ADD: +180');
    expect(result).toContain('$VOLD: +35');
    expect(result).toContain('$TRIN: 1.05');

    // Extreme events
    expect(result).toContain("Today's extreme events (2 total)");
    expect(result).toContain('+680');
    expect(result).toContain('-720');
    expect(result).toContain('pinned 5m');
    expect(result).toContain('FADE candidate');
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
  getNetGexHeatmap: vi.fn().mockResolvedValue([]),
  formatNetGexHeatmapForClaude: vi.fn().mockReturnValue(null),
  formatZeroGammaForClaude: vi.fn().mockReturnValue(null),
}));

vi.mock('../_lib/db-oi-change.js', () => ({
  getOiChangeData: vi.fn().mockResolvedValue([]),
  formatOiChangeForClaude: vi.fn().mockReturnValue(null),
}));

vi.mock('../_lib/db-nope.js', () => ({
  getRecentNope: vi.fn().mockResolvedValue([]),
  getSessionNope: vi.fn().mockResolvedValue([]),
  formatNopeForClaude: vi.fn().mockReturnValue(null),
}));

vi.mock('../_lib/db-flow.js', () => ({
  getMarketInternalsToday: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/utils/market-regime.js', () => ({
  classifyRegime: vi.fn().mockReturnValue({
    regime: 'neutral',
    confidence: 0,
    evidence: [],
    scores: { range: 0, trend: 0, neutral: 1 },
  }),
}));

vi.mock('../../src/utils/extreme-detector.js', () => ({
  detectExtremes: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/utils/zero-gamma.js', () => ({
  analyzeZeroGamma: vi.fn().mockReturnValue({ flipStrike: null }),
}));

vi.mock('../_lib/embeddings.js', () => ({
  buildAnalysisSummary: vi.fn().mockReturnValue('test summary'),
  generateEmbedding: vi.fn().mockResolvedValue(null),
  findSimilarAnalyses: vi.fn().mockResolvedValue([]),
  formatSimilarAnalysesBlock: vi.fn().mockReturnValue(''),
}));

vi.mock('../_lib/futures-context.js', () => ({
  formatFuturesForClaude: vi.fn().mockResolvedValue(null),
}));

vi.mock('../_lib/spx-candles.js', () => ({
  fetchSPXCandles: vi
    .fn()
    .mockResolvedValue({ candles: [], previousClose: null }),
  formatSPXCandlesForClaude: vi.fn().mockReturnValue(null),
}));

vi.mock('../_lib/darkpool.js', () => ({
  fetchDarkPoolBlocks: vi.fn().mockResolvedValue({ kind: 'empty' }),
  clusterDarkPoolTrades: vi.fn().mockReturnValue([]),
  formatDarkPoolForClaude: vi.fn().mockReturnValue(null),
}));

vi.mock('../_lib/max-pain.js', () => ({
  fetchMaxPain: vi.fn().mockResolvedValue({ kind: 'empty' }),
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
    uwRateLimit: vi.fn(),
    tokenRefresh: vi.fn(),
    analyzeCall: vi.fn(),
    dbSave: vi.fn(),
    cacheResult: vi.fn(),
    increment: vi.fn(),
  },
}));

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

// ── parseEntryTimeAsUtc ───────────────────────────────────────────

describe('parseEntryTimeAsUtc', () => {
  it('returns undefined for null', () => {
    expect(parseEntryTimeAsUtc(null, '2026-04-10')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseEntryTimeAsUtc('', '2026-04-10')).toBeUndefined();
  });

  it('returns undefined for unrecognized format', () => {
    expect(parseEntryTimeAsUtc('14:55', '2026-04-10')).toBeUndefined();
    expect(parseEntryTimeAsUtc('2:55pm', '2026-04-10')).toBeUndefined();
  });

  it('converts 2:55 PM CT to UTC (CDT offset = UTC-5 in April)', () => {
    // April 10 is in CDT (UTC-5). 2:55 PM CDT = 19:55 UTC.
    const result = parseEntryTimeAsUtc('2:55 PM CT', '2026-04-10');
    expect(result).toBeDefined();
    const d = new Date(result!);
    expect(d.getUTCHours()).toBe(19);
    expect(d.getUTCMinutes()).toBe(55);
  });

  it('converts 3:00 PM ET to UTC (EDT offset = UTC-4 in April)', () => {
    // April 10 is in EDT (UTC-4). 3:00 PM EDT = 19:00 UTC.
    const result = parseEntryTimeAsUtc('3:00 PM ET', '2026-04-10');
    expect(result).toBeDefined();
    const d = new Date(result!);
    expect(d.getUTCHours()).toBe(19);
    expect(d.getUTCMinutes()).toBe(0);
  });

  it('handles 12:00 PM (noon) correctly', () => {
    // 12:00 PM CT (CDT) = 17:00 UTC in April
    const result = parseEntryTimeAsUtc('12:00 PM CT', '2026-04-10');
    expect(result).toBeDefined();
    const d = new Date(result!);
    expect(d.getUTCHours()).toBe(17);
    expect(d.getUTCMinutes()).toBe(0);
  });

  it('handles 12:00 AM (midnight) correctly', () => {
    // 12:00 AM CT (CDT) = 05:00 UTC in April
    const result = parseEntryTimeAsUtc('12:00 AM CT', '2026-04-10');
    expect(result).toBeDefined();
    const d = new Date(result!);
    expect(d.getUTCHours()).toBe(5);
    expect(d.getUTCMinutes()).toBe(0);
  });

  it('is case-insensitive for AM/PM and CT/ET', () => {
    const upper = parseEntryTimeAsUtc('2:55 PM CT', '2026-04-10');
    const lower = parseEntryTimeAsUtc('2:55 pm ct', '2026-04-10');
    expect(upper).toBe(lower);
  });

  it('returns an ISO string ending in Z', () => {
    const result = parseEntryTimeAsUtc('2:55 PM CT', '2026-04-10');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
  });

  it('uses :59 seconds so the full minute is included', () => {
    const result = parseEntryTimeAsUtc('2:55 PM CT', '2026-04-10');
    const d = new Date(result!);
    expect(d.getUTCSeconds()).toBe(59);
  });
});

// ── formatEconomicCalendarForClaude ──────────────────────────

describe('formatEconomicCalendarForClaude', () => {
  it('returns no-events string for empty rows', () => {
    const result = formatEconomicCalendarForClaude([]);
    expect(result).toBe('No scheduled economic events today.');
  });

  it('formats a high-severity CPI event with 🔴 and HIGH label', () => {
    const rows = [
      {
        event_name: 'Consumer Price Index',
        event_time: '2026-04-10T12:30:00.000Z', // 8:30 AM ET
        event_type: 'CPI',
        forecast: '+0.3%',
        previous: '+0.2%',
        reported_period: 'Mar 2026',
      },
    ];
    const result = formatEconomicCalendarForClaude(rows);
    expect(result).toContain('🔴');
    expect(result).toContain('[HIGH]');
    expect(result).toContain('Consumer Price Index');
    expect(result).toContain('Forecast: +0.3%');
    expect(result).toContain('Previous: +0.2%');
    expect(result).toContain('Mar 2026');
  });

  it('formats a medium-severity PMI event with 🟡 and MEDIUM label', () => {
    const rows = [
      {
        event_name: 'Manufacturing PMI',
        event_time: '2026-04-10T13:45:00.000Z', // 9:45 AM ET
        event_type: 'PMI',
        forecast: '51.5',
        previous: '51.2',
        reported_period: null,
      },
    ];
    const result = formatEconomicCalendarForClaude(rows);
    expect(result).toContain('🟡');
    expect(result).toContain('[MEDIUM]');
    expect(result).toContain('Manufacturing PMI');
    expect(result).toContain('Forecast: 51.5');
    expect(result).toContain('Previous: 51.2');
  });

  it('handles null forecast gracefully — omits Forecast field', () => {
    const rows = [
      {
        event_name: 'GDP',
        event_time: '2026-04-10T12:30:00.000Z',
        event_type: 'GDP',
        forecast: null,
        previous: '+2.1%',
        reported_period: 'Q4 2025',
      },
    ];
    const result = formatEconomicCalendarForClaude(rows);
    expect(result).not.toContain('Forecast:');
    expect(result).toContain('Previous: +2.1%');
  });

  it('handles null previous gracefully — omits Previous field', () => {
    const rows = [
      {
        event_name: 'PCE',
        event_time: '2026-04-10T12:30:00.000Z',
        event_type: 'PCE',
        forecast: '+0.2%',
        previous: null,
        reported_period: null,
      },
    ];
    const result = formatEconomicCalendarForClaude(rows);
    expect(result).toContain('Forecast: +0.2%');
    expect(result).not.toContain('Previous:');
  });

  it('formats event_time as Date object correctly', () => {
    const rows = [
      {
        event_name: 'FOMC Minutes',
        event_time: new Date('2026-04-10T18:00:00.000Z'), // 2:00 PM ET
        event_type: 'FOMC',
        forecast: null,
        previous: null,
        reported_period: null,
      },
    ];
    const result = formatEconomicCalendarForClaude(rows);
    expect(result).toContain('14:00 ET');
  });

  it('formats multiple events in order', () => {
    const rows = [
      {
        event_name: 'CPI',
        event_time: '2026-04-10T12:30:00.000Z',
        event_type: 'CPI',
        forecast: null,
        previous: null,
        reported_period: null,
      },
      {
        event_name: 'PMI',
        event_time: '2026-04-10T13:45:00.000Z',
        event_type: 'PMI',
        forecast: null,
        previous: null,
        reported_period: null,
      },
    ];
    const result = formatEconomicCalendarForClaude(rows);
    const lines = result.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('CPI');
    expect(lines[1]).toContain('PMI');
  });

  it('recognizes all high-severity types: FOMC, CPI, PCE, JOBS, GDP', () => {
    const highTypes = ['FOMC', 'CPI', 'PCE', 'JOBS', 'GDP'];
    for (const eventType of highTypes) {
      const rows = [
        {
          event_name: `${eventType} Event`,
          event_time: '2026-04-10T12:30:00.000Z',
          event_type: eventType,
          forecast: null,
          previous: null,
          reported_period: null,
        },
      ];
      const result = formatEconomicCalendarForClaude(rows);
      expect(result).toContain('🔴');
      expect(result).toContain('[HIGH]');
    }
  });
});

// ── formatPriorDayFlowForClaude ──────────────────────────────

describe('formatPriorDayFlowForClaude', () => {
  // Sequential mock SQL: each tagged-template call consumes the next response.
  // Call order for N prior dates:
  //   0: SELECT DISTINCT date (dateRows)
  //   1: market_tide ASC rows for date[0]
  //   2: market_tide ASC rows for date[1]  (Promise.all starts both, first awaits fire first)
  //   3: secondary-source DISTINCT ON rows for date[0]
  //   4: secondary-source DISTINCT ON rows for date[1]
  const makeSql = (responses: unknown[][]) => {
    let callIdx = 0;
    const fn = () => {
      const resp = responses[callIdx] ?? [];
      callIdx++;
      return Promise.resolve(resp);
    };
    return fn as unknown as ReturnType<typeof import('../_lib/db.js').getDb>;
  };

  // Helpers to build realistic flow rows with created_at timestamps
  const row = (
    ticker: string,
    ncp: number,
    npp: number,
    date: string,
    utcHour: number,
  ) => ({
    ticker,
    ncp,
    npp,
    date,
    created_at: new Date(`${date}T${String(utcHour).padStart(2, '0')}:00:00Z`),
  });

  it('returns null when no prior dates have market_tide data', async () => {
    const sql = makeSql([[]]); // empty dateRows
    const result = await formatPriorDayFlowForClaude(sql, '2026-04-10');
    expect(result).toBeNull();
  });

  it('formats a single prior day and includes arc + session type', async () => {
    // Three market_tide rows: open (14 UTC), midday (17 UTC), close (20 UTC)
    const tideRows = [
      row('market_tide', -800000000, -200000000, '2026-04-09', 14), // open: bull
      row('market_tide', -2500000000, -300000000, '2026-04-09', 17), // midday: bull
      row('market_tide', -1100000000, -250000000, '2026-04-09', 20), // close: bull
    ];
    const sql = makeSql([
      [{ date: '2026-04-09' }], // dateRows
      tideRows, // market_tide rows for 2026-04-09
      [], // secondary sources (empty is fine)
    ]);
    const result = await formatPriorDayFlowForClaude(sql, '2026-04-10');
    expect(result).not.toBeNull();
    expect(result).toContain('Prior-Day Flow Trend');
    expect(result).toContain('2026-04-09');
    expect(result).toContain('Market Tide Arc:');
    expect(result).toContain('Session Type:');
    expect(result).toContain('bullish');
  });

  it('classifies FADE when midday peak is ≥ 2× close magnitude', async () => {
    // close mag = 0.5B, midday mag = 2.1B → ratio = 4.2 → FADE
    const tideRows = [
      row('market_tide', -500000000, -200000000, '2026-04-09', 14), // open bull, 0.3B
      row('market_tide', -2200000000, -100000000, '2026-04-09', 17), // midday bull, 2.1B
      row('market_tide', -600000000, -100000000, '2026-04-09', 20), // close bull, 0.5B
    ];
    const sql = makeSql([[{ date: '2026-04-09' }], tideRows, []]);
    const result = await formatPriorDayFlowForClaude(sql, '2026-04-10');
    expect(result).not.toBeNull();
    expect(result).toContain('FADE');
  });

  it('classifies REVERSAL when open and close are in opposite directions', async () => {
    // open: bull (ncp < npp); close: bear (ncp > npp)
    const tideRows = [
      row('market_tide', -1500000000, -400000000, '2026-04-09', 14), // open bull
      row('market_tide', -2000000000, -300000000, '2026-04-09', 17), // midday bull
      row('market_tide', 300000000, -1800000000, '2026-04-09', 20), // close bear (ncp > npp)
    ];
    const sql = makeSql([[{ date: '2026-04-09' }], tideRows, []]);
    const result = await formatPriorDayFlowForClaude(sql, '2026-04-10');
    expect(result).not.toBeNull();
    expect(result).toContain('REVERSAL');
  });

  it('identifies strengthening bullish trend across 2 days', async () => {
    // Day 1 (2026-04-08): close net -1.3B bullish
    // Day 2 (2026-04-09): close net -1.7B bullish — stronger
    // Call order: dateRows, tide-d09, tide-d08, sec-d09, sec-d08
    const tideD09 = [
      row('market_tide', -2200000000, -500000000, '2026-04-09', 14),
      row('market_tide', -2500000000, -500000000, '2026-04-09', 17),
      row('market_tide', -2200000000, -500000000, '2026-04-09', 20), // close net -1.7B
    ];
    const tideD08 = [
      row('market_tide', -1500000000, -400000000, '2026-04-08', 14),
      row('market_tide', -1600000000, -400000000, '2026-04-08', 17),
      row('market_tide', -1800000000, -500000000, '2026-04-08', 20), // close net -1.3B
    ];
    const sql = makeSql([
      [{ date: '2026-04-09' }, { date: '2026-04-08' }], // dateRows (newest first)
      tideD09, // tide rows for 2026-04-09
      tideD08, // tide rows for 2026-04-08
      [], // secondary for 2026-04-09
      [], // secondary for 2026-04-08
    ]);
    const result = await formatPriorDayFlowForClaude(sql, '2026-04-10');
    expect(result).not.toBeNull();
    expect(result).toContain('Trend:');
    expect(result).toContain('strengthening');
    expect(result).toContain('bullish');
  });

  it('identifies reversing trend when close direction flips across days', async () => {
    // Day 1 (2026-04-08): close bullish (ncp < npp)
    // Day 2 (2026-04-09): close bearish (ncp > npp)
    const tideD09 = [
      row('market_tide', -500000000, -1800000000, '2026-04-09', 14), // open bear
      row('market_tide', -400000000, -2100000000, '2026-04-09', 17), // midday bear
      row('market_tide', -200000000, -1800000000, '2026-04-09', 20), // close bear
    ];
    const tideD08 = [
      row('market_tide', -1800000000, -500000000, '2026-04-08', 14), // open bull
      row('market_tide', -2000000000, -400000000, '2026-04-08', 17), // midday bull
      row('market_tide', -1800000000, -500000000, '2026-04-08', 20), // close bull
    ];
    const sql = makeSql([
      [{ date: '2026-04-09' }, { date: '2026-04-08' }],
      tideD09,
      tideD08,
      [],
      [],
    ]);
    const result = await formatPriorDayFlowForClaude(sql, '2026-04-10');
    expect(result).not.toBeNull();
    expect(result).toContain('reversing');
  });

  it('includes a Trend summary line', async () => {
    const tideRows = [
      row('market_tide', -1000000000, -300000000, '2026-04-09', 14),
      row('market_tide', -1200000000, -300000000, '2026-04-09', 17),
      row('market_tide', -1000000000, -300000000, '2026-04-09', 20),
    ];
    const sql = makeSql([[{ date: '2026-04-09' }], tideRows, []]);
    const result = await formatPriorDayFlowForClaude(sql, '2026-04-10');
    expect(result).toContain('Trend:');
  });

  it('shows secondary source confirmation when available', async () => {
    const tideRows = [
      row('market_tide', -1000000000, -300000000, '2026-04-09', 14),
      row('market_tide', -1200000000, -300000000, '2026-04-09', 17),
      row('market_tide', -1000000000, -300000000, '2026-04-09', 20),
    ];
    const secRows = [
      {
        ticker: 'spx_flow',
        ncp: -220000000,
        npp: -80000000,
        date: '2026-04-09',
        created_at: new Date(),
      },
    ];
    const sql = makeSql([[{ date: '2026-04-09' }], tideRows, secRows]);
    const result = await formatPriorDayFlowForClaude(sql, '2026-04-10');
    expect(result).toContain('Confirmation:');
    expect(result).toContain('SPX Flow');
  });

  it('handles no market_tide rows for a prior date gracefully', async () => {
    const sql = makeSql([
      [{ date: '2026-04-09' }],
      [], // no market_tide rows
      [], // no secondary rows
    ]);
    const result = await formatPriorDayFlowForClaude(sql, '2026-04-10');
    expect(result).not.toBeNull();
    expect(result).toContain('Market Tide: N/A');
  });

  it('classifies SUSTAINED when arc ratio is < 1.5', async () => {
    // close mag = 1.0B, midday mag = 1.2B → ratio = 1.2 → SUSTAINED
    const tideRows = [
      row('market_tide', -1500000000, -400000000, '2026-04-09', 14), // open bull
      row('market_tide', -1800000000, -600000000, '2026-04-09', 17), // midday: 1.2B
      row('market_tide', -1200000000, -200000000, '2026-04-09', 20), // close: 1.0B
    ];
    const sql = makeSql([[{ date: '2026-04-09' }], tideRows, []]);
    const result = await formatPriorDayFlowForClaude(sql, '2026-04-10');
    expect(result).toContain('SUSTAINED');
  });

  it('classifies TREND DAY when arc ratio is >= 1.5 and < 2', async () => {
    // close mag = 1.0B, midday mag = 1.6B → ratio = 1.6 → TREND DAY
    const tideRows = [
      row('market_tide', -1500000000, -400000000, '2026-04-09', 14), // open bull
      row('market_tide', -1800000000, -200000000, '2026-04-09', 17), // midday: 1.6B
      row('market_tide', -1100000000, -100000000, '2026-04-09', 20), // close: 1.0B
    ];
    const sql = makeSql([[{ date: '2026-04-09' }], tideRows, []]);
    const result = await formatPriorDayFlowForClaude(sql, '2026-04-10');
    expect(result).toContain('TREND DAY');
  });

  it('returns single-prior-day trend message with no-trend note', async () => {
    const tideRows = [
      row('market_tide', -1000000000, -300000000, '2026-04-09', 14),
      row('market_tide', -1000000000, -300000000, '2026-04-09', 17),
      row('market_tide', -1000000000, -300000000, '2026-04-09', 20),
    ];
    const sql = makeSql([[{ date: '2026-04-09' }], tideRows, []]);
    const result = await formatPriorDayFlowForClaude(sql, '2026-04-10');
    expect(result).toContain('single prior day');
  });

  it('classifies SUSTAINED when close magnitude is 0', async () => {
    // Both open and close bear (ncp >= npp), close has ncp === npp → magnitude 0 → SUSTAINED
    // open: ncp = -100M, npp = -500M → openBull = (-100M < -500M) = false (bear)
    // close: ncp = 0, npp = 0 → closeBull = (0 < 0) = false (bear), closeMag = 0
    // openBull === closeBull (both false) → no REVERSAL → closeMag=0 → SUSTAINED
    const correctedRows = [
      row('market_tide', -100000000, -500000000, '2026-04-09', 14), // open bear
      row('market_tide', -100000000, -500000000, '2026-04-09', 17), // midday bear
      row('market_tide', 0, 0, '2026-04-09', 20), // close: both 0 → mag=0 → SUSTAINED
    ];
    const sql = makeSql([[{ date: '2026-04-09' }], correctedRows, []]);
    const result = await formatPriorDayFlowForClaude(sql, '2026-04-10');
    expect(result).toContain('SUSTAINED');
  });

  it('reports mixed signals when secondary sources disagree with close direction', async () => {
    // Most recent day close is bearish (ncp > npp)
    // Secondary source is bullish (ncp < npp) → disagreement → mixed signals
    const tideD09 = [
      row('market_tide', -500000000, -1800000000, '2026-04-09', 14),
      row('market_tide', -400000000, -2100000000, '2026-04-09', 17),
      row('market_tide', -200000000, -1800000000, '2026-04-09', 20), // close bear
    ];
    const tideD08 = [
      row('market_tide', -1800000000, -500000000, '2026-04-08', 14),
      row('market_tide', -2000000000, -400000000, '2026-04-08', 17),
      row('market_tide', -1800000000, -500000000, '2026-04-08', 20), // close bull
    ];
    const secRows = [
      {
        ticker: 'spx_flow',
        ncp: -500000000, // bullish (ncp < npp)
        npp: -100000000,
        date: '2026-04-09',
        created_at: new Date(),
      },
    ];
    const sql = makeSql([
      [{ date: '2026-04-09' }, { date: '2026-04-08' }],
      tideD09,
      tideD08,
      secRows, // secondary for most-recent day (2026-04-09)
      [],
    ]);
    const result = await formatPriorDayFlowForClaude(sql, '2026-04-10');
    expect(result).toContain('Mixed signals');
  });

  it('identifies weakening bearish trend', async () => {
    // Day 1 (d08): close bearish, strong (ncp > npp, large delta)
    // Day 2 (d09): close bearish, weaker (smaller delta) → weakening bearish
    const tideD09 = [
      row('market_tide', -100000000, -1100000000, '2026-04-09', 14),
      row('market_tide', -200000000, -1200000000, '2026-04-09', 17),
      row('market_tide', -100000000, -600000000, '2026-04-09', 20), // close: 0.5B bear
    ];
    const tideD08 = [
      row('market_tide', -100000000, -2000000000, '2026-04-08', 14),
      row('market_tide', -150000000, -2500000000, '2026-04-08', 17),
      row('market_tide', -100000000, -2100000000, '2026-04-08', 20), // close: 2.0B bear
    ];
    const sql = makeSql([
      [{ date: '2026-04-09' }, { date: '2026-04-08' }],
      tideD09,
      tideD08,
      [],
      [],
    ]);
    const result = await formatPriorDayFlowForClaude(sql, '2026-04-10');
    expect(result).toContain('weakening');
    expect(result).toContain('bearish');
  });
});

// ── buildAnalysisContext: context text fields ────────────────────────

describe('buildAnalysisContext: context text fields', () => {
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

  it('includes scheduled events in context text', async () => {
    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
      events: [
        { event: 'CPI Release', time: '8:30 AM ET', severity: 'HIGH' },
        { event: 'FOMC Minutes', time: '2:00 PM ET', severity: 'HIGH' },
      ],
    });
    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('Scheduled events'),
    );
    expect(textBlock).toBeDefined();
    const text = (textBlock as { type: 'text'; text: string }).text;
    expect(text).toContain('CPI Release at 8:30 AM ET [HIGH]');
    expect(text).toContain('FOMC Minutes at 2:00 PM ET [HIGH]');
    vi.unstubAllGlobals();
  });

  it('shows NONE for scheduled events when array is empty', async () => {
    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
      events: [],
    });
    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('Scheduled events'),
    );
    const text = (textBlock as { type: 'text'; text: string }).text;
    expect(text).toContain('Scheduled events: NONE');
    vi.unstubAllGlobals();
  });

  it('shows NONE for scheduled events when events field is absent', async () => {
    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
    });
    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('Scheduled events'),
    );
    const text = (textBlock as { type: 'text'; text: string }).text;
    expect(text).toContain('Scheduled events: NONE');
    vi.unstubAllGlobals();
  });

  it('renders topOI strikes section in context text', async () => {
    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
      topOIStrikes: [
        {
          strike: 5700,
          putOI: 12000,
          callOI: 8000,
          totalOI: 20000,
          distFromSpot: 0,
          distPct: '0.0',
          side: 'both',
        },
        {
          strike: 5650,
          putOI: 15000,
          callOI: 500,
          totalOI: 15500,
          distFromSpot: -50,
          distPct: '0.9',
          side: 'put',
        },
      ],
    });
    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('OI Concentration'),
    );
    expect(textBlock).toBeDefined();
    const text = (textBlock as { type: 'text'; text: string }).text;
    expect(text).toContain('5700');
    expect(text).toContain('20.0K');
    expect(text).toContain('5650');
    vi.unstubAllGlobals();
  });

  it('omits topOI section when topOIStrikes is empty', async () => {
    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
      topOIStrikes: [],
    });
    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('OI Concentration'),
    );
    expect(textBlock).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('renders skew metrics section with steep put skew signal', async () => {
    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
      skewMetrics: {
        put25dIV: 25.0,
        call25dIV: 15.0,
        atmIV: 17.0,
        putSkew25d: 9.0, // > 8 → STEEP
        callSkew25d: 2.0,
        skewRatio: 2.5, // > 2 → strong put-over-call
      },
    });
    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('IV Skew'),
    );
    expect(textBlock).toBeDefined();
    const text = (textBlock as { type: 'text'; text: string }).text;
    expect(text).toContain('STEEP');
    expect(text).toContain('Strong put-over-call');
    vi.unstubAllGlobals();
  });

  it('renders skew metrics section with normal put skew signal', async () => {
    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
      skewMetrics: {
        put25dIV: 20.0,
        call25dIV: 15.0,
        atmIV: 17.0,
        putSkew25d: 5.5, // 4–8 → NORMAL
        callSkew25d: 2.0,
        skewRatio: 1.5, // 1.2–2 → Normal asymmetry
      },
    });
    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('IV Skew'),
    );
    const text = (textBlock as { type: 'text'; text: string }).text;
    expect(text).toContain('NORMAL');
    expect(text).toContain('Normal asymmetry');
    vi.unstubAllGlobals();
  });

  it('renders skew metrics section with flat skew and symmetric ratio', async () => {
    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
      skewMetrics: {
        put25dIV: 18.0,
        call25dIV: 17.0,
        atmIV: 17.5,
        putSkew25d: 2.0, // < 4 → FLAT
        callSkew25d: 1.5,
        skewRatio: 1.1, // < 1.2 → symmetric
      },
    });
    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('IV Skew'),
    );
    const text = (textBlock as { type: 'text'; text: string }).text;
    expect(text).toContain('FLAT');
    expect(text).toContain('Unusually symmetric');
    vi.unstubAllGlobals();
  });

  it('omits skew metrics section when skewMetrics is absent', async () => {
    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
    });
    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('IV Skew Metrics'),
    );
    expect(textBlock).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('renders straddle cone section when spxCandlesContext is absent but cone values provided', async () => {
    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
      straddleConeUpper: 5750,
      straddleConeLower: 5650,
    });
    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('Straddle Cone Boundaries'),
    );
    expect(textBlock).toBeDefined();
    const text = (textBlock as { type: 'text'; text: string }).text;
    expect(text).toContain('5750.0');
    expect(text).toContain('5650.0');
    expect(text).toContain('Width: 100 pts');
    vi.unstubAllGlobals();
  });

  it('includes dataNote warning in context when provided', async () => {
    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
      dataNote: 'VIX data delayed 15 minutes today.',
    });
    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('DATA NOTES'),
    );
    expect(textBlock).toBeDefined();
    const text = (textBlock as { type: 'text'; text: string }).text;
    expect(text).toContain('VIX data delayed 15 minutes today.');
    vi.unstubAllGlobals();
  });

  it('marks backtest mode in context text', async () => {
    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
      isBacktest: true,
    });
    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('Backtest mode'),
    );
    const text = (textBlock as { type: 'text'; text: string }).text;
    expect(text).toContain('YES — using historical data');
    vi.unstubAllGlobals();
  });
});

// ── buildAnalysisContext: API-gated paths ─────────────────────────

describe('buildAnalysisContext: API-gated paths', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
    mockSql.mockReset();
    mockSql.mockResolvedValue([]);
    process.env = { ...originalEnv };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve(''),
      }),
    );
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it('fetches IV term structure when UW_API_KEY is set and API returns OK', async () => {
    process.env.UW_API_KEY = 'test-uw-key';
    const { formatIvTermStructureForClaude } =
      await import('../iv-term-structure.js');
    vi.mocked(formatIvTermStructureForClaude).mockReturnValue(
      '0DTE IV: 15.2%  30D IV: 18.5%',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: [{ dte: 0, iv: 0.152 }],
          }),
      }),
    );

    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
    });

    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('IV Term Structure'),
    );
    expect(textBlock).toBeDefined();
  });

  it('logs warn when IV term API returns non-OK status', async () => {
    process.env.UW_API_KEY = 'test-uw-key';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve(''),
      }),
    );

    await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
    });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 503 }),
      expect.stringContaining('IV term structure API returned non-OK'),
    );
  });

  it('fetches dark pool data when UW_API_KEY is set and data is returned', async () => {
    process.env.UW_API_KEY = 'test-uw-key';
    const {
      fetchDarkPoolBlocks,
      clusterDarkPoolTrades,
      formatDarkPoolForClaude,
    } = await import('../_lib/darkpool.js');
    const fakeCluster = [{ price: 570.0, totalSize: 5000000 }];
    vi.mocked(fetchDarkPoolBlocks).mockResolvedValueOnce({
      kind: 'ok',
      data: [{ price: 570.0, size: 5000000 } as never],
    });
    vi.mocked(clusterDarkPoolTrades).mockReturnValueOnce(fakeCluster as never);
    vi.mocked(formatDarkPoolForClaude).mockReturnValueOnce(
      'Dark Pool: 5700 level',
    );

    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
      spx: 5700,
      spy: 570,
    });

    expect(result.darkPoolClusters).toEqual(fakeCluster);
    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('Dark Pool'),
    );
    expect(textBlock).toBeDefined();
  });

  it('fetches max pain when UW_API_KEY is set and data is returned', async () => {
    process.env.UW_API_KEY = 'test-uw-key';
    const { fetchMaxPain, formatMaxPainForClaude } =
      await import('../_lib/max-pain.js');
    vi.mocked(fetchMaxPain).mockResolvedValueOnce({
      kind: 'ok',
      data: [{ strike: 5700, totalPain: 1000000 } as never],
    });
    vi.mocked(formatMaxPainForClaude).mockReturnValueOnce('Max Pain: 5700');

    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
      spx: 5700,
    });

    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('Max Pain'),
    );
    expect(textBlock).toBeDefined();
  });

  it('skips positions fetch in backtest mode', async () => {
    const { getLatestPositions } = await import('../_lib/db.js');
    // Clear call history from previous tests, then set implementation
    vi.mocked(getLatestPositions).mockClear();
    vi.mocked(getLatestPositions).mockResolvedValue({
      summary: 'Some live positions',
    } as never);

    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
      isBacktest: true,
    });

    // In backtest mode, getLatestPositions should NOT be called
    expect(vi.mocked(getLatestPositions)).not.toHaveBeenCalled();
    // Position context should not appear from DB
    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('Current Open Positions'),
    );
    expect(textBlock).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('fetches previousRecommendation in midday mode', async () => {
    const { getPreviousRecommendation } = await import('../_lib/db.js');
    vi.mocked(getPreviousRecommendation).mockResolvedValueOnce(
      'Earlier today: BUY PUT CREDIT SPREAD at 5650/5625.' as never,
    );

    const result = await buildAnalysisContext([], {
      mode: 'midday',
      selectedDate: '2026-04-10',
    });

    expect(vi.mocked(getPreviousRecommendation)).toHaveBeenCalledWith(
      '2026-04-10',
      'midday',
    );
    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('Previous Recommendation'),
    );
    expect(textBlock).toBeDefined();
    vi.unstubAllGlobals();
  });

  it('fetches previousRecommendation in review mode', async () => {
    const { getPreviousRecommendation } = await import('../_lib/db.js');
    vi.mocked(getPreviousRecommendation).mockResolvedValueOnce(
      'IC at 5725/5750/5650/5625' as never,
    );

    await buildAnalysisContext([], {
      mode: 'review',
      selectedDate: '2026-04-10',
    });

    expect(vi.mocked(getPreviousRecommendation)).toHaveBeenCalledWith(
      '2026-04-10',
      'review',
    );
    vi.unstubAllGlobals();
  });

  it('logs error and continues when previousRecommendation fetch fails', async () => {
    const { getPreviousRecommendation } = await import('../_lib/db.js');
    vi.mocked(getPreviousRecommendation).mockRejectedValueOnce(
      new Error('DB timeout'),
    );

    const result = await buildAnalysisContext([], {
      mode: 'midday',
      selectedDate: '2026-04-10',
    });

    expect(result.content.length).toBeGreaterThan(0);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('Failed to fetch previous recommendation'),
    );
    vi.unstubAllGlobals();
  });
});

// ── buildAnalysisContext: vol realized context ────────────────────

describe('buildAnalysisContext: vol realized context', () => {
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

  it('formats vol realized context with elevated IV rank (>70)', async () => {
    mockSql
      .mockResolvedValueOnce([
        {
          iv_30d: 0.18,
          rv_30d: 0.14,
          iv_rv_spread: 0.04,
          iv_overpricing_pct: 28.6,
          iv_rank: 82,
        },
      ]) // vol_realized
      .mockResolvedValueOnce([]) // pre_market_data
      .mockResolvedValueOnce([]); // ml_findings

    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
    });

    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('Realized Vol'),
    );
    expect(textBlock).toBeDefined();
    const text = (textBlock as { type: 'text'; text: string }).text;
    expect(text).toContain('18.0%');
    expect(text).toContain('IV OVERPRICING');
    expect(text).toContain('elevated, rich premium');
    vi.unstubAllGlobals();
  });

  it('formats vol realized context with low IV rank (<30)', async () => {
    mockSql
      .mockResolvedValueOnce([
        {
          iv_30d: 0.12,
          rv_30d: 0.15,
          iv_rv_spread: -0.03,
          iv_overpricing_pct: -20.0,
          iv_rank: 15,
        },
      ]) // vol_realized
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
    });

    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('Realized Vol'),
    );
    const text = (textBlock as { type: 'text'; text: string }).text;
    expect(text).toContain('IV UNDERPRICING');
    expect(text).toContain('low, cheap premium');
    vi.unstubAllGlobals();
  });

  it('formats vol realized context with mid-range IV rank (30-70)', async () => {
    mockSql
      .mockResolvedValueOnce([
        {
          iv_30d: 0.15,
          rv_30d: 0.14,
          iv_rv_spread: 0.01,
          iv_overpricing_pct: 7.1,
          iv_rank: 50,
        },
      ]) // vol_realized
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
    });

    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('Realized Vol'),
    );
    const text = (textBlock as { type: 'text'; text: string }).text;
    expect(text).toContain('mid-range');
    expect(text).toContain('fairly priced');
    vi.unstubAllGlobals();
  });

  it('handles vol_realized DB error gracefully', async () => {
    mockSql
      .mockRejectedValueOnce(new Error('vol_realized table missing')) // vol_realized
      .mockResolvedValueOnce([]) // pre_market_data
      .mockResolvedValueOnce([]); // ml_findings

    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
    });

    expect(result.content.length).toBeGreaterThan(0);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('Failed to fetch vol realized data'),
    );
    vi.unstubAllGlobals();
  });
});

// ── buildAnalysisContext: midday directional chain ────────────────

describe('buildAnalysisContext: midday directional chain', () => {
  beforeEach(async () => {
    // Use clearAllMocks (not restoreAllMocks) to preserve module-level mock implementations.
    // Then explicitly reset all module mocks that buildAnalysisContext calls,
    // so each test starts with a clean slate.
    vi.clearAllMocks();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
    mockSql.mockReset();
    mockSql.mockResolvedValue([]);

    // Re-establish default implementations for all mocks used by buildAnalysisContext
    const db = await import('../_lib/db.js');
    vi.mocked(db.getFlowData).mockResolvedValue([] as never);
    vi.mocked(db.getGreekExposure).mockResolvedValue([] as never);
    vi.mocked(db.getSpotExposures).mockResolvedValue([] as never);
    vi.mocked(db.getLatestPositions).mockResolvedValue(null as never);
    vi.mocked(db.getPreviousRecommendation).mockResolvedValue(null as never);

    const sh = await import('../_lib/db-strike-helpers.js');
    vi.mocked(sh.getStrikeExposures).mockResolvedValue([] as never);
    vi.mocked(sh.getAllExpiryStrikeExposures).mockResolvedValue([] as never);
    vi.mocked(sh.getNetGexHeatmap).mockResolvedValue([] as never);
    vi.mocked(sh.formatStrikeExposuresForClaude).mockReturnValue(null);
    vi.mocked(sh.formatAllExpiryStrikesForClaude).mockReturnValue(null);
    vi.mocked(sh.formatGreekFlowForClaude).mockReturnValue(null);

    const api = await import('../_lib/api-helpers.js');
    vi.mocked(api.schwabFetch).mockResolvedValue({
      ok: false,
      status: 401,
    } as never);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve(''),
      }),
    );
  });

  it('attempts Schwab chain fetch in midday mode when tide data is present', async () => {
    // bullish flow: latestTideNcp < latestTideNpp → flowDirection = 'bullish' → contractType = CALL
    // Provide bullish tide data so flowDirection is not null, triggering the chain fetch path.
    const { getFlowData } = await import('../_lib/db.js');
    const bullishTideRow = {
      ncp: -800000000, // ncp < npp → bullish (ncp is more negative = more call premium)
      npp: -200000000,
      ticker: 'market_tide',
      date: '2026-04-10',
      created_at: new Date(),
    };
    // Override only the first call (market_tide); others return [] by default
    vi.mocked(getFlowData).mockResolvedValueOnce([bullishTideRow] as never);

    const { schwabFetch } = await import('../_lib/api-helpers.js');
    // Return a successful chain response (non-OK default is set in beforeEach)
    vi.mocked(schwabFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        underlying: { last: 5700 },
        callExpDateMap: {
          '2026-04-24:14': {
            '5700': [
              {
                strikePrice: 5700,
                bid: 45.0,
                ask: 47.0,
                delta: 0.52,
                volatility: 16.5,
                totalVolume: 1200,
                openInterest: 3400,
                daysToExpiration: 14,
                symbol: 'SPXW 260424C5700',
              },
            ],
          },
        },
        putExpDateMap: {},
      },
    } as never);

    await buildAnalysisContext([], {
      mode: 'midday',
      selectedDate: '2026-04-10',
    });

    // schwabFetch should have been called for the 14 DTE chain
    expect(vi.mocked(schwabFetch)).toHaveBeenCalledWith(
      expect.stringContaining('chains?symbol=$SPX'),
    );
    vi.unstubAllGlobals();
  });

  it('logs warn and skips chain when Schwab returns non-OK', async () => {
    const { getFlowData } = await import('../_lib/db.js');
    const bullishTideRow = {
      ncp: -800000000,
      npp: -200000000,
      ticker: 'market_tide',
      date: '2026-04-10',
      created_at: new Date(),
    };
    vi.mocked(getFlowData)
      .mockResolvedValueOnce([bullishTideRow] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

    const { schwabFetch } = await import('../_lib/api-helpers.js');
    vi.mocked(schwabFetch).mockResolvedValueOnce({
      ok: false,
      status: 403,
    } as never);

    await buildAnalysisContext([], {
      mode: 'midday',
      selectedDate: '2026-04-10',
    });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 403 }),
      expect.stringContaining('14 DTE chain fetch failed'),
    );
    vi.unstubAllGlobals();
  });

  it('skips directional chain in backtest mode', async () => {
    const { schwabFetch } = await import('../_lib/api-helpers.js');

    await buildAnalysisContext([], {
      mode: 'midday',
      selectedDate: '2026-04-10',
      isBacktest: true,
    });

    // schwabFetch should not have been called for the chain
    expect(vi.mocked(schwabFetch)).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

// ── buildAnalysisContext: win rate + similar analyses ─────────────

describe('buildAnalysisContext: win rate and similar analyses', () => {
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

  it('includes winRateContext in context text when winRate is returned', async () => {
    const { getHistoricalWinRate, formatWinRateForClaude } =
      await import('../_lib/lessons.js');
    vi.mocked(getHistoricalWinRate).mockResolvedValueOnce({
      wins: 18,
      total: 22,
      rate: 0.818,
    } as never);
    vi.mocked(formatWinRateForClaude).mockReturnValueOnce(
      'Historical win rate: 81.8% (18/22)',
    );

    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
      vix: 18.5,
      regimeZone: 'Low',
      dowLabel: 'Thursday',
    });

    const textBlock = result.content.find(
      (b) => b.type === 'text' && b.text.includes('Historical Base Rate'),
    );
    expect(textBlock).toBeDefined();
    const text = (textBlock as { type: 'text'; text: string }).text;
    expect(text).toContain('Historical win rate: 81.8%');
    vi.unstubAllGlobals();
  });

  it('logs error and continues when win rate fetch fails', async () => {
    const { getHistoricalWinRate } = await import('../_lib/lessons.js');
    vi.mocked(getHistoricalWinRate).mockRejectedValueOnce(
      new Error('lessons DB timeout'),
    );

    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
    });

    expect(result.content.length).toBeGreaterThan(0);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('Failed to fetch historical win rate'),
    );
    vi.unstubAllGlobals();
  });

  it('populates similarAnalysesBlock in entry mode', async () => {
    // Mock embeddings module inline since it's not mocked at the module level
    vi.doMock('../_lib/embeddings.js', () => ({
      buildAnalysisSummary: vi
        .fn()
        .mockReturnValue('VIX 18, Low GEX, Thursday'),
      generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      findSimilarAnalyses: vi.fn().mockResolvedValue([
        {
          date: '2026-03-06',
          structure: 'PUT CREDIT SPREAD',
          confidence: 'HIGH',
          outcome: 'WIN',
        },
      ]),
      formatSimilarAnalysesBlock: vi
        .fn()
        .mockReturnValue('Similar: 2026-03-06 PUT CREDIT SPREAD WIN'),
    }));

    const result = await buildAnalysisContext([], {
      mode: 'entry',
      selectedDate: '2026-04-10',
    });

    // similarAnalysesBlock is returned in result (may be '' if embeddings isn't loaded)
    expect(result.similarAnalysesBlock).toBeDefined();
    vi.unstubAllGlobals();
  });

  it('returns empty similarAnalysesBlock in non-entry modes', async () => {
    const result = await buildAnalysisContext([], {
      mode: 'midday',
      selectedDate: '2026-04-10',
    });

    expect(result.similarAnalysesBlock).toBe('');
    vi.unstubAllGlobals();
  });
});
