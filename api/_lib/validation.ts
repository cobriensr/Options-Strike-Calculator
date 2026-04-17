/**
 * Zod schemas for API request validation.
 *
 * Validates req.body at system boundaries before data reaches
 * the Anthropic API or Postgres. Rejects malformed payloads
 * early with clear error messages.
 */

import { z } from 'zod';

// ============================================================
// /api/alerts-ack
// ============================================================

export const alertAckSchema = z.object({
  id: z.number().int().positive().finite(),
});

export type AlertAckBody = z.infer<typeof alertAckSchema>;

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

// ============================================================
// /api/pyramid/chains + /api/pyramid/legs
// ============================================================
//
// Droppable MNQ pyramid trade tracker experiment. Per spec
// (docs/superpowers/specs/pyramid-tracker-2026-04-16.md):
// ALL feature fields are optional — only identity fields (`id`,
// `chain_id`, `leg_number`) are strictly required. Partial rows
// must save successfully so the user can log live during trades
// without stalling to fill every field.
//
// Enum values validate only when non-null. `.optional().nullable()`
// accepts missing, undefined, or explicit null (matching the
// Postgres schema where every non-identity column permits NULL).

export const pyramidChainSchema = z.object({
  id: z.string().min(1, 'chain id is required'),
  trade_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'trade_date must be YYYY-MM-DD')
    .optional()
    .nullable(),
  instrument: z.string().optional().nullable(),
  direction: z.enum(['long', 'short']).optional().nullable(),
  entry_time_ct: z.string().optional().nullable(),
  exit_time_ct: z.string().optional().nullable(),
  initial_entry_price: z.number().optional().nullable(),
  final_exit_price: z.number().optional().nullable(),
  exit_reason: z
    .enum(['reverse_choch', 'stopped_out', 'manual', 'eod'])
    .optional()
    .nullable(),
  total_legs: z.number().int().min(0).optional().nullable(),
  winning_legs: z.number().int().min(0).optional().nullable(),
  net_points: z.number().optional().nullable(),
  session_atr_pct: z.number().optional().nullable(),
  day_type: z.enum(['trend', 'chop', 'news', 'mixed']).optional().nullable(),
  higher_tf_bias: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  // status is NOT NULL in the DB with default 'open'. We accept it as
  // optional (omit -> DB default / keep existing) but reject explicit
  // null to match updateChain's behavior: a null patch is silently
  // swallowed by the COALESCE, so allowing null at the schema level
  // would be misleading.
  status: z.enum(['open', 'closed']).optional(),
});

export type PyramidChainInput = z.infer<typeof pyramidChainSchema>;

export const pyramidLegSchema = z.object({
  id: z.string().min(1, 'leg id is required'),
  chain_id: z.string().min(1, 'chain_id is required'),
  leg_number: z.number().int().min(1, 'leg_number must be >= 1'),
  signal_type: z.enum(['CHoCH', 'BOS']).optional().nullable(),
  entry_time_ct: z.string().optional().nullable(),
  entry_price: z.number().optional().nullable(),
  stop_price: z.number().optional().nullable(),
  stop_distance_pts: z.number().optional().nullable(),
  stop_compression_ratio: z.number().optional().nullable(),
  vwap_at_entry: z.number().optional().nullable(),
  vwap_1sd_upper: z.number().optional().nullable(),
  vwap_1sd_lower: z.number().optional().nullable(),
  vwap_band_position: z
    .enum(['outside_upper', 'at_upper', 'inside', 'at_lower', 'outside_lower'])
    .optional()
    .nullable(),
  vwap_band_distance_pts: z.number().optional().nullable(),
  minutes_since_chain_start: z.number().int().optional().nullable(),
  minutes_since_prior_bos: z.number().int().optional().nullable(),
  ob_quality: z.number().int().min(1).max(5).optional().nullable(),
  relative_volume: z.number().int().min(1).max(5).optional().nullable(),
  session_phase: z
    .enum([
      'pre_open',
      'open_drive',
      'morning_drive',
      'lunch',
      'afternoon',
      'power_hour',
      'close',
    ])
    .optional()
    .nullable(),
  session_high_at_entry: z.number().optional().nullable(),
  session_low_at_entry: z.number().optional().nullable(),
  retracement_extreme_before_entry: z.number().optional().nullable(),
  exit_price: z.number().optional().nullable(),
  // Extended in migration 67: adds FVG-trail, VWAP-band, and
  // failed-re-extension variants alongside the original three values.
  // `trailed_stop` remains as the generic fallback for trail exits that
  // don't match one of the specific variants.
  exit_reason: z
    .enum([
      'reverse_choch',
      'trailed_stop',
      'manual',
      'fvg_close_below',
      'vwap_band_break',
      'failed_re_extension',
    ])
    .optional()
    .nullable(),
  points_captured: z.number().optional().nullable(),
  r_multiple: z.number().optional().nullable(),
  was_profitable: z.boolean().optional().nullable(),
  notes: z.string().optional().nullable(),
  ob_high: z.number().optional().nullable(),
  ob_low: z.number().optional().nullable(),
  ob_poc_price: z.number().optional().nullable(),
  ob_poc_pct: z.number().min(0).max(100).optional().nullable(),
  ob_secondary_node_pct: z.number().min(0).max(100).optional().nullable(),
  ob_tertiary_node_pct: z.number().min(0).max(100).optional().nullable(),
  ob_total_volume: z.number().nonnegative().optional().nullable(),
  // Added in migration 67. Captured separately so ML analysis can correlate
  // RTH/ETH structure disagreement with outcome — collapsing them into a
  // single bias field would destroy that signal.
  rth_structure_bias: z
    .enum(['bullish', 'bearish', 'neutral'])
    .optional()
    .nullable(),
  eth_structure_bias: z
    .enum(['bullish', 'bearish', 'neutral'])
    .optional()
    .nullable(),
});

export type PyramidLegInput = z.infer<typeof pyramidLegSchema>;
