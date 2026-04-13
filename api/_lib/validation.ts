/**
 * Zod schemas for API request validation.
 *
 * Validates req.body at system boundaries before data reaches
 * the Anthropic API or Postgres. Rejects malformed payloads
 * early with clear error messages.
 */

import { z } from 'zod';

// ============================================================
// /api/analyze
// ============================================================

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB in base64 chars

export const analyzeImageSchema = z.object({
  data: z
    .string()
    .min(1, 'Image data is required')
    .max(MAX_IMAGE_SIZE, 'Image too large. Maximum 5MB per image.'),
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
  label: z.string().optional(),
});

export const analyzeBodySchema = z.object({
  images: z
    .array(analyzeImageSchema)
    .min(1, 'At least one image is required')
    .max(4, 'Maximum 4 images allowed'),
  context: z.record(z.string(), z.unknown()),
});

export type AnalyzeBody = z.infer<typeof analyzeBodySchema>;

// ============================================================
// /api/pre-market
// ============================================================

export const preMarketBodySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  globexHigh: z.number(),
  globexLow: z.number(),
  globexClose: z.number(),
  globexVwap: z.number().nullable().optional(),
  straddleConeUpper: z.number().nullable().optional(),
  straddleConeLower: z.number().nullable().optional(),
  savedAt: z.string().nullable().optional(),
});

export type PreMarketBody = z.infer<typeof preMarketBodySchema>;

// ============================================================
// /api/snapshot
// ============================================================

// Helper: fields from ComputedSignals are often `T | null`, and
// JSON.stringify preserves null (unlike undefined). Accept both.
const num = z.number().nullable().optional();
const str = z.string().nullable().optional();
const bool = z.boolean().nullable().optional();

export const snapshotBodySchema = z.object({
  date: z.string().min(1, 'date is required'),
  entryTime: z.string().min(1, 'entryTime is required'),

  // Prices
  spx: num,
  spy: num,
  spxOpen: num,
  spxHigh: num,
  spxLow: num,
  prevClose: num,

  // Volatility
  vix: num,
  vix1d: num,
  vix9d: num,
  vvix: num,

  // Calculator
  sigma: num,
  sigmaSource: str,
  tYears: num,
  hoursRemaining: num,
  skewPct: num,

  // Regime
  regimeZone: str,
  clusterMult: num,
  dowMultHL: num,
  dowMultOC: num,
  dowLabel: str,

  // Delta guide
  icCeiling: num,
  putSpreadCeiling: num,
  callSpreadCeiling: num,
  moderateDelta: num,
  conservativeDelta: num,

  // Range thresholds
  medianOcPct: num,
  medianHlPct: num,
  p90OcPct: num,
  p90HlPct: num,
  p90OcPts: num,
  p90HlPts: num,

  // Opening range
  openingRangeAvailable: bool,
  openingRangeHigh: num,
  openingRangeLow: num,
  openingRangePctConsumed: num,
  openingRangeSignal: str,

  // Term structure
  vixTermSignal: str,

  // Overnight
  overnightGap: num,

  // Strikes (keyed by delta, e.g. "5", "10", "15")
  strikes: z
    .record(
      z.string(),
      z.object({
        put: z.number(),
        call: z.number(),
        putPct: z.number(),
        callPct: z.number(),
      }),
    )
    .nullable()
    .optional(),

  // Events
  isEarlyClose: bool,
  isEventDay: bool,
  eventNames: z.array(z.string()).nullable().optional(),

  isBacktest: bool,
});

export type SnapshotBody = z.infer<typeof snapshotBodySchema>;

// ============================================================
// Analysis response schema (structured output for Claude)
// ============================================================

const chartConfidenceEntry = z.object({
  signal: z.string(),
  confidence: z.enum(['HIGH', 'MODERATE', 'LOW']),
  note: z.string(),
});

