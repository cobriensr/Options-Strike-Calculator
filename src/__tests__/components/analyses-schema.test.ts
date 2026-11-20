import { describe, it, expect } from 'vitest';
import {
  analysesResponseSchema,
  datesResponseSchema,
} from '../../components/ChartAnalysis/analyses-schema';

/** A stored analysis as /api/analyses sends it, every block present. */
function fullAnalysis() {
  const signal = { signal: 'BULLISH', confidence: 'HIGH', note: 'n' };
  const step = {
    timing: '10:00',
    condition: 'c',
    sizePercent: 40,
    delta: 8,
    structure: 'IRON CONDOR',
    note: 'n',
  };
  return {
    mode: 'entry',
    structure: 'IRON CONDOR',
    confidence: 'HIGH',
    suggestedDelta: 8,
    reasoning: 'r',
    chartConfidence: { marketTide: signal, deltaPressure: signal },
    observations: ['o'],
    strikeGuidance: {
      putStrikeNote: 'p',
      callStrikeNote: 'c',
      straddleCone: { upper: 6700, lower: 6600, priceRelation: 'inside' },
      adjustments: ['a'],
    },
    managementRules: {
      profitTarget: 't',
      stopConditions: ['s'],
      timeRules: 'tr',
      flowReversalSignal: 'f',
    },
    entryPlan: {
      entry1: step,
      entry2: step,
      entry3: null,
      maxTotalSize: '100%',
      noEntryConditions: ['x'],
    },
    directionalOpportunity: {
      direction: 'LONG CALL',
      confidence: 'HIGH',
      reasoning: 'r',
      entryTiming: 't',
      stopLoss: 's',
      profitTarget: 'p',
      keyLevels: { support: '1', resistance: '2', vwap: '3' },
      signals: ['s'],
    },
    risks: ['r'],
    hedge: {
      recommendation: 'NO HEDGE',
      description: 'd',
      rationale: 'r',
      estimatedCost: 'N/A',
    },
    periscopeNotes: 'p',
    pressureAnalysis: 'p',
    structureRationale: 'sr',
    review: {
      wasCorrect: true,
      whatWorked: 'w',
      whatMissed: 'm',
      optimalTrade: 'o',
      lessonsLearned: ['l'],
    },
    imageIssues: [{ imageIndex: 1, label: 'l', issue: 'i', suggestion: 's' }],
  };
}

function entryWith(analysis: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    entryTime: '10:00 AM',
    mode: 'entry',
    structure: 'IRON CONDOR',
    confidence: 'HIGH',
    suggestedDelta: 8,
    spx: 6650,
    vix: 18.5,
    vix1d: 15,
    hedge: 'NO HEDGE',
    analysis,
    createdAt: '2026-03-17T15:00:00Z',
    ...overrides,
  };
}

