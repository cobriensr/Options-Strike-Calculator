// @vitest-environment node

import { describe, it, expect } from 'vitest';

import {
  PLOT_REFERENCES,
  getPlotFindings,
} from '../_lib/plot-analysis-context.js';

describe('plot-analysis-context.ts', () => {
  // ============================================================
  // PLOT_REFERENCES
  // ============================================================
  describe('PLOT_REFERENCES', () => {
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
    ];

    it('contains all 21 expected plot names', () => {
      for (const name of expectedPlots) {
        expect(PLOT_REFERENCES).toHaveProperty(name);
      }
      expect(Object.keys(PLOT_REFERENCES)).toHaveLength(expectedPlots.length);
    });

    it('every entry has findingsKeys as a non-empty string array', () => {
      for (const [, ref] of Object.entries(PLOT_REFERENCES)) {
        expect(Array.isArray(ref.findingsKeys)).toBe(true);
        expect(ref.findingsKeys.length).toBeGreaterThan(0);
        for (const key of ref.findingsKeys) {
          expect(typeof key).toBe('string');
          expect(key.length).toBeGreaterThan(0);
        }
      }
    });

    it('every entry has a non-empty description string', () => {
      for (const [, ref] of Object.entries(PLOT_REFERENCES)) {
        expect(typeof ref.description).toBe('string');
        expect(ref.description.length).toBeGreaterThan(0);
      }
    });

    it('correlations references eda and both predictor keys', () => {
      const ref = PLOT_REFERENCES['correlations']!;
      expect(ref.findingsKeys).toEqual([
        'eda',
        'top_correctness_predictors',
        'top_range_predictors',
      ]);
    });

    it('backtest_equity references only backtest', () => {
      const ref = PLOT_REFERENCES['backtest_equity']!;
      expect(ref.findingsKeys).toEqual(['backtest']);
    });

    it('pin_analysis plots all reference pin_analysis key', () => {
      const pinPlots = ['pin_settlement', 'pin_time_decay', 'pin_composite'];
      for (const name of pinPlots) {
        expect(PLOT_REFERENCES[name]!.findingsKeys).toEqual(['pin_analysis']);
      }
    });

    it('clustering plots both reference clustering key', () => {
      expect(PLOT_REFERENCES['clusters_pca']!.findingsKeys).toEqual([
        'clustering',
      ]);
      expect(PLOT_REFERENCES['clusters_heatmap']!.findingsKeys).toEqual([
        'clustering',
      ]);
    });
  });

  // ============================================================
  // getPlotFindings
  // ============================================================
  describe('getPlotFindings', () => {
    const sampleFindings: Record<string, unknown> = {
      dataset: { days: 39, start: '2026-01-15', end: '2026-03-20' },
      eda: { feature_count: 100, rows: 39 },
      top_correctness_predictors: ['gex_vol_t1', 'charm_slope'],
      top_range_predictors: ['vix', 'gex_oi_t1'],
      flow_reliability: { spy_etf: 0.61, market_tide: 0.58 },
      structure_accuracy: { pcs: 0.92, ccs: 0.88, ic: 1.0 },
      confidence_calibration: { high: 0.96, moderate: 0.85 },
      backtest: { total_pnl: 4200, win_rate: 0.89 },
      clustering: { k: 3, silhouette: 0.42 },
      phase2: { accuracy: 0.75, top_features: ['vix1d'] },
      pin_analysis: { avg_error: 12.3, hit_rate_10: 0.45 },
    };

    it('returns matching findings keys for a known plot', () => {
      const result = getPlotFindings('correlations', sampleFindings);
      expect(result).toHaveProperty('eda');
      expect(result).toHaveProperty('top_correctness_predictors');
      expect(result).toHaveProperty('top_range_predictors');
    });

    it('always includes dataset metadata when present', () => {
      const result = getPlotFindings('correlations', sampleFindings);
      expect(result).toHaveProperty('dataset');
      expect(result['dataset']).toEqual(sampleFindings['dataset']);
    });

    it('includes dataset even for plots that do not reference it', () => {
      const result = getPlotFindings('backtest_equity', sampleFindings);
      expect(result).toHaveProperty('backtest');
      expect(result).toHaveProperty('dataset');
    });

    it('returns empty object for unknown plot name', () => {
      const result = getPlotFindings('nonexistent_plot', sampleFindings);
      expect(result).toEqual({});
    });

    it('returns empty object for empty string plot name', () => {
      const result = getPlotFindings('', sampleFindings);
      expect(result).toEqual({});
    });

    it('omits findings keys not present in the findings object', () => {
      const sparseFindings: Record<string, unknown> = {
        eda: { rows: 10 },
        // missing top_correctness_predictors, top_range_predictors
      };
      const result = getPlotFindings('correlations', sparseFindings);
      expect(result).toHaveProperty('eda');
      expect(result).not.toHaveProperty('top_correctness_predictors');
      expect(result).not.toHaveProperty('top_range_predictors');
      // No dataset in sparse findings, so should not be present
      expect(result).not.toHaveProperty('dataset');
    });

    it('returns only dataset when findings keys are all missing', () => {
      const onlyDataset: Record<string, unknown> = {
        dataset: { days: 5 },
      };
      const result = getPlotFindings('correlations', onlyDataset);
      expect(result).toEqual({ dataset: { days: 5 } });
    });

    it('handles empty findings object', () => {
      const result = getPlotFindings('correlations', {});
      expect(result).toEqual({});
    });

    it('slices correct keys for flow_reliability plot', () => {
      const result = getPlotFindings('flow_reliability', sampleFindings);
      expect(result).toHaveProperty('flow_reliability');
      expect(result).toHaveProperty('dataset');
      // Should NOT include keys from other plots
      expect(result).not.toHaveProperty('eda');
      expect(result).not.toHaveProperty('backtest');
    });

    it('slices correct keys for timeline plot', () => {
      const result = getPlotFindings('timeline', sampleFindings);
      expect(result).toHaveProperty('eda');
      expect(result).toHaveProperty('structure_accuracy');
      expect(result).toHaveProperty('confidence_calibration');
      expect(result).toHaveProperty('dataset');
    });

    it('slices correct keys for feature_importance_comparison', () => {
      const result = getPlotFindings(
        'feature_importance_comparison',
        sampleFindings,
      );
      expect(result).toHaveProperty('top_correctness_predictors');
      expect(result).toHaveProperty('phase2');
      expect(result).toHaveProperty('dataset');
      expect(result).not.toHaveProperty('eda');
    });

    it('preserves the original data references (no deep copy)', () => {
      const result = getPlotFindings('backtest_equity', sampleFindings);
      expect(result['backtest']).toBe(sampleFindings['backtest']);
    });
  });
});
