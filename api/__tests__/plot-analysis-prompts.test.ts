// @vitest-environment node

import { describe, it, expect, vi } from 'vitest';

// Mock the calibration module so we can control calibration values
vi.mock('../_lib/plot-analysis-calibration.js', () => ({
  PLOT_CALIBRATIONS: {
    correlations: '',
    range_by_regime: '',
    flow_reliability: '',
    gex_vs_range: '',
    timeline: '',
    structure_confidence: '',
    day_of_week: '',
    stationarity: '',
    failure_heatmap: '',
    dark_pool_vs_range: '',
    cone_consumption: '',
    prev_day_transition: '',
    confidence_over_time: '',
    feature_importance_comparison: '',
    backtest_equity: '',
    clusters_pca: '',
    clusters_heatmap: '',
    phase2_shap: '',
    pin_settlement: '',
    pin_time_decay: '',
    pin_composite: '',
  },
}));

import { PLOT_ANALYSIS_SYSTEM_PROMPT } from '../_lib/plot-analysis-prompts.js';

describe('plot-analysis-prompts.ts', () => {
  // ============================================================
  // PLOT_ANALYSIS_SYSTEM_PROMPT — structural checks
  // ============================================================
  describe('PLOT_ANALYSIS_SYSTEM_PROMPT', () => {
    it('is a non-empty string', () => {
      expect(typeof PLOT_ANALYSIS_SYSTEM_PROMPT).toBe('string');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    });

    it('starts with the ML pipeline analyst role', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain(
        'You are an ML pipeline analyst',
      );
    });

    it('contains the current_date tag', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toMatch(
        /<current_date>\d{4}-\d{2}-\d{2}<\/current_date>/,
      );
    });

    it('contains the important_context section', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('<important_context>');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('The current year is 2026');
    });

    it('contains the deduplication_directive', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain(
        '<deduplication_directive>',
      );
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain(
        'Each plot analysis should be self-contained',
      );
    });

    it('contains the trading_system_context section', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('<trading_system_context>');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('PUT CREDIT SPREAD (PCS)');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('CALL CREDIT SPREAD (CCS)');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('IRON CONDOR (IC)');
    });

    it('contains the analysis_framework with 3 questions', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('<analysis_framework>');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('WHAT DOES THE DATA MEAN?');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain(
        'HOW SHOULD I APPLY THIS TO MY TRADING?',
      );
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain(
        'WHAT SHOULD I WATCH OUT FOR?',
      );
    });

    it('contains the uncertainty_directive', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('<uncertainty_directive>');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain(
        'The source code and underlying data are ground truth',
      );
    });

    it('contains feature_groups definitions', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('<feature_groups>');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('VOLATILITY_FEATURES');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('GEX_FEATURES_T1T2');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('DARK_POOL_FEATURES');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('OPTIONS_VOLUME_FEATURES');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('IV_PCR_FEATURES');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('MAX_PAIN_FEATURES');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('OI_CHANGE_FEATURES');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('VOL_SURFACE_FEATURES');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('GREEK_FEATURES_CORE');
    });

    it('contains the output_format with required JSON fields', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('<output_format>');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('"what_it_means"');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('"how_to_apply"');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('"watch_out_for"');
    });
  });

  // ============================================================
  // Plot reference blocks — all 21 must be present
  // ============================================================
  describe('plot reference blocks', () => {
    const allPlots = [
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

    it('contains a plot_reference block for every plot', () => {
      for (const name of allPlots) {
        expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain(
          `<plot_reference name="${name}">`,
        );
      }
    });

    it('each plot_reference block contains source_code', () => {
      for (const name of allPlots) {
        const blockStart = PLOT_ANALYSIS_SYSTEM_PROMPT.indexOf(
          `<plot_reference name="${name}">`,
        );
        expect(blockStart).toBeGreaterThan(-1);

        // Find the end of this block
        const blockEnd = PLOT_ANALYSIS_SYSTEM_PROMPT.indexOf(
          '</plot_reference>',
          blockStart,
        );
        expect(blockEnd).toBeGreaterThan(blockStart);

        const block = PLOT_ANALYSIS_SYSTEM_PROMPT.slice(blockStart, blockEnd);
        expect(block).toContain('<source_code>');
        expect(block).toContain('</source_code>');
      }
    });

    it('each plot_reference block contains feature_context', () => {
      for (const name of allPlots) {
        const blockStart = PLOT_ANALYSIS_SYSTEM_PROMPT.indexOf(
          `<plot_reference name="${name}">`,
        );
        const blockEnd = PLOT_ANALYSIS_SYSTEM_PROMPT.indexOf(
          '</plot_reference>',
          blockStart,
        );
        const block = PLOT_ANALYSIS_SYSTEM_PROMPT.slice(blockStart, blockEnd);
        expect(block).toContain('<feature_context>');
        expect(block).toContain('</feature_context>');
      }
    });

    it('each plot_reference block contains analysis_guidance', () => {
      for (const name of allPlots) {
        const blockStart = PLOT_ANALYSIS_SYSTEM_PROMPT.indexOf(
          `<plot_reference name="${name}">`,
        );
        const blockEnd = PLOT_ANALYSIS_SYSTEM_PROMPT.indexOf(
          '</plot_reference>',
          blockStart,
        );
        const block = PLOT_ANALYSIS_SYSTEM_PROMPT.slice(blockStart, blockEnd);
        expect(block).toContain('<analysis_guidance>');
        expect(block).toContain('</analysis_guidance>');
      }
    });

    it('each plot_reference block contains a calibration tag', () => {
      for (const name of allPlots) {
        const blockStart = PLOT_ANALYSIS_SYSTEM_PROMPT.indexOf(
          `<plot_reference name="${name}">`,
        );
        const blockEnd = PLOT_ANALYSIS_SYSTEM_PROMPT.indexOf(
          '</plot_reference>',
          blockStart,
        );
        const block = PLOT_ANALYSIS_SYSTEM_PROMPT.slice(blockStart, blockEnd);
        // When calibration is empty, self-closing tag is used
        expect(block).toContain('<calibration_example/>');
      }
    });
  });

  // ============================================================
  // Source code content — spot-check key plots
  // ============================================================
  describe('source code content in prompt', () => {
    it('correlations block contains heatmap code', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('plot_correlation_heatmap');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('sns.heatmap');
    });

    it('range_by_regime block contains boxplot code', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('plot_range_by_regime');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('sns.boxplot');
    });

    it('flow_reliability block contains source rankings', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('plot_flow_reliability');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('SPY ETF Tide');
    });

    it('backtest_equity block contains equity curve code', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('plot_equity_curves');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('Claude Analysis');
    });

    it('phase2_shap block contains SHAP code', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('generate_shap_plot');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('shap.TreeExplainer');
    });

    it('pin_settlement block contains scatter code', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain(
        'Prox-Centroid vs Settlement',
      );
    });

    it('pin_time_decay block contains checkpoint data', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('T-4hr (12:00 ET)');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain(
        'Settlement Prediction Improves Near Close',
      );
    });

    it('pin_composite block contains strategy comparison', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('Composite (conc-gated)');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('gamma concentration');
    });

    it('clusters_pca block contains PCA code', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('_draw_confidence_ellipse');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain('PCA(n_components=0.85');
    });

    it('clusters_heatmap block contains z-score code', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain(
        'Cluster Feature Profiles (z-scored)',
      );
    });
  });

  // ============================================================
  // Calibration integration
  // ============================================================
  describe('calibration integration', () => {
    it('uses self-closing calibration tag when calibration is empty', () => {
      // All calibrations are empty in our mock
      const matches = PLOT_ANALYSIS_SYSTEM_PROMPT.match(
        /<calibration_example\/>/g,
      );
      // Should have one per plot (33 total)
      expect(matches).not.toBeNull();
      expect(matches!.length).toBe(33);
    });

    it('does not contain filled calibration example tags when all empty', () => {
      // With empty calibrations, there should be no
      // <calibration_example>...</calibration_example> blocks
      const filledPattern = /<calibration_example>[^<]+<\/calibration_example>/;
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).not.toMatch(filledPattern);
    });
  });

  // ============================================================
  // Prompt size sanity check
  // ============================================================
  describe('prompt size', () => {
    it('is a substantial prompt (over 10K characters)', () => {
      // The prompt includes all source code + guidance + framework
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT.length).toBeGreaterThan(10_000);
    });

    it('is under 100K characters (sanity cap)', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT.length).toBeLessThan(100_000);
    });
  });
});

