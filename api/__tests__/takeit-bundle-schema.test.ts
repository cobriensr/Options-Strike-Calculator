import { describe, it, expect } from 'vitest';
import {
  TakeitBundleSchema,
  validateBundle,
} from '../_lib/takeit-bundle-schema.js';
import { BundleSchemaError } from '../_lib/takeit-score.js';

const minimalValidBundle = {
  version: 'v2026-05-16',
  alert_type: 'lottery' as const,
  trained_on_date: '2026-05-16',
  win_label_threshold_pct: 20,
  xgb_json_schema: '2.1',
  feature_cols: ['dte', 'trigger_vol_to_oi_window'],
  top_tickers: ['SPY', 'QQQ'],
  categorical_cols: ['option_type'],
  feature_derivation_constants: { AGGRESSIVE_ASK_PCT_THRESHOLD: 0.7 },
  xgb_model: {
    learner: {
      learner_model_param: { base_score: '0.5' },
      gradient_booster: {
        model: {
          trees: [
            {
              left_children: [-1],
              right_children: [-1],
              split_indices: [0],
              split_conditions: [0.5],
              default_left: [1],
              base_weights: [0.1],
            },
          ],
        },
      },
    },
  },
  isotonic: {
    x_thresholds: [0, 0.5, 1],
    y_thresholds: [0, 0.5, 1],
  },
};

describe('validateBundle', () => {
  it('accepts a minimal valid bundle', () => {
    expect(() => validateBundle(minimalValidBundle)).not.toThrow();
  });

  it('throws BundleSchemaError on a missing required field', () => {
    const broken = { ...minimalValidBundle } as Record<string, unknown>;
    delete broken.feature_cols;
    expect(() => validateBundle(broken)).toThrow(BundleSchemaError);
  });

  it('throws BundleSchemaError when isotonic arrays have different lengths', () => {
    const broken = {
      ...minimalValidBundle,
      isotonic: { x_thresholds: [0, 1], y_thresholds: [0, 0.5, 1] },
    };
    expect(() => validateBundle(broken)).toThrow(BundleSchemaError);
  });

  it('throws BundleSchemaError when the trees array is empty', () => {
    const broken = {
      ...minimalValidBundle,
      xgb_model: {
        learner: {
          learner_model_param: { base_score: '0.5' },
          gradient_booster: { model: { trees: [] } },
        },
      },
    };
    expect(() => validateBundle(broken)).toThrow(BundleSchemaError);
  });

  it('throws BundleSchemaError on unknown alert_type', () => {
    const broken = { ...minimalValidBundle, alert_type: 'something_else' };
    expect(() => validateBundle(broken)).toThrow(BundleSchemaError);
  });

  it('accepts optional metrics_snapshot', () => {
    const withMetrics = {
      ...minimalValidBundle,
      metrics_snapshot: { oof_auc: 0.77, n_train_rows: 1000 },
    };
    expect(() => validateBundle(withMetrics)).not.toThrow();
  });
});

// Smoke-test that the schema is exported correctly.
describe('TakeitBundleSchema export', () => {
  it('is a Zod object schema', () => {
    expect(typeof TakeitBundleSchema.safeParse).toBe('function');
  });
});