describe('analysesResponseSchema', () => {
  it('accepts a stored analysis with every block present, unchanged', () => {
    const body = { analyses: [entryWith(fullAnalysis())] };

    const parsed = analysesResponseSchema.safeParse(body);

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(body);
  });

  it('accepts a SIT OUT: null delta, null blocks, nullable columns', () => {
    const analysis = {
      mode: 'entry',
      structure: 'SIT OUT',
      confidence: 'LOW',
      suggestedDelta: null,
      observations: [],
      risks: [],
      chartConfidence: null,
      strikeGuidance: null,
      managementRules: null,
      entryPlan: null,
      directionalOpportunity: null,
      hedge: null,
      periscopeNotes: null,
      pressureAnalysis: null,
      review: null,
      imageIssues: null,
    };

    const parsed = analysesResponseSchema.safeParse({
      analyses: [
        entryWith(analysis, {
          suggestedDelta: null,
          spx: null,
          vix: null,
          vix1d: null,
          hedge: null,
        }),
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts an empty day', () => {
    expect(analysesResponseSchema.safeParse({ analyses: [] }).success).toBe(
      true,
    );
  });

  it('fills the arrays the result view dereferences when a stored row lacks them', () => {
    const analysis = {
      ...fullAnalysis(),
      observations: undefined,
      risks: undefined,
      directionalOpportunity: {
        ...fullAnalysis().directionalOpportunity,
        keyLevels: undefined,
        signals: undefined,
      },
      review: { wasCorrect: false, lessonsLearned: undefined },
    };

    const parsed = analysesResponseSchema.safeParse({
      analyses: [entryWith(analysis)],
    });

    expect(parsed.success).toBe(true);
    const row = parsed.data?.analyses[0]?.analysis;
    expect(row?.observations).toEqual([]);
    expect(row?.risks).toEqual([]);
    expect(row?.directionalOpportunity?.keyLevels).toEqual({});
    expect(row?.directionalOpportunity?.signals).toEqual([]);
    expect(row?.review?.lessonsLearned).toEqual([]);
  });

  it('drops fields no component reads', () => {
    const parsed = analysesResponseSchema.safeParse({
      analyses: [
        entryWith({ ...fullAnalysis(), futureField: 1 }, { extra: 'x' }),
      ],
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.analyses[0]).not.toHaveProperty('extra');
    expect(parsed.data?.analyses[0]?.analysis).not.toHaveProperty(
      'futureField',
    );
  });

  // Each of these would throw during render if it reached state.
  it.each([
    ['analyses is a string', { analyses: 'x' }],
    ['analyses is missing', {}],
    ['the body is null', null],
    ['an entry is null', { analyses: [null] }],
    ['an entry lacks its fields', { analyses: [{ id: 1 }] }],
    [
      'an entry has an unknown mode',
      { analyses: [entryWith({}, { mode: 'x' })] },
    ],
    ['an entry has no analysis', { analyses: [entryWith(undefined)] }],
    [
      'observations is a string',
      { analyses: [entryWith({ ...fullAnalysis(), observations: 'x' })] },
    ],
    [
      'risks holds a number',
      { analyses: [entryWith({ ...fullAnalysis(), risks: [1] })] },
    ],
    [
      'the analysis mode is unknown',
      { analyses: [entryWith({ ...fullAnalysis(), mode: 'weekly' })] },
    ],
    [
      'a chart signal is a string',
      {
        analyses: [
          entryWith({
            ...fullAnalysis(),
            chartConfidence: { marketTide: 'BULLISH' },
          }),
        ],
      },
    ],
    [
      'the entry plan is a string',
      { analyses: [entryWith({ ...fullAnalysis(), entryPlan: 'x' })] },
    ],
    [
      'the review lessons are a string',
      {
        analyses: [
          entryWith({
            ...fullAnalysis(),
            review: { wasCorrect: true, lessonsLearned: 'x' },
          }),
        ],
      },
    ],
    [
      'the structure is an object',
      { analyses: [entryWith(fullAnalysis(), { structure: {} })] },
    ],
  ])('rejects the reply when %s', (_label, body) => {
    expect(analysesResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe('datesResponseSchema', () => {
  it('accepts a list of dates and an empty list', () => {
    const dates = [
      { date: '2026-03-17', total: 3, entries: 1, middays: 1, reviews: 1 },
    ];

    expect(datesResponseSchema.safeParse({ dates }).data).toEqual({ dates });
    expect(datesResponseSchema.safeParse({ dates: [] }).success).toBe(true);
  });

  it.each([
    ['dates is a string', { dates: 'x' }],
    ['dates is missing', {}],
    ['the body is null', null],
    ['an entry is null', { dates: [null] }],
    ['an entry lacks its counts', { dates: [{ date: '2026-03-17' }] }],
    [
      'a count is a string',
      {
        dates: [
          {
            date: '2026-03-17',
            total: '3',
            entries: 1,
            middays: 1,
            reviews: 1,
          },
        ],
      },
    ],
  ])('rejects the reply when %s', (_label, body) => {
    expect(datesResponseSchema.safeParse(body).success).toBe(false);
  });
});