// ============================================================
// Separate suite: non-empty calibration branch
// ============================================================
describe('plot-analysis-prompts.ts (with calibration)', () => {
  it('uses filled calibration tag when calibration is non-empty', async () => {
    // Reset modules so the prompt const is re-evaluated
    vi.resetModules();

    vi.doMock('../_lib/plot-analysis-calibration.js', () => ({
      PLOT_CALIBRATIONS: {
        correlations: 'Gold standard correlations analysis',
        range_by_regime: '',
        flow_reliability: '',
        gex_vs_range: '',
        timeline: '',
        structure_confidence: '',
        day_of_week: '',
        stationarity: '',
        failure_heatmap: '',
        dark_pool_vs_range: '',
        cone_consumption: '',
        prev_day_transition: '',
        confidence_over_time: '',
        feature_importance_comparison: '',
        backtest_equity: '',
        clusters_pca: '',
        clusters_heatmap: '',
        phase2_shap: '',
        pin_settlement: '',
        pin_time_decay: '',
        pin_composite: '',
      },
    }));

    const { PLOT_ANALYSIS_SYSTEM_PROMPT: prompt } =
      await import('../_lib/plot-analysis-prompts.js');

    // The correlations block should have a filled calibration tag
    expect(prompt).toContain(
      '<calibration_example>Gold standard correlations analysis</calibration_example>',
    );

    // Other plots should still use the self-closing tag
    // 32 empty calibrations + 1 filled = 32 self-closing
    const selfClosing = prompt.match(/<calibration_example\/>/g);
    expect(selfClosing).not.toBeNull();
    expect(selfClosing!.length).toBe(32);
  });
});