const entryStep = z.object({
  timing: z.string(),
  condition: z.string(),
  sizePercent: z.number(),
  delta: z.number(),
  structure: z.string(),
  note: z.string(),
});

export const analysisResponseSchema = z.object({
  mode: z.enum(['entry', 'midday', 'review']),
  structure: z.enum([
    'IRON CONDOR',
    'PUT CREDIT SPREAD',
    'CALL CREDIT SPREAD',
    'SIT OUT',
  ]),
  confidence: z.enum(['HIGH', 'MODERATE', 'LOW']),
  suggestedDelta: z.number().nullable(),
  reasoning: z.string(),
  chartConfidence: z.object({
    marketTide: chartConfidenceEntry,
    spxNetFlow: chartConfidenceEntry,
    spyNetFlow: chartConfidenceEntry,
    qqqNetFlow: chartConfidenceEntry,
    periscope: chartConfidenceEntry,
    netCharm: chartConfidenceEntry,
    aggregateGex: chartConfidenceEntry,
    periscopeCharm: chartConfidenceEntry,
    darkPool: chartConfidenceEntry,
    ivTermStructure: chartConfidenceEntry,
    spxCandles: chartConfidenceEntry,
    overnightGap: chartConfidenceEntry,
    vannaExposure: chartConfidenceEntry,
    pinRisk: chartConfidenceEntry,
    skew: chartConfidenceEntry,
    futuresContext: chartConfidenceEntry,
    deltaPressure: chartConfidenceEntry,
    charmPressure: chartConfidenceEntry,
  }),
  observations: z.array(z.string()),
  strikeGuidance: z
    .object({
      putStrikeNote: z.string().nullable(),
      callStrikeNote: z.string().nullable(),
      straddleCone: z
        .object({
          upper: z.number().nullable(),
          lower: z.number().nullable(),
          priceRelation: z.string(),
        })
        .nullable(),
      adjustments: z.array(z.string()),
    })
    .nullable(),
  managementRules: z
    .object({
      profitTarget: z.string(),
      stopConditions: z.array(z.string()),
      timeRules: z.string(),
      flowReversalSignal: z.string().nullable(),
    })
    .nullable(),
  entryPlan: z
    .object({
      entry1: entryStep.nullable(),
      entry2: entryStep.nullable(),
      entry3: entryStep.nullable(),
      maxTotalSize: z.string(),
      noEntryConditions: z.array(z.string()),
    })
    .nullable(),
  directionalOpportunity: z
    .object({
      direction: z.enum(['LONG CALL', 'LONG PUT']),
      confidence: z.enum(['HIGH', 'MODERATE', 'LOW']),
      reasoning: z.string(),
      entryTiming: z.string(),
      stopLoss: z.string(),
      profitTarget: z.string(),
      keyLevels: z.object({
        support: z.string().nullable(),
        resistance: z.string().nullable(),
        vwap: z.string().nullable(),
      }),
      signals: z.array(z.string()),
    })
    .nullable()
    .optional(),
  risks: z.array(z.string()),
  hedge: z
    .object({
      recommendation: z.enum([
        'NO HEDGE',
        'PROTECTIVE LONG',
        'DEBIT SPREAD HEDGE',
        'REDUCED SIZE',
        'SKIP',
      ]),
      description: z.string(),
      rationale: z.string(),
      estimatedCost: z.string(),
    })
    .nullable(),
  periscopeNotes: z.string().nullable(),
  pressureAnalysis: z.string().nullable().optional(),
  structureRationale: z.string(),
  review: z
    .object({
      wasCorrect: z.boolean(),
      whatWorked: z.string(),
      whatMissed: z.string(),
      optimalTrade: z.string(),
      lessonsLearned: z.array(z.string()),
    })
    .nullable(),
  imageIssues: z.array(
    z.object({
      imageIndex: z.number(),
      label: z.string(),
      issue: z.string(),
      suggestion: z.string(),
    }),
  ),
});

export type AnalysisResponse = z.infer<typeof analysisResponseSchema>;
