// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Sequenced result-row mock (the repo's plain getDb idiom — cf. build-features.test.ts):
// each `await sql\`...\`` in the handler consumes the next mockResolvedValueOnce in
// the same order the queries fire. extractLabelsForDate fires up to three reads
// (reviews → outcomes → flow_data); upsertLabels fires one INSERT.
const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

const captureException = vi.fn();
vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: (e: unknown) => captureException(e) },
}));

const warn = vi.fn();
vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: (...a: unknown[]) => warn(...a),
    error: vi.fn(),
  },
}));

import {
  extractLabelsForDate,
  upsertLabels,
} from '../_lib/build-features-labels.js';
import type { FeatureRow } from '../_lib/build-features-types.js';

const DATE = '2026-03-24'; // a Tuesday (EDT)

// 10:30 AM EDT = 14:30 UTC — lands on the t2 (630 ET) flow-agreement checkpoint
// findNearestCandle compares against (within TOLERANCE_MINUTES of 630).
const FLOW_TS_1030_ET = '2026-03-24T14:30:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockResolvedValue([]);
});

describe('extractLabelsForDate', () => {
  it('returns null when no review analysis exists for the date', async () => {
    mockSql.mockResolvedValueOnce([]); // reviews: none
    const out = await extractLabelsForDate(DATE);
    expect(out).toBeNull();
  });

  it('captures to Sentry, warns, and returns null on malformed full_response JSON', async () => {
    // full_response is a string that JSON.parse will throw on → catch branch.
    mockSql.mockResolvedValueOnce([
      { id: 42, full_response: '{not valid json' },
    ]);
    const out = await extractLabelsForDate(DATE);
    expect(out).toBeNull();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    // The warn payload carries the date for triage.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ date: DATE }),
      'Failed to parse review full_response',
    );
  });

  it('extracts review/chartConfidence labels when outcomes are absent', async () => {
    const fullResponse = {
      structure: 'IRON_CONDOR',
      confidence: 'HIGH',
      suggestedDelta: 0.15,
      review: { wasCorrect: true },
      chartConfidence: {
        periscopeCharm: { signal: 'CONTRADICTS' },
        netCharm: { signal: 'BULLISH' },
        spxNetFlow: { signal: 'BEARISH' },
        marketTide: { signal: 'NEUTRAL' },
        spyNetFlow: { signal: 'BULLISH' },
        aggregateGex: { signal: 'POSITIVE' },
      },
    };
    mockSql.mockResolvedValueOnce([{ id: 7, full_response: fullResponse }]); // reviews
    mockSql.mockResolvedValueOnce([]); // outcomes: none

    const out = await extractLabelsForDate(DATE);
    expect(out).not.toBeNull();
    const l = out as FeatureRow;
    expect(l.date).toBe(DATE);
    expect(l.analysis_id).toBe(7);
    expect(l.structure_correct).toBe(true);
    expect(l.recommended_structure).toBe('IRON_CONDOR');
    expect(l.confidence).toBe('HIGH');
    expect(l.suggested_delta).toBe(0.15);
    expect(l.charm_diverged).toBe(true);
    expect(l.naive_charm_signal).toBe('BULLISH');
    expect(l.spx_flow_signal).toBe('BEARISH');
    expect(l.market_tide_signal).toBe('NEUTRAL');
    expect(l.spy_flow_signal).toBe('BULLISH');
    expect(l.gex_signal).toBe('POSITIVE');
    // No outcomes → derived labels stay unset.
    expect(l.settlement_direction).toBeUndefined();
    expect(l.range_category).toBeUndefined();
    expect(l.flow_was_directional).toBeUndefined();
    // 6 of 9 completeness keys present (the three derived ones are null/absent).
    expect(l.label_completeness).toBe(Math.round((6 / 9) * 100) / 100); // 0.67
  });

  it('parses a JSON-string full_response (non-object path)', async () => {
    const fullResponse = JSON.stringify({
      structure: 'PUT_SPREAD',
      review: { wasCorrect: false },
      chartConfidence: {},
    });
    mockSql.mockResolvedValueOnce([{ id: 9, full_response: fullResponse }]); // reviews
    mockSql.mockResolvedValueOnce([]); // outcomes: none
    const out = await extractLabelsForDate(DATE);
    expect(out).not.toBeNull();
    expect((out as FeatureRow).recommended_structure).toBe('PUT_SPREAD');
    expect((out as FeatureRow).structure_correct).toBe(false);
    // charm_diverged: signal !== 'CONTRADICTS' → `false || null` → null.
    expect((out as FeatureRow).charm_diverged).toBeNull();
  });

  it('derives UP settlement, range category, and bullish flow agreement', async () => {
    mockSql.mockResolvedValueOnce([
      { id: 1, full_response: { review: {}, chartConfidence: {} } },
    ]); // reviews
    mockSql.mockResolvedValueOnce([
      {
        settlement: '5000',
        day_open: '4950',
        day_high: '5010',
        day_low: '4940',
        day_range_pts: '70', // 60..100 → WIDE
      },
    ]); // outcomes
    mockSql.mockResolvedValueOnce([
      // Bullish (ncp > 0) flow at the 630 ET checkpoint from an agreement source.
      { timestamp: FLOW_TS_1030_ET, source: 'market_tide', ncp: '1.5' },
    ]); // flow_data

    const out = await extractLabelsForDate(DATE);
    const l = out as FeatureRow;
    expect(l.settlement_direction).toBe('UP'); // 5000 > 4950
    expect(l.range_category).toBe('WIDE'); // 70 pts
    // bullishCount(1) > bearishCount(0) → flowDirection 'UP' === settlement 'UP'.
    expect(l.flow_was_directional).toBe(true);
  });

  it('derives DOWN settlement and bearish flow that disagrees with settlement', async () => {
    mockSql.mockResolvedValueOnce([
      { id: 2, full_response: { review: {}, chartConfidence: {} } },
    ]); // reviews
    mockSql.mockResolvedValueOnce([
      {
        settlement: '4900',
        day_open: '5000',
        day_high: '5005',
        day_low: '4880',
        day_range_pts: '25', // < 30 → NARROW
      },
    ]); // outcomes
    mockSql.mockResolvedValueOnce([
      // Bearish flow (ncp < 0) while settlement is DOWN → they AGREE → true.
      { timestamp: FLOW_TS_1030_ET, source: 'spx_flow', ncp: '-2.0' },
    ]); // flow_data

    const l = (await extractLabelsForDate(DATE)) as FeatureRow;
    expect(l.settlement_direction).toBe('DOWN');
    expect(l.range_category).toBe('NARROW');
    // bearishCount(1) > bullishCount(0) → 'DOWN' === settlement 'DOWN'.
    expect(l.flow_was_directional).toBe(true);
  });

  it('FLAT settlement and NORMAL/EXTREME range buckets', async () => {
    mockSql.mockResolvedValueOnce([
      { id: 3, full_response: { review: {}, chartConfidence: {} } },
    ]); // reviews
    mockSql.mockResolvedValueOnce([
      {
        settlement: '5000',
        day_open: '5000', // equal → FLAT
        day_high: '5200',
        day_low: '4900',
        day_range_pts: '150', // >= 100 → EXTREME
      },
    ]); // outcomes
    mockSql.mockResolvedValueOnce([]); // flow_data: none

    const l = (await extractLabelsForDate(DATE)) as FeatureRow;
    expect(l.settlement_direction).toBe('FLAT');
    expect(l.range_category).toBe('EXTREME');
  });

  it('NORMAL range bucket boundary (30 <= pts < 60)', async () => {
    mockSql.mockResolvedValueOnce([
      { id: 4, full_response: { review: {}, chartConfidence: {} } },
    ]); // reviews
    mockSql.mockResolvedValueOnce([
      {
        settlement: '5010',
        day_open: '5000',
        day_high: '5020',
        day_low: '4990',
        day_range_pts: '45', // 30..60 → NORMAL
      },
    ]); // outcomes
    mockSql.mockResolvedValueOnce([]); // flow_data: none

    const l = (await extractLabelsForDate(DATE)) as FeatureRow;
    expect(l.range_category).toBe('NORMAL');
  });

  it('flow tie (no agreement source resolves) leaves flow_was_directional null', async () => {
    mockSql.mockResolvedValueOnce([
      { id: 5, full_response: { review: {}, chartConfidence: {} } },
    ]); // reviews
    mockSql.mockResolvedValueOnce([
      {
        settlement: '5005',
        day_open: '5000',
        day_high: '5010',
        day_low: '4990',
        day_range_pts: '20',
      },
    ]); // outcomes
    mockSql.mockResolvedValueOnce([
      // Wrong source name → not in AGREEMENT_SOURCES filter → no candle.
      {
        timestamp: FLOW_TS_1030_ET,
        source: 'not_an_agreement_source',
        ncp: '3',
      },
      // Agreement source but ncp null → `ncp == null` continue branch (line 115).
      { timestamp: FLOW_TS_1030_ET, source: 'spy_flow', ncp: null },
      // Agreement source with ncp exactly 0 → neither bullish nor bearish
      // (covers the implicit no-op branch of the ncp>0 / ncp<0 conditional).
      { timestamp: FLOW_TS_1030_ET, source: 'qqq_etf_tide', ncp: '0' },
      // Agreement source but timestamp far from 630 ET → findNearestCandle null
      // (line 112 `if (!candle) continue`).
      { timestamp: '2026-03-24T18:00:00.000Z', source: 'qqq_flow', ncp: '5' },
    ]); // flow_data

    const l = (await extractLabelsForDate(DATE)) as FeatureRow;
    // bullishCount == bearishCount == 0 → flowDirection null → label null.
    expect(l.flow_was_directional).toBeNull();
  });
});

