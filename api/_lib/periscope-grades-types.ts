/**
 * Type definitions for the Periscope Calibration & Grading system
 * (docs/superpowers/specs/periscope-calibration-grading-2026-05-11.md).
 *
 * One `Grade` corresponds to one `periscope_analyses` row scored by the
 * deterministic grader. All fields are nullable when the underlying
 * playbook field was absent — null propagates through to "ungraded"
 * rather than forcing a default.
 *
 * `GRADER_VERSION` is incremented whenever the rubric changes. Old
 * grades stay in the DB tagged with the older version so we can
 * compare rubric revisions over the same playbook corpus.
 */

import { z } from 'zod';

/**
 * Bump this when changing any grading rule's formula, threshold, or
 * input. The grading CLI writes this value into `periscope_grades.
 * grader_version` and the UNIQUE (periscope_analysis_id, grader_version)
 * constraint lets the new + old grades coexist for compare.
 */
export const GRADER_VERSION = 1 as const;

// ─── Trade simulation ──────────────────────────────────────────────

export const TRADE_ASSETS = ['SPX', 'ES', 'NQ'] as const;
export type TradeAsset = (typeof TRADE_ASSETS)[number];

export const TRADE_SIDES = ['long', 'short'] as const;
export type TradeSide = (typeof TRADE_SIDES)[number];

export const TRADE_EXIT_REASONS = ['stop', 'target', 'eod'] as const;
export type TradeExitReason = (typeof TRADE_EXIT_REASONS)[number];

export const TradeSimSchema = z.object({
  asset: z.enum(TRADE_ASSETS),
  side: z.enum(TRADE_SIDES),
  entryPrice: z.number(),
  entryAt: z.string(), // ISO
  exitPrice: z.number(),
  exitAt: z.string(), // ISO
  exitReason: z.enum(TRADE_EXIT_REASONS),
  pnlPct: z.number(), // signed return % over the simulated holding period
  durationMin: z.number().int().nonnegative(),
});
export type TradeSim = z.infer<typeof TradeSimSchema>;

// ─── Regime classifications ────────────────────────────────────────

export const OBSERVED_REGIMES = [
  'pin',
  'cone-breach-up',
  'cone-breach-down',
  'drift-and-cap',
  'mixed',
] as const;
export type ObservedRegime = (typeof OBSERVED_REGIMES)[number];

// ─── Charm drift ──────────────────────────────────────────────────

export const CHARM_DRIFT_DIRECTIONS = ['up', 'down', 'flat'] as const;
export type CharmDriftDirection = (typeof CHARM_DRIFT_DIRECTIONS)[number];

// ─── Structure grades ──────────────────────────────────────────────

/**
 * Map of structure_name → graded outcome. `null` means we don't have a
 * rule for that structure (surface but don't pollute accuracy stats).
 * `true` means the structure would have been profitable per its
 * outcome rule; `false` means it would have lost.
 */
export const StructureGradesSchema = z.record(
  z.string(),
  z.boolean().nullable(),
);
export type StructureGrades = z.infer<typeof StructureGradesSchema>;

// ─── Grade row ─────────────────────────────────────────────────────

export const GradeSchema = z.object({
  periscopeAnalysisId: z.number().int().positive(),
  tradingDate: z.string(), // YYYY-MM-DD CT
  slotCapturedAt: z.string(), // ISO
  mode: z.enum(['pre_trade', 'intraday', 'debrief']),
  confidence: z.string().nullable(),
  graderVersion: z.number().int().positive(),

  // Regime
  regimeCall: z.string().nullable(),
  regimeObserved: z.enum(OBSERVED_REGIMES).nullable(),
  regimeCorrect: z.boolean().nullable(),

  // Bias
  biasCall: z.string().nullable(),
  biasObservedReturn: z.number().nullable(),
  biasCorrect: z.boolean().nullable(),

  // Cone
  coneLower: z.number().nullable(),
  coneUpper: z.number().nullable(),
  coneHeld: z.boolean().nullable(),

  // Gamma levels
  gammaFloor: z.number().nullable(),
  gammaFloorHeld: z.boolean().nullable(),
  gammaCeiling: z.number().nullable(),
  gammaCeilingHeld: z.boolean().nullable(),

  // Charm
  charmZero: z.number().nullable(),
  charmDriftCall: z.enum(CHARM_DRIFT_DIRECTIONS).nullable(),
  charmDriftObservedPct: z.number().nullable(),
  charmDriftCorrect: z.boolean().nullable(),

  // Triggers
  longTrigger: z.number().nullable(),
  longFired: z.boolean(),
  longFiredAt: z.string().nullable(), // ISO
  shortTrigger: z.number().nullable(),
  shortFired: z.boolean(),
  shortFiredAt: z.string().nullable(), // ISO

  // Trade simulations
  tradeSims: z.array(TradeSimSchema),

  // IC
  eodClose: z.number().nullable(),
  icBlownAtEod: z.boolean().nullable(),

  // Structures
  recommendedStructuresCorrect: StructureGradesSchema,
  avoidStructuresCorrect: StructureGradesSchema,
});
export type Grade = z.infer<typeof GradeSchema>;

// ─── Candle shape consumed by the grader ───────────────────────────

export interface Candle {
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

// ─── Grading thresholds ────────────────────────────────────────────

/**
 * Magic numbers used by the grader, hoisted here so they're easy to
 * audit, change, and reference in tests. Bumping any of these warrants
 * incrementing GRADER_VERSION.
 */
export const GRADER_THRESHOLDS = {
  /** Pin regime ±pt from magnet/charmZero. */
  PIN_TOLERANCE_PTS: 5,
  /** Two-sided bias "no direction" — |return| < this counts as correct. */
  TWO_SIDED_RETURN_PCT: 0.002, // 0.2%
  /** Charm drift "flat" noise threshold (|return| < this = flat). */
  CHARM_NOISE_PCT: 0.0005, // 0.05%
  /** Directional structure ATR multiple required to count as correct. */
  DIRECTIONAL_ATR_MULT: 1.0,
  /** ATR window in minutes prior to slot, computed from SPX 1m. */
  ATR_WINDOW_MIN: 30,
  /** Bar size for trigger-fire confirmation. */
  TRIGGER_BAR_MIN: 5,
  /** EOD reference time CT (hour, minute) — 0DTE SPX cash-settle anchor. */
  EOD_HOUR_CT: 15,
  EOD_MINUTE_CT: 0,
  /** Long_straddle "vol expansion" |return| threshold. */
  STRADDLE_RETURN_PCT: 0.004, // 0.4%
  /** Pin-favorable structure (butterfly/iron_butterfly) ±pt at EOD. */
  IRON_BUTTERFLY_PIN_PTS: 5,
  BROKEN_WING_PIN_PTS: 10,
  /** Directional long_call/long_put EOD return threshold (signed). */
  DIRECTIONAL_LONG_RETURN_PCT: 0.003, // 0.3%
} as const;
