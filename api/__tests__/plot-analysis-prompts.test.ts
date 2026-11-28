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
  // Options-volume feature groups: what a 10:00 CT model may read
  // ============================================================
  describe('options-volume feature groups', () => {
    const MORNING_SAFE = [
      'opt_call_oi',
      'opt_put_oi',
      'opt_oi_pcr',
      'prev_day_opt_call_volume',
      'prev_day_opt_put_volume',
      'prev_day_opt_call_premium',
      'prev_day_opt_put_premium',
      'prev_day_opt_bullish_premium',
      'prev_day_opt_bearish_premium',
      'prev_day_opt_call_vol_ask',
      'prev_day_opt_put_vol_bid',
      'prev_day_opt_vol_pcr',
      'prev_day_opt_premium_ratio',
      'prev_day_opt_call_vol_vs_avg30',
      'prev_day_opt_put_vol_vs_avg30',
    ];
    const END_OF_DAY = [
      'opt_call_volume',
      'opt_put_volume',
      'opt_call_premium',
      'opt_put_premium',
      'opt_bullish_premium',
      'opt_bearish_premium',
      'opt_call_vol_ask',
      'opt_put_vol_bid',
      'opt_vol_pcr',
      'opt_premium_ratio',
      'opt_call_vol_vs_avg30',
      'opt_put_vol_vs_avg30',
    ];

    /** One feature group's text: its heading line to the blank line after it. */
    function featureGroup(name: string): string {
      const start = PLOT_ANALYSIS_SYSTEM_PROMPT.indexOf(`\n${name} (`);
      expect(start).toBeGreaterThan(-1);
      const end = PLOT_ANALYSIS_SYSTEM_PROMPT.indexOf('\n\n', start + 1);
      expect(end).toBeGreaterThan(start);
      return PLOT_ANALYSIS_SYSTEM_PROMPT.slice(start, end);
    }

    /** Whether `column` is named in `text`, not just as the tail of another name. */
    function names(text: string, column: string): boolean {
      return new RegExp(`(?<![A-Za-z0-9_])${column}(?![A-Za-z0-9_])`).test(
        text,
      );
    }

    function plotBlock(name: string): string {
      const start = PLOT_ANALYSIS_SYSTEM_PROMPT.indexOf(
        `<plot_reference name="${name}">`,
      );
      expect(start).toBeGreaterThan(-1);
      const end = PLOT_ANALYSIS_SYSTEM_PROMPT.indexOf(
        '</plot_reference>',
        start,
      );
      return PLOT_ANALYSIS_SYSTEM_PROMPT.slice(start, end);
    }

    it('names both groups, each once as a heading', () => {
      for (const group of [
        'OPTIONS_VOLUME_FEATURES',
        'OPTIONS_VOLUME_EOD_FEATURES',
      ]) {
        expect(PLOT_ANALYSIS_SYSTEM_PROMPT.split(`\n${group} (`)).toHaveLength(
          2,
        );
      }
    });

    /** Every options-volume column named in a group's text, in order. */
    function optionsVolumeTokens(group: string): string[] {
      return group.match(/(?<!\w)(?:prev_day_)?opt_[a-z0-9_]+/g) ?? [];
    }

    it('names exactly the 15 morning-safe columns in their group and exactly the 12 end-of-day columns in theirs, each once', () => {
      expect(
        optionsVolumeTokens(featureGroup('OPTIONS_VOLUME_FEATURES')).sort(),
      ).toEqual([...MORNING_SAFE].sort());
      expect(
        optionsVolumeTokens(featureGroup('OPTIONS_VOLUME_EOD_FEATURES')).sort(),
      ).toEqual([...END_OF_DAY].sort());
    });

    it('leaves the previous day’s open interest out of both groups', () => {
      for (const group of [
        featureGroup('OPTIONS_VOLUME_FEATURES'),
        featureGroup('OPTIONS_VOLUME_EOD_FEATURES'),
      ]) {
        for (const column of [
          'prev_day_opt_call_oi',
          'prev_day_opt_put_oi',
          'prev_day_opt_oi_pcr',
        ]) {
          expect(names(group, column), column).toBe(false);
        }
      }
    });

    it('puts today’s open interest and the previous day’s twelve in the morning-safe group, known at 10:00 CT', () => {
      const group = featureGroup('OPTIONS_VOLUME_FEATURES');

      expect(group).toContain('all known at 10:00 CT');
      expect(group).toContain(
        'the only options-volume features the ML models read',
      );
      for (const column of MORNING_SAFE) {
        expect(names(group, column), column).toBe(true);
      }
      for (const column of END_OF_DAY) {
        expect(names(group, column), column).toBe(false);
      }
    });

    it('puts the same-day totals in the end-of-day group, known only after the close and for research only', () => {
      const group = featureGroup('OPTIONS_VOLUME_EOD_FEATURES');

      expect(group).toContain('known only after the close');
      expect(group).toContain('no ML model reads them');
      expect(group).toContain('after-the-fact research only');
      for (const column of END_OF_DAY) {
        expect(names(group, column), column).toBe(true);
      }
      for (const column of MORNING_SAFE) {
        expect(names(group, column), column).toBe(false);
      }
    });

    it('tells the analysis not to present an end-of-day total as a morning signal', () => {
      expect(featureGroup('OPTIONS_VOLUME_EOD_FEATURES')).toContain(
        'not a signal anyone had at 10:00 CT',
      );
    });

    it('describes both premium ratios as bullish / (bullish + bearish), not call / put premium', () => {
      for (const group of [
        featureGroup('OPTIONS_VOLUME_FEATURES'),
        featureGroup('OPTIONS_VOLUME_EOD_FEATURES'),
      ]) {
        const line = group.split('\n').find((l) => /premium_ratio —/.test(l));
        expect(line).toBeDefined();
        expect(line).toContain('bullish / (bullish + bearish) premium');
        expect(line).toContain('not a call premium / put premium ratio');
      }
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).not.toContain(
        'Call premium / put premium ratio. Values > 1',
      );
    });

    it('lists the feature groups in order, with the other groups’ headings as they were', () => {
      const start = PLOT_ANALYSIS_SYSTEM_PROMPT.indexOf('<feature_groups>');
      const end = PLOT_ANALYSIS_SYSTEM_PROMPT.indexOf('</feature_groups>');
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const headings = PLOT_ANALYSIS_SYSTEM_PROMPT.slice(start, end)
        .split('\n')
        .filter((line) => /^[A-Z][A-Z0-9_]*[ :]/.test(line));

      expect(
        headings.map((line) => /^[A-Z][A-Z0-9_]*/.exec(line)?.[0]),
      ).toEqual([
        'VOLATILITY_FEATURES',
        'GEX_FEATURES_T1T2',
        'GREEK_FEATURES_CORE',
        'DARK_POOL_FEATURES',
        'OPTIONS_VOLUME_FEATURES',
        'OPTIONS_VOLUME_EOD_FEATURES',
        'IV_PCR_FEATURES',
        'MAX_PAIN_FEATURES',
        'OI_CHANGE_FEATURES',
        'VOL_SURFACE_FEATURES',
      ]);
      // Every heading but the two options-volume ones, word for word.
      expect(
        headings.filter((line) => !line.startsWith('OPTIONS_VOLUME')),
      ).toEqual([
        'VOLATILITY_FEATURES:',
        'GEX_FEATURES_T1T2 (Gamma Exposure at checkpoint 1 and 2):',
        'GREEK_FEATURES_CORE:',
        'DARK_POOL_FEATURES:',
        'IV_PCR_FEATURES:',
        'MAX_PAIN_FEATURES:',
        'OI_CHANGE_FEATURES:',
        'VOL_SURFACE_FEATURES:',
      ]);
    });

    // The plot source blocks are hand-copied from ml/src/visualize.py and
    // clustering.py (see the drift note in plot-analysis-prompts.ts). These
    // pin the lines the phase 3a and 3b changes touched.
    describe('plot source blocks track the Python they copy', () => {
      it('clusters_heatmap reads the previous day’s PCR, as clustering.py does', () => {
        const block = plotBlock('clusters_heatmap');
        const summary = block.slice(
          block.indexOf('summary_features = ['),
          block.indexOf(']', block.indexOf('summary_features = [')),
        );

        expect(summary).toContain('"prev_day_opt_vol_pcr"');
        expect(summary).not.toContain('"opt_vol_pcr"');
        expect(block).toContain(
          'previous-day Options PCR (prev_day_opt_vol_pcr',
        );
      });

      it('correlations labels the two same-day columns EOD, as visualize.py does', () => {
        const block = plotBlock('correlations');

        expect(block).toContain('"opt_vol_pcr": "Opt PCR (EOD)"');
        expect(block).toContain('"opt_premium_ratio": "Prem Ratio (EOD)"');
        expect(block).not.toContain('"Opt PCR"');
        expect(block).not.toContain('"Prem Ratio"');
        expect(block).toContain('End-of-Day Options');
      });

      it('correlations says the two same-day columns are research columns and their correlation with the range is hindsight', () => {
        const block = plotBlock('correlations');

        expect(block).toContain('Of the 24 columns, 21 are model features');
        expect(block).toContain('day_range_pts is the outcome');
        expect(block).toContain(
          'opt_vol_pcr and opt_premium_ratio (labeled EOD) are same-day end-of-day totals that no ML model reads',
        );
        expect(block).toContain(
          'That is hindsight, not a relationship a model or a 10:00 CT trade can exploit.',
        );
      });

      it('stationarity labels the PCR panel end of day and titles it, as visualize.py does', () => {
        const block = plotBlock('stationarity');

        expect(block).toContain('"opt_vol_pcr": ("Options PCR (end of day)"');
        expect(block).toContain('End-of-day total: not known at 10:00 CT');
        // The description sentence, in the plot's feature_context.
        expect(block).toContain(
          'end-of-day total, so it carries its own title saying it is not known at 10:00 CT',
        );
      });
    });
  });

  // ============================================================
  // Claims the 2026-11-27 re-checks did not support
  // (docs/tmp/prompt-check-pcr-2026-11-27.md)
  // ============================================================
  describe('PCR trend and pipeline claims', () => {
    /** The IV_PCR_FEATURES group: its heading line to the blank line after. */
    function ivPcrGroup(): string {
      const start = PLOT_ANALYSIS_SYSTEM_PROMPT.indexOf('\nIV_PCR_FEATURES:\n');
      expect(start).toBeGreaterThan(-1);
      const end = PLOT_ANALYSIS_SYSTEM_PROMPT.indexOf('\n\n', start + 1);
      return PLOT_ANALYSIS_SYSTEM_PROMPT.slice(start, end);
    }

    it('says the pcr_trend_t1_t2 split did not hold, and gives no direction', () => {
      const line = ivPcrGroup()
        .split('\n')
        .find((l) => l.includes('pcr_trend_t1_t2'));

      expect(line).toBe(
        '  pcr_trend_t1_t2 — the PCR direction from checkpoint 1 to 2. A 64%/31% UP split on the first 27 days did not hold on 175 days (57% vs 52%, p = 0.65), so it carries no directional signal.',
      );
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).not.toContain('64% UP settlement');
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).not.toContain(
        'Rising PCR associated',
      );
    });

    it('leaves the other IV_PCR_FEATURES lines as they were', () => {
      // The slice starts at the newline before the heading: '' then the heading.
      const lines = ivPcrGroup().split('\n').slice(2);

      expect(lines.map((l) => l.split(' — ')[0])).toEqual([
        '  iv_open',
        '  iv_max',
        '  iv_range',
        '  iv_crush_rate',
        '  iv_spike_count',
        '  iv_at_t2',
        '  pcr_open through pcr_spike_count',
        '  pcr_trend_t1_t2',
      ]);
      expect(lines[0]).toBe('  iv_open — Implied volatility at market open.');
    });

    it('no longer says the pipeline feeds the live prompt as calibration data', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).not.toContain(
        'feed back into the live prompt',
      );
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).toContain(
        "the live analysis no longer reads the pipeline's findings",
      );
    });
  });

  // ============================================================
  // Guidance that took the old Tier 1 / Tier 2 hierarchy as correct
  // (docs/superpowers/specs/2026-11-27-analyze-prev-day-range-vix-design.md)
  // ============================================================
  describe('guidance does not presume the live hierarchy', () => {
    /** The analysis_guidance text of one plot_reference block. */
    function guidance(name: string): string {
      const start = PLOT_ANALYSIS_SYSTEM_PROMPT.indexOf(
        `<plot_reference name="${name}">`,
      );
      expect(start).toBeGreaterThan(-1);
      const end = PLOT_ANALYSIS_SYSTEM_PROMPT.indexOf(
        '</plot_reference>',
        start,
      );
      const block = PLOT_ANALYSIS_SYSTEM_PROMPT.slice(start, end);
      const open = block.indexOf('<analysis_guidance>');
      const close = block.indexOf('</analysis_guidance>');
      expect(open).toBeGreaterThan(-1);
      return block.slice(open + '<analysis_guidance>'.length, close);
    }

    it('names no Tier 1, 2 or 3 anywhere in the prompt', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT).not.toMatch(/Tier [123]/);
    });

    it('prev_day_transition asks whether range persistence survives once VIX is known', () => {
      const g = guidance('prev_day_transition');

      expect(g).toContain(
        'A wide-range day often follows a high-VIX day, so also ask whether the persistence survives once VIX is known: compare days at a similar VIX level before calling it an effect',
      );
      expect(g).toContain(
        'report what the plot shows, without assuming that prev_day_range_pts predicts failures',
      );
      expect(g).toContain('whether that holds once the VIX level is known');
      expect(g).not.toContain('as a Tier 1 predictor');
      expect(g).not.toContain('would confirm VIX change as a caution signal');
    });

    it('feature_importance_comparison asks which features rank on top, not whether the hierarchy holds', () => {
      const g = guidance('feature_importance_comparison');

      expect(g).toContain(
        'which features rank at the top, and whether gamma_asymmetry and gex_vol (which the live system prompt treats as context only) deserve more weight than that',
      );
      expect(g).toContain('do not assume either belongs near the top');
      expect(g).not.toContain('signal hierarchy in the live system prompt');
      expect(g).not.toContain('if the hierarchy is correct');
    });

    it('flow_by_vix asks whether the plot supports a different ranking by VIX bucket', () => {
      const g = guidance('flow_by_vix');

      expect(g).toContain(
        'say whether the plot supports ranking the sources differently by VIX bucket, without assuming the live prompt ranking is right.',
      );
      expect(g).not.toContain('signal hierarchy needs conditional branching');
    });

    it('nope_mt_agreement asks whether the plot supports the conjunction claim', () => {
      const g = guidance('nope_mt_agreement');

      expect(g).toContain(
        'the conjunction filter may add real value and would be worth testing as a live-prompt signal; say whether the plot supports that claim, given its sample sizes',
      );
      expect(g).not.toContain('should be implemented as a');
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
      // Should have one per plot (36 total)
      expect(matches).not.toBeNull();
      expect(matches!.length).toBe(36);
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

    it('is under 120K characters (sanity cap)', () => {
      expect(PLOT_ANALYSIS_SYSTEM_PROMPT.length).toBeLessThan(120_000);
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
        structure_by_vix: '',
        rolling_accuracy: '',
        flow_by_vix: '',
        pnl_distribution: '',
        cluster_transitions: '',
        flow_q1_distributions: '',
        flow_q2_time_of_day: '',
        flow_q3_directional: '',
        flow_q4_returns_by_rule: '',
        flow_q5_premium_vs_return: '',
        nope_direction_by_sign: '',
        nope_mt_agreement: '',
        nope_flips_vs_range: '',
        nope_cumdelta_vs_move: '',
        nope_magnitude_vs_move: '',
      },
    }));

    const { PLOT_ANALYSIS_SYSTEM_PROMPT: prompt } =
      await import('../_lib/plot-analysis-prompts.js');

    // The correlations block should have a filled calibration tag
    expect(prompt).toContain(
      '<calibration_example>Gold standard correlations analysis</calibration_example>',
    );

    // Other plots should still use the self-closing tag
    // 36 total plots - 1 filled (correlations) = 35 self-closing
    const selfClosing = prompt.match(/<calibration_example\/>/g);
    expect(selfClosing).not.toBeNull();
    expect(selfClosing!.length).toBe(35);
  });
});
