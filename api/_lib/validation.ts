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
    .max(7, 'Maximum 7 images allowed'),
  context: z.record(z.string(), z.unknown()),
});

export type AnalyzeBody = z.infer<typeof analyzeBodySchema>;

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

  // Strikes
  strikes: z.record(z.string(), z.unknown()).nullable().optional(),

  // Events
  isEarlyClose: bool,
  isEventDay: bool,
  eventNames: z.array(z.string()).nullable().optional(),

  isBacktest: bool,
});

export type SnapshotBody = z.infer<typeof snapshotBodySchema>;
