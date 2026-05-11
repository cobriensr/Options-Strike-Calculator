// @vitest-environment node

/**
 * Unit tests for api/_lib/validation/snapshot.ts.
 *
 * Covers positionCsv, analyzeImage, analyzeBody, preMarketBody,
 * snapshotBody, and analysisResponse — plus boundary cases on the
 * size-bounded fields (1MB CSV, 5MB image, 1-2 images per analyze).
 *
 * Note: the response schema does NOT validate image byte sizes — those
 * are enforced upstream by analyzeImageSchema's `.max()` on `data`.
 */

import { describe, it, expect } from 'vitest';
import {
  positionCsvSchema,
  analyzeImageSchema,
  analyzeBodySchema,
  preMarketBodySchema,
  snapshotBodySchema,
  analysisResponseSchema,
} from '../../_lib/validation/snapshot.js';

const MB = 1024 * 1024;

// ── positionCsvSchema ────────────────────────────────────────

describe('positionCsvSchema', () => {
  it('parses valid input', () => {
    const result = positionCsvSchema.safeParse({
      csv: 'header1,header2\nval1,val2',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty CSV', () => {
    const result = positionCsvSchema.safeParse({ csv: '' });
    expect(result.success).toBe(false);
  });

  it('rejects CSV exceeding 1MB (boundary)', () => {
    const result = positionCsvSchema.safeParse({
      // 1MB = 1_024_000 bytes per the schema's MAX_CSV_BYTES.
      csv: 'x'.repeat(1_024_001),
    });
    expect(result.success).toBe(false);
  });

  it('accepts CSV exactly at the 1MB boundary', () => {
    const result = positionCsvSchema.safeParse({
      csv: 'x'.repeat(1_024_000),
    });
    expect(result.success).toBe(true);
  });
});

// ── analyzeImageSchema ───────────────────────────────────────

describe('analyzeImageSchema', () => {
  it('parses valid input', () => {
    const result = analyzeImageSchema.safeParse({
      data: 'YWJj',
      mediaType: 'image/png',
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional label', () => {
    const result = analyzeImageSchema.safeParse({
      data: 'YWJj',
      mediaType: 'image/jpeg',
      label: 'periscope',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown mediaType', () => {
    const result = analyzeImageSchema.safeParse({
      data: 'YWJj',
      mediaType: 'image/bmp',
    });
    expect(result.success).toBe(false);
  });

  it('rejects image > 5MB (boundary)', () => {
    const result = analyzeImageSchema.safeParse({
      data: 'x'.repeat(5 * MB + 1),
      mediaType: 'image/png',
    });
    expect(result.success).toBe(false);
  });

  it('accepts data exactly at the 5MB cap', () => {
    const result = analyzeImageSchema.safeParse({
      data: 'x'.repeat(5 * MB),
      mediaType: 'image/png',
    });
    expect(result.success).toBe(true);
  });
});

// ── analyzeBodySchema ────────────────────────────────────────

describe('analyzeBodySchema', () => {
  const baseImage = { data: 'YWJj', mediaType: 'image/png' as const };

  it('parses valid input (1 image)', () => {
    const result = analyzeBodySchema.safeParse({
      images: [baseImage],
      context: { foo: 'bar' },
    });
    expect(result.success).toBe(true);
  });

  it('parses valid input (2 images)', () => {
    const result = analyzeBodySchema.safeParse({
      images: [baseImage, baseImage],
      context: {},
    });
    expect(result.success).toBe(true);
  });

  it('rejects zero images (boundary)', () => {
    const result = analyzeBodySchema.safeParse({
      images: [],
      context: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 2 images (boundary)', () => {
    const result = analyzeBodySchema.safeParse({
      images: [baseImage, baseImage, baseImage],
      context: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing context', () => {
    const result = analyzeBodySchema.safeParse({ images: [baseImage] });
    expect(result.success).toBe(false);
  });
});

// ── preMarketBodySchema ──────────────────────────────────────

describe('preMarketBodySchema', () => {
  it('parses valid input', () => {
    const result = preMarketBodySchema.safeParse({
      date: '2026-05-10',
      globexHigh: 5950.0,
      globexLow: 5920.0,
      globexClose: 5935.0,
    });
    expect(result.success).toBe(true);
  });

  it('accepts all optional nullable fields set', () => {
    const result = preMarketBodySchema.safeParse({
      date: '2026-05-10',
      globexHigh: 5950,
      globexLow: 5920,
      globexClose: 5935,
      globexVwap: 5932,
      straddleConeUpper: 5960,
      straddleConeLower: 5910,
      savedAt: '2026-05-10T08:25:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects malformed date', () => {
    const result = preMarketBodySchema.safeParse({
      date: '05/10/2026',
      globexHigh: 5950,
      globexLow: 5920,
      globexClose: 5935,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing required globex price', () => {
    const result = preMarketBodySchema.safeParse({
      date: '2026-05-10',
      globexHigh: 5950,
      globexLow: 5920,
    });
    expect(result.success).toBe(false);
  });
});

// ── snapshotBodySchema ───────────────────────────────────────

describe('snapshotBodySchema', () => {
  it('parses minimal valid input (date + entryTime + everything else null/missing)', () => {
    const result = snapshotBodySchema.safeParse({
      date: '2026-05-10',
      entryTime: '09:30',
    });
    expect(result.success).toBe(true);
  });

  it('accepts mixed null + undefined + actual values across helpers', () => {
    const result = snapshotBodySchema.safeParse({
      date: '2026-05-10',
      entryTime: '09:30',
      spx: 5935.0,
      vix: null,
      regimeZone: 'NEUTRAL',
      isEarlyClose: false,
      strikes: {
        '5': { put: 5800, call: 6000, putPct: -2.3, callPct: 1.1 },
      },
      eventNames: ['CPI'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing required date', () => {
    const result = snapshotBodySchema.safeParse({ entryTime: '09:30' });
    expect(result.success).toBe(false);
  });

  it('rejects malformed strikes record entry', () => {
    const result = snapshotBodySchema.safeParse({
      date: '2026-05-10',
      entryTime: '09:30',
      strikes: {
        '5': { put: 5800, call: 6000, putPct: -2.3 },
        // missing callPct → schema rejects
      },
    });
    expect(result.success).toBe(false);
  });
});

// ── analysisResponseSchema ───────────────────────────────────

describe('analysisResponseSchema', () => {
  const chartEntry = {
    signal: 'neutral',
    confidence: 'MODERATE' as const,
    note: 'ok',
  };

  const baseResponse = {
    mode: 'entry' as const,
    structure: 'IRON CONDOR' as const,
    confidence: 'MODERATE' as const,
    suggestedDelta: 10,
    reasoning: 'reasoning',
    chartConfidence: {
      marketTide: chartEntry,
      spxNetFlow: chartEntry,
      spyNetFlow: chartEntry,
      qqqNetFlow: chartEntry,
      periscope: chartEntry,
      netCharm: chartEntry,
      aggregateGex: chartEntry,
      periscopeCharm: chartEntry,
      darkPool: chartEntry,
      ivTermStructure: chartEntry,
      spxCandles: chartEntry,
      overnightGap: chartEntry,
      vannaExposure: chartEntry,
      pinRisk: chartEntry,
      skew: chartEntry,
      futuresContext: chartEntry,
      nopeSignal: chartEntry,
      deltaFlow: chartEntry,
      zeroGamma: chartEntry,
      netGexHeatmap: chartEntry,
      marketInternals: chartEntry,
    },
    observations: ['obs1'],
    strikeGuidance: null,
    managementRules: null,
    entryPlan: null,
    risks: ['r1'],
    hedge: null,
    periscopeNotes: null,
    structureRationale: 'rationale',
    review: null,
    imageIssues: [],
  };

  it('parses minimal valid response', () => {
    const result = analysisResponseSchema.safeParse(baseResponse);
    expect(result.success).toBe(true);
  });

  it('rejects unknown structure enum value', () => {
    const result = analysisResponseSchema.safeParse({
      ...baseResponse,
      structure: 'BUTTERFLY',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing chartConfidence field', () => {
    const partialChartConfidence = { ...baseResponse.chartConfidence };
    // Delete a required key to verify schema enforcement.
    delete (partialChartConfidence as Record<string, unknown>).marketTide;
    const result = analysisResponseSchema.safeParse({
      ...baseResponse,
      chartConfidence: partialChartConfidence,
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid hedge.recommendation enum', () => {
    const result = analysisResponseSchema.safeParse({
      ...baseResponse,
      hedge: {
        recommendation: 'FULL HEDGE',
        description: 'd',
        rationale: 'r',
        estimatedCost: '$10',
      },
    });
    expect(result.success).toBe(false);
  });

  it('parses a fully populated response with all optional subtrees present', () => {
    const entryStepFixture = {
      timing: '09:35',
      condition: 'OR holds',
      sizePercent: 33,
      delta: 10,
      structure: 'IRON CONDOR',
      note: 'first tranche',
    };
    const populatedResponse = {
      ...baseResponse,
      chartConfidence: {
        ...baseResponse.chartConfidence,
        deltaPressure: chartEntry,
        charmPressure: chartEntry,
      },
      strikeGuidance: {
        putStrikeNote: 'short put at 5870',
        callStrikeNote: 'short call at 5970',
        straddleCone: {
          upper: 5960,
          lower: 5880,
          priceRelation: 'inside cone',
        },
        adjustments: ['widen on +1σ break'],
      },
      managementRules: {
        profitTarget: '50% of credit',
        stopConditions: ['short delta > 25', 'OR breach against side'],
        timeRules: 'flat by 14:45 CT',
        flowReversalSignal: 'aggregate GEX flip',
      },
      entryPlan: {
        entry1: entryStepFixture,
        entry2: entryStepFixture,
        entry3: null,
        maxTotalSize: '2 contracts per side',
        noEntryConditions: ['VIX > 25', 'cone breach pre-9:45'],
      },
      directionalOpportunity: {
        direction: 'LONG CALL' as const,
        confidence: 'MODERATE' as const,
        reasoning: '+γ floor at 5900 holds',
        entryTiming: 'on retest of 5905',
        stopLoss: 'below 5895',
        profitTarget: '5945',
        keyLevels: {
          support: '5900',
          resistance: '5945',
          vwap: '5915',
        },
        signals: ['delta flow positive', 'spy net flow accelerating'],
      },
      hedge: {
        recommendation: 'PROTECTIVE LONG' as const,
        description: 'buy 1 long put 5860',
        rationale: 'tail risk below cone',
        estimatedCost: '$45',
      },
      review: {
        wasCorrect: true,
        whatWorked: 'cone held all session',
        whatMissed: 'could have widened on 11:00 flip',
        optimalTrade: 'IC at 9:35 entry',
        lessonsLearned: ['trust +γ floor', 'fade midday liquidity gap'],
        recommendationChain: {
          entry: {
            time: '09:35',
            structure: 'IRON CONDOR' as const,
            verdict: 'CORRECT' as const,
            rationale: 'inside cone, +γ regime',
          },
          midday: {
            time: '12:00',
            structure: 'IRON CONDOR' as const,
            verdict: 'CORRECT' as const,
            rationale: 'still inside cone',
          },
        },
      },
      periscopeNotes: 'green +γ wall at 5900',
      pressureAnalysis: 'short-dated dealer charm pinning to 5920',
      structureRationale: 'inside cone + +γ regime favors short premium',
    };
    const result = analysisResponseSchema.safeParse(populatedResponse);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.chartConfidence.deltaPressure).toBeDefined();
      expect(result.data.chartConfidence.charmPressure).toBeDefined();
      expect(result.data.strikeGuidance).toBeDefined();
      expect(result.data.strikeGuidance?.straddleCone?.upper).toBe(5960);
      expect(result.data.managementRules?.flowReversalSignal).toBe(
        'aggregate GEX flip',
      );
      expect(result.data.entryPlan?.entry1?.timing).toBe('09:35');
      expect(result.data.entryPlan?.entry3).toBeNull();
      expect(result.data.directionalOpportunity?.direction).toBe('LONG CALL');
      expect(result.data.hedge?.recommendation).toBe('PROTECTIVE LONG');
      expect(result.data.review?.recommendationChain?.entry?.verdict).toBe(
        'CORRECT',
      );
      expect(result.data.pressureAnalysis).toBe(
        'short-dated dealer charm pinning to 5920',
      );
    }
  });
});
