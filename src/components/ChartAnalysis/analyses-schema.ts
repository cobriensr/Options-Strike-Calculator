/**
 * Zod schemas for the two GET /api/analyses replies AnalysisHistory reads
 * (`?dates=true` and `?date=`). A 2xx whose body fails them is handled like a
 * failed fetch: the panel shows its error, and nothing malformed reaches
 * state, where a wrong type would throw during render.
 *
 * They check what the panel, the picker and the result view dereference, no
 * more, so a stored row that predates a field still loads:
 *
 *   - a field rendered or called on (`.map`, `.length`, a React child) is
 *     type-checked when present;
 *   - an array the view dereferences without a guard falls back to `[]` when
 *     absent, and is rejected when it is some other type;
 *   - a nested block is `nullish()`, because the server stores `null` for
 *     blocks a mode doesn't produce (api/_lib/validation/snapshot.ts).
 *
 * Fields no component reads are not listed: `z.object` strips them.
 */

import { z } from 'zod';

const text = z.string().nullish();
const textList = z.array(z.string()).nullish();
/** An array the result view calls `.map` or `.length` on without a guard. */
const requiredTextList = z.array(z.string()).default([]);

const analysisModeSchema = z.enum(['entry', 'midday', 'review']);

const chartSignalSchema = z.object({
  signal: z.string(),
  confidence: z.string(),
  note: z.string(),
});

const entryStepSchema = z.object({
  timing: text,
  condition: text,
  sizePercent: z.number().nullish(),
  delta: z.number().nullish(),
  structure: text,
  note: text,
});

const analysisResultSchema = z.object({
  mode: analysisModeSchema.optional(),
  structure: z.string(),
  confidence: z.string(),
  // `null` for a SIT OUT: the server's own schema allows it.
  suggestedDelta: z.number().nullable(),
  reasoning: text,
  observations: requiredTextList,
  risks: requiredTextList,
  structureRationale: text,
  // Every key but they are all optional: the grid skips a missing one.
  chartConfidence: z.record(z.string(), chartSignalSchema.nullish()).nullish(),
  strikeGuidance: z
    .object({
      putStrikeNote: text,
      callStrikeNote: text,
      straddleCone: z
        .object({
          upper: z.number().nullish(),
          lower: z.number().nullish(),
          priceRelation: text,
        })
        .nullish(),
      adjustments: textList,
    })
    .nullish(),
  managementRules: z
    .object({
      profitTarget: text,
      stopConditions: textList,
      timeRules: text,
      flowReversalSignal: text,
    })
    .nullish(),
  entryPlan: z
    .object({
      entry1: entryStepSchema.nullish(),
      entry2: entryStepSchema.nullish(),
      entry3: entryStepSchema.nullish(),
      maxTotalSize: text,
      noEntryConditions: textList,
    })
    .nullish(),
  directionalOpportunity: z
    .object({
      direction: z.string(),
      confidence: z.string(),
      reasoning: text,
      entryTiming: text,
      stopLoss: text,
      profitTarget: text,
      keyLevels: z
        .object({ support: text, resistance: text, vwap: text })
        .default({}),
      signals: requiredTextList,
    })
    .nullish(),
  hedge: z
    .object({
      recommendation: z.string(),
      description: text,
      rationale: text,
      estimatedCost: text,
    })
    .nullish(),
  periscopeNotes: text,
  pressureAnalysis: text,
  review: z
    .object({
      wasCorrect: z.boolean(),
      whatWorked: text,
      whatMissed: text,
      optimalTrade: text,
      lessonsLearned: requiredTextList,
    })
    .nullish(),
  imageIssues: z
    .array(
      z.object({
        imageIndex: z.number(),
        label: z.string(),
        issue: z.string(),
        suggestion: z.string(),
      }),
    )
    .nullish(),
});

const analysisEntrySchema = z.object({
  id: z.number(),
  entryTime: z.string(),
  // Indexes MODE_LABELS in the picker and the item, so an unknown mode throws.
  mode: analysisModeSchema,
  structure: z.string(),
  confidence: z.string(),
  suggestedDelta: z.number().nullable(),
  spx: z.number().nullish(),
  vix: z.number().nullish(),
  vix1d: z.number().nullish(),
  hedge: z.string().nullish(),
  analysis: analysisResultSchema,
  createdAt: z.string(),
});

const dateEntrySchema = z.object({
  date: z.string(),
  total: z.number(),
  entries: z.number(),
  middays: z.number(),
  reviews: z.number(),
});

/** `GET /api/analyses?dates=true`. The key is required: the server always sends it. */
export const datesResponseSchema = z.object({
  dates: z.array(dateEntrySchema),
});

/** `GET /api/analyses?date=`. The key is required: the server always sends it. */
export const analysesResponseSchema = z.object({
  analyses: z.array(analysisEntrySchema),
});
