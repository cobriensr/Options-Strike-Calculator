/**
 * Zod schemas for API request validation.
 *
 * Validates req.body at system boundaries before data reaches
 * the Anthropic API or Postgres. Rejects malformed payloads
 * early with clear error messages.
 */

import { z } from 'zod';

// ============================================================
// /api/spot-gex-history
// ============================================================

/**
 * Query params for GET /api/spot-gex-history.
 *
 * `date` is optional — when omitted the endpoint defaults to the latest
 * ET trading date that has rows in `spot_exposures`. When present it
 * must be a YYYY-MM-DD calendar date so we never feed arbitrary strings
 * into the SQL `date = $1` parameter.
 */
export const spotGexHistoryQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
});

export type SpotGexHistoryQuery = z.infer<typeof spotGexHistoryQuerySchema>;

// ============================================================
// /api/max-pain-current
// ============================================================

/**
 * Query params for GET /api/max-pain-current.
 *
 * `date` is optional — when omitted the endpoint resolves the live UW
 * max-pain value for today ET. When present it must be a YYYY-MM-DD
 * calendar date; if it equals today ET the handler falls through to the
 * live path, and if it's a past date the handler computes max-pain from
 * the `oi_per_strike` table rather than hitting UW.
 */
export const maxPainCurrentQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
});

export type MaxPainCurrentQuery = z.infer<typeof maxPainCurrentQuerySchema>;

// ============================================================
// /api/alerts-ack
// ============================================================

export const alertAckSchema = z.object({
  id: z.number().int().positive().finite(),
});

export type AlertAckBody = z.infer<typeof alertAckSchema>;

// ============================================================
// /api/push/subscribe + /api/push/unsubscribe
// ============================================================

/**
 * Body schema for POST /api/push/subscribe.
 *
 * Matches the JSON shape produced by the browser's
 * `PushSubscription.toJSON()`. `endpoint` is the push-service URL,
 * `keys.p256dh` / `keys.auth` are the per-device public cryptographic
 * material web-push requires to encrypt a payload for this subscription.
 * `userAgent` is an optional self-reported device tag — trimmed to
 * prevent storage bloat from pathological UA strings.
 */
const httpsEndpoint = z
  .string()
  .url()
  .refine((u) => u.startsWith('https://'), {
    message: 'endpoint must use https',
  });

export const PushSubscribeBodySchema = z.object({
  endpoint: httpsEndpoint,
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(100),
  }),
});

export type PushSubscribeBody = z.infer<typeof PushSubscribeBodySchema>;

/**
 * Body schema for POST /api/push/unsubscribe. Idempotent — callers
 * pass the exact endpoint they previously subscribed with.
 */
export const PushUnsubscribeBodySchema = z.object({
  endpoint: httpsEndpoint,
});

export type PushUnsubscribeBody = z.infer<typeof PushUnsubscribeBodySchema>;

// ============================================================
// /api/push/recent-events
// ============================================================

/**
 * Query params for GET /api/push/recent-events.
 *
 * `limit` is optional — when omitted the endpoint returns the last 20
 * rows from `regime_events`. When present it must coerce to a positive
 * integer 1..100 so the response never balloons past the budget. The
 * raw value arrives as a string in `req.query`, so we coerce before
 * validating.
 */
export const PushRecentEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type PushRecentEventsQuery = z.infer<
  typeof PushRecentEventsQuerySchema
>;

// ============================================================
// /api/positions (POST — thinkorswim CSV upload)
// ============================================================

const MAX_CSV_BYTES = 1_024_000; // 1MB

export const positionCsvSchema = z.object({
  csv: z
    .string()
    .min(1, 'CSV body is empty')
    .refine((v) => v.length <= MAX_CSV_BYTES, 'CSV too large. Maximum 1MB.'),
});

export type PositionCsvBody = z.infer<typeof positionCsvSchema>;

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
    nopeSignal: chartConfidenceEntry,
    deltaFlow: chartConfidenceEntry,
    zeroGamma: chartConfidenceEntry,
    netGexHeatmap: chartConfidenceEntry,
    marketInternals: chartConfidenceEntry,
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
      recommendationChain: z
        .object({
          entry: z
            .object({
              time: z.string(),
              structure: z.enum([
                'IRON CONDOR',
                'PUT CREDIT SPREAD',
                'CALL CREDIT SPREAD',
                'SIT OUT',
              ]),
              verdict: z.enum(['CORRECT', 'WRONG_RESCUED', 'WRONG_UNRESCUED']),
              rationale: z.string(),
            })
            .nullable(),
          midday: z
            .object({
              time: z.string(),
              structure: z.enum([
                'IRON CONDOR',
                'PUT CREDIT SPREAD',
                'CALL CREDIT SPREAD',
                'SIT OUT',
              ]),
              verdict: z.enum(['CORRECT', 'WRONG_RESCUED', 'WRONG_UNRESCUED']),
              rationale: z.string(),
            })
            .nullable(),
        })
        .nullable()
        .optional(),
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
