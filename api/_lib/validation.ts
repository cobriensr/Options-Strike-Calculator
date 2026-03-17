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
  mediaType: z.string().min(1, 'mediaType is required'),
  label: z.string().optional(),
});

export const analyzeBodySchema = z.object({
  images: z
    .array(analyzeImageSchema)
    .min(1, 'At least one image is required')
    .max(6, 'Maximum 6 images allowed'),
  context: z.record(z.string(), z.unknown()),
});

export type AnalyzeBody = z.infer<typeof analyzeBodySchema>;

// ============================================================
// /api/snapshot
// ============================================================

export const snapshotBodySchema = z.object({
  date: z.string().min(1, 'date is required'),
  entryTime: z.string().min(1, 'entryTime is required'),

  // Prices
  spx: z.number().optional(),
  spy: z.number().optional(),
  spxOpen: z.number().optional(),
  spxHigh: z.number().optional(),
  spxLow: z.number().optional(),
  prevClose: z.number().optional(),

  // Volatility
  vix: z.number().optional(),
  vix1d: z.number().optional(),
  vix9d: z.number().optional(),
  vvix: z.number().optional(),

  // Calculator
  sigma: z.number().optional(),
  sigmaSource: z.string().optional(),
  tYears: z.number().optional(),
  hoursRemaining: z.number().optional(),
  skewPct: z.number().optional(),

  // Regime
  regimeZone: z.string().optional(),
  clusterMult: z.number().optional(),
  dowMultHL: z.number().optional(),
  dowMultOC: z.number().optional(),
  dowLabel: z.string().optional(),

  // Delta guide
  icCeiling: z.number().optional(),
  putSpreadCeiling: z.number().optional(),
  callSpreadCeiling: z.number().optional(),
  moderateDelta: z.number().optional(),
  conservativeDelta: z.number().optional(),

  // Range thresholds
  medianOcPct: z.number().optional(),
  medianHlPct: z.number().optional(),
  p90OcPct: z.number().optional(),
  p90HlPct: z.number().optional(),
  p90OcPts: z.number().optional(),
  p90HlPts: z.number().optional(),

  // Opening range
  openingRangeAvailable: z.boolean().optional(),
  openingRangeHigh: z.number().optional(),
  openingRangeLow: z.number().optional(),
  openingRangePctConsumed: z.number().optional(),
  openingRangeSignal: z.string().optional(),

  // Term structure
  vixTermSignal: z.string().optional(),

  // Overnight
  overnightGap: z.number().optional(),

  // Strikes
  strikes: z.record(z.string(), z.unknown()).optional(),

  // Events
  isEarlyClose: z.boolean().optional(),
  isEventDay: z.boolean().optional(),
  eventNames: z.array(z.string()).optional(),

  isBacktest: z.boolean().optional(),
});

export type SnapshotBody = z.infer<typeof snapshotBodySchema>;
