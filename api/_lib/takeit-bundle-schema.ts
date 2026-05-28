// Zod schema for the TakeitBundle JSON shape. Validation is fail-closed:
// any bundle that doesn't conform throws BundleSchemaError. Used at load
// time by api/_lib/takeit-bundle-loader.ts BEFORE any row is scored.

import { z } from 'zod';
import { BundleSchemaError } from './takeit-score.js';

const XGBTreeSchema = z.object({
  left_children: z.array(z.number()),
  right_children: z.array(z.number()),
  split_indices: z.array(z.number()),
  split_conditions: z.array(z.number()),
  default_left: z.array(z.number()),
  base_weights: z.array(z.number()),
  split_type: z.array(z.number()).optional(),
});

const IsotonicSplineSchema = z
  .object({
    x_thresholds: z.array(z.number()),
    y_thresholds: z.array(z.number()),
    out_of_bounds: z.enum(['clip', 'nan']).optional(),
  })
  .refine((s) => s.x_thresholds.length === s.y_thresholds.length, {
    message: 'isotonic.x_thresholds and y_thresholds must have equal length',
  })
  .refine((s) => s.x_thresholds.length >= 2, {
    message: 'isotonic spline needs at least 2 thresholds',
  });

export const TakeitBundleSchema = z.object({
  version: z.string().min(1),
  alert_type: z.enum(['lottery', 'silentboom']),
  trained_on_date: z.string().min(1),
  win_label_threshold_pct: z.number(),
  xgb_json_schema: z.string().min(1),
  feature_cols: z.array(z.string().min(1)).min(1),
  top_tickers: z.array(z.string()),
  categorical_cols: z.array(z.string()),
  feature_derivation_constants: z.record(z.string(), z.number()),
  xgb_model: z.object({
    learner: z.object({
      learner_model_param: z.object({
        base_score: z.string(),
        num_feature: z.string().optional(),
      }),
      gradient_booster: z.object({
        model: z.object({
          trees: z.array(XGBTreeSchema).min(1, {
            message: 'xgb_model.trees must be non-empty',
          }),
          gbtree_model_param: z.object({ num_trees: z.string() }).optional(),
        }),
      }),
    }),
  }),
  isotonic: IsotonicSplineSchema,
  metrics_snapshot: z.record(z.string(), z.unknown()).optional(),
});

export type TakeitBundleValidated = z.infer<typeof TakeitBundleSchema>;

/**
 * Validate a parsed JSON object against the TakeitBundle schema. Throws
 * BundleSchemaError with a useful message on any deviation; that error is
 * caught by the bundle loader, captured to Sentry, and falls back to the
 * cached prior bundle (if any) or null.
 */
export function validateBundle(raw: unknown): TakeitBundleValidated {
  const result = TakeitBundleSchema.safeParse(raw);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const where = firstIssue?.path.length
      ? firstIssue.path.join('.')
      : '<root>';
    const msg = firstIssue?.message ?? 'unknown validation failure';
    throw new BundleSchemaError(
      `TakeitBundle validation failed at ${where}: ${msg}`,
    );
  }
  return result.data;
}
