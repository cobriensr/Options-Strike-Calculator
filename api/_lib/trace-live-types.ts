/**
 * Shared types for /api/trace-live-analyze.
 *
 * Defines the input payload (3 chart images + structured GEX landscape data)
 * and the structured output Claude returns (charm/gamma/delta read +
 * synthesis with predicted close, confidence, and trade recommendation).
 *
 * Output schema is enforced via Anthropic's `output_config.format` so we get
 * a guaranteed valid JSON object back instead of free-text we have to parse.
 */

import { z } from 'zod';

// ============================================================
// INPUT — chart captures + structured GEX landscape
// ============================================================

export const traceImageSchema = z.object({
  /** Base64-encoded PNG; exclude the data: prefix */
  data: z.string(),
  /** Always `image/png` for TRACE captures */
  mediaType: z.literal('image/png'),
  /** Which chart this is */
  chart: z.enum(['gamma', 'charm', 'delta']),
  /** Capture slot — `now` for the latest live capture during the session */
  slot: z.enum(['open', 'mid', 'close', 'eod', 'now']),
  /** ISO timestamp of when this PNG was captured */
  capturedAt: z.string(),
});
export type TraceImage = z.infer<typeof traceImageSchema>;

/**
 * Per-strike GEX landscape entry — derived from the strike-calculator's
 * existing GEX landscape component. The user has confirmed this data is
 * available via API on a 1-min cron, so OCR is not needed.
 */
export const traceStrikeRowSchema = z.object({
  strike: z.number(),
  /** Per-strike dollar gamma (signed). E.g. +3_400_000_000 for +3.4B */
  dollarGamma: z.number(),
  /** Optional pre-computed classification ("Weakening Pin", "Sticky Pin", etc.) */
  classification: z.string().optional(),
  /** Optional pre-computed signal ("Softening Ceiling", "Hard Floor", etc.) */
  signal: z.string().optional(),
  /** 1-minute % change in dollar gamma (-100..+100) */
  delta1m: z.number().optional(),
  /** 5-minute % change in dollar gamma */
  delta5m: z.number().optional(),
  /** Per-strike charm value (signed) */
  charm: z.number().optional(),
  /** Volume marker — true = trading; false = quiet */
  vol: z.boolean().optional(),
});
export type TraceStrikeRow = z.infer<typeof traceStrikeRowSchema>;

export const traceGexLandscapeSchema = z.object({
  /** Free-text regime label (e.g. "RANGE-BOUND") */
  regime: z.string(),
  /** One-line human-readable summary (optional, the GEX component renders this) */
  regimeText: z.string().optional(),
  /** Total positive GEX in dollars across the visible band */
  totalPosGex: z.number().optional(),
  /** Total negative GEX in dollars (signed negative or absolute) */
  totalNegGex: z.number().optional(),
  /** Net GEX = pos + neg (signed) */
  netGex: z.number().optional(),
  /** Spot strike (the row labelled "ATM" in the landscape) */
  atmStrike: z.number(),
  /** Up drift targets the landscape has pre-computed (highest-magnitude pins above spot) */
  driftTargetsUp: z.array(z.number()).optional(),
  /** Down drift targets (highest-magnitude pins below spot) */
  driftTargetsDown: z.array(z.number()).optional(),
  /** Per-strike rows, sorted descending by strike (UI order) */
  strikes: z.array(traceStrikeRowSchema),
});
export type TraceGexLandscape = z.infer<typeof traceGexLandscapeSchema>;

export const traceLiveAnalyzeBodySchema = z.object({
  /** ISO timestamp the capture batch fired (server-side time, not chart time) */
  capturedAt: z.string(),
  /** SPX cash price at capture moment */
  spot: z.number(),
  /** Stability% gauge value (0..100), null if not visible/captured */
  stabilityPct: z.number().nullable().optional(),
  /** ET wall-clock string for logging — e.g. "12:35 ET" */
  etTimeLabel: z.string().optional(),
  /** Three chart captures — gamma, charm, delta */
  images: z.array(traceImageSchema).min(1).max(4),
  /** Structured GEX landscape from the existing 1-min cron pipeline */
  gex: traceGexLandscapeSchema,
});
export type TraceLiveAnalyzeBody = z.infer<typeof traceLiveAnalyzeBodySchema>;

// ============================================================
// OUTPUT — structured analysis Claude returns
// ============================================================

