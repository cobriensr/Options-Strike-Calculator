// @vitest-environment node

import { describe, it, expect } from 'vitest';

import {
  PLOT_CALIBRATIONS,
  getPlotCalibration,
} from '../_lib/plot-analysis-calibration.js';

describe('plot-analysis-calibration.ts', () => {
  // ============================================================
  // PLOT_CALIBRATIONS
  // ============================================================
  describe('PLOT_CALIBRATIONS', () => {
    it('contains all expected plot names', () => {
      const expectedPlots = [
        'correlations',
        'range_by_regime',
        'flow_reliability',
        'gex_vs_range',
        'timeline',
        'structure_confidence',
        'day_of_week',
        'stationarity',
        'failure_heatmap',
        'dark_pool_vs_range',
        'cone_consumption',
        'prev_day_transition',
        'confidence_over_time',
        'feature_importance_comparison',
        'backtest_equity',
        'clusters_pca',
        'clusters_heatmap',
        'phase2_shap',
        'pin_settlement',
        'pin_time_decay',
        'pin_composite',
        'structure_by_vix',
        'rolling_accuracy',
        'flow_by_vix',
        'pnl_distribution',
        'cluster_transitions',
        'flow_q1_distributions',
        'flow_q2_time_of_day',
        'flow_q3_directional',
        'flow_q4_returns_by_rule',
        'flow_q5_premium_vs_return',
        'nope_direction_by_sign',
        'nope_mt_agreement',
        'nope_flips_vs_range',
        'nope_cumdelta_vs_move',
        'nope_magnitude_vs_move',
      ];

      for (const name of expectedPlots) {
        expect(PLOT_CALIBRATIONS).toHaveProperty(name);
      }
      expect(Object.keys(PLOT_CALIBRATIONS)).toHaveLength(expectedPlots.length);
    });

    it('has string values for every key', () => {
      for (const [key, value] of Object.entries(PLOT_CALIBRATIONS)) {
        expect(typeof value).toBe('string');
        // Currently all calibrations are empty strings
        expect(value).toBe('');
        // Verify key is a non-empty string
        expect(key.length).toBeGreaterThan(0);
      }
    });
  });

  // ============================================================
  // getPlotCalibration
  // ============================================================
  describe('getPlotCalibration', () => {
    it('returns empty string for a known plot with no calibration', () => {
      const result = getPlotCalibration('correlations');
      expect(result).toBe('');
    });

    it('returns empty string for an unknown plot name', () => {
      const result = getPlotCalibration('nonexistent_plot');
      expect(result).toBe('');
    });

    it('returns empty string for empty string input', () => {
      const result = getPlotCalibration('');
      expect(result).toBe('');
    });

    it('returns the calibration value when one exists', () => {
      // Temporarily set a calibration value to test retrieval
      const original = PLOT_CALIBRATIONS['correlations'];
      PLOT_CALIBRATIONS['correlations'] =
        'Gold standard analysis for correlations plot';

      const result = getPlotCalibration('correlations');
      expect(result).toBe('Gold standard analysis for correlations plot');

      // Restore original value
      PLOT_CALIBRATIONS['correlations'] = original!;
    });

    it('returns values for all known plot names', () => {
      for (const key of Object.keys(PLOT_CALIBRATIONS)) {
        const result = getPlotCalibration(key);
        expect(typeof result).toBe('string');
      }
    });
  });
});