describe('upsertLabels', () => {
  it('issues a single INSERT ... ON CONFLICT against day_labels', async () => {
    mockSql.mockResolvedValueOnce([]);
    const labels: FeatureRow = {
      date: DATE,
      analysis_id: 1,
      structure_correct: true,
      recommended_structure: 'IRON_CONDOR',
      confidence: 'HIGH',
      suggested_delta: 0.15,
      charm_diverged: null,
      naive_charm_signal: 'BULLISH',
      spx_flow_signal: 'BEARISH',
      market_tide_signal: 'NEUTRAL',
      spy_flow_signal: 'BULLISH',
      gex_signal: 'POSITIVE',
      flow_was_directional: true,
      settlement_direction: 'UP',
      range_category: 'WIDE',
      label_completeness: 0.89,
    };
    await upsertLabels(labels);
    expect(mockSql).toHaveBeenCalledTimes(1);
    // Tagged-template first arg is the strings array; assert the target table +
    // conflict clause are present in the emitted SQL.
    const strings = mockSql.mock.calls[0]![0] as TemplateStringsArray;
    const sqlText = strings.join('');
    expect(sqlText).toContain('INSERT INTO day_labels');
    expect(sqlText).toContain('ON CONFLICT (date) DO UPDATE SET');
    // The interpolated values are passed positionally after the strings array.
    const values = mockSql.mock.calls[0]!.slice(1);
    expect(values).toContain(DATE);
    expect(values).toContain('IRON_CONDOR');
  });
});