export const traceCharmReadSchema = z.object({
  /** Predominant color of the charm heatmap around spot */
  predominantColor: z.enum(['red', 'blue', 'mixed', 'multi_band']),
  /** Direction call from charm flow */
  direction: z.enum(['long', 'short', 'flip', 'unstable', 'no_call']),
  /** Junction strike where red and blue meet near spot, if a clean junction exists */
  junctionStrike: z.number().nullable(),
  /** Has the chart's prevailing color flipped during the session? */
  flipFlopDetected: z.boolean(),
  /** Are rejection wicks visible at a red ceiling (dynamic-red rejection pattern)? */
  rejectionWicksAtRed: z.boolean(),
  /** Free-text observation, max 2 sentences */
  notes: z.string().max(400),
});

export const traceGammaReadSchema = z.object({
  /** Sign and depth of γ at the spot strike */
  signAtSpot: z.enum([
    'positive_strong',
    'positive_pale',
    'neutral',
    'negative_pale',
    'negative_strong',
  ]),
  /** Strike of the dominant +γ node within ±$30 of spot, null if no clear dominator */
  dominantNodeStrike: z.number().nullable(),
  /** Magnitude of the dominant node in billions of dollars (positive) */
  dominantNodeMagnitudeB: z.number().nullable(),
  /** Ratio of dominant node to next-nearest +γ node (≥10 fires the override) */
  dominantNodeRatio: z.number().nullable(),
  /** Strike of the +γ floor band edge below spot, null if no clear floor */
  floorStrike: z.number().nullable(),
  /** Strike of the −γ ceiling above spot, null if no clear ceiling */
  ceilingStrike: z.number().nullable(),
  /** Does the override rule fire? (dominant node ≥10× OR clear +γ floor/ceiling at non-charm-junction level) */
  overrideFires: z.boolean(),
  notes: z.string().max(400),
});

export const traceDeltaReadSchema = z.object({
  /** Strike of the deepest +γ-conditional support below spot */
  blueBelowStrike: z.number().nullable(),
  /** Strike of the deepest +γ-conditional resistance above spot */
  redAboveStrike: z.number().nullable(),
  /** Width of the corridor (red above − blue below) in dollars */
  corridorWidth: z.number().nullable(),
  /** In +γ regime zones are S/R; in −γ they're acceleration. Set per gamma sign. */
  zoneBehavior: z.enum(['support_resistance', 'acceleration', 'unclear']),
  notes: z.string().max(400),
});

export const traceTradeRecommendationSchema = z.object({
  type: z.enum([
    'iron_fly',
    'iron_condor',
    'tight_credit_spread',
    'directional_long',
    'directional_short',
    'flat',
  ]),
  centerStrike: z.number().nullable(),
  wingWidth: z.number().nullable(),
  /** Position sizing tier, scaled by conviction */
  size: z.enum(['full', 'three_quarter', 'half', 'quarter', 'none']),
});

export const traceAnalysisSchema = z.object({
  /** Server-rendered timestamp (ET) for display */
  timestamp: z.string(),
  /** SPX spot at capture moment, echoed back */
  spot: z.number(),
  /** Stability% at capture, echoed back, null if unread */
  stabilityPct: z.number().nullable(),
  /** Top-line regime classification */
  regime: z.enum([
    'range_bound_positive_gamma',
    'trending_positive_gamma',
    'range_bound_negative_gamma',
    'trending_negative_gamma',
    'mixed',
  ]),
  charm: traceCharmReadSchema,
  gamma: traceGammaReadSchema,
  delta: traceDeltaReadSchema,
  /** Synthesis across all three charts */
  synthesis: z.object({
    /** Predicted SPX close based on the chart hierarchy (gamma > charm for level) */
    predictedClose: z.number(),
    /** Conviction level — drives sizing */
    confidence: z.enum(['high', 'medium', 'low', 'no_trade']),
    /** Did all three charts agree on direction and level? */
    crossChartAgreement: z.enum([
      'all_agree',
      'mostly_agree',
      'split',
      'no_call',
    ]),
    /** Did the gamma override rule fire? */
    overrideApplied: z.boolean(),
    trade: traceTradeRecommendationSchema,
    /** Brief synthesis sentence the user sees at top of dashboard */
    headline: z.string().max(280),
    /** Specific risk factors / warnings (events, MOC risk, multi-band charts) */
    warnings: z.array(z.string().max(280)).max(8),
  }),
  /** Optional log of contextual notes for the audit trail (debug-friendly) */
  reasoningSummary: z.string().max(2000).optional(),
});
export type TraceAnalysis = z.infer<typeof traceAnalysisSchema>;
