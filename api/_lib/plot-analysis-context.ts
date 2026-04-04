/**
 * Plot reference metadata and findings data slicing for ML plot analysis.
 *
 * Maps each plot to the relevant sections of findings.json so the
 * user message sent to Claude contains only the data pertinent to
 * the plot being analyzed.
 */

export interface PlotReference {
  /** Which findings.json keys contain data relevant to this plot */
  findingsKeys: string[];
  /** Brief description for the user message */
  description: string;
}

/** Maps plot filename (without .png) to its metadata */
export const PLOT_REFERENCES: Record<string, PlotReference> = {
  correlations: {
    findingsKeys: ['eda', 'top_correctness_predictors', 'top_range_predictors'],
    description:
      'Feature correlation heatmap of 24 key ML features across ' +
      'volatility, GEX, flow, dark pool, options volume, and IV groups',
  },
  range_by_regime: {
    findingsKeys: ['eda', 'top_range_predictors'],
    description:
      'Box plots of SPX day range (pts) segmented by charm pattern, ' +
      'VIX regime, and GEX OI regime with individual day swarm overlay',
  },
  flow_reliability: {
    findingsKeys: ['flow_reliability'],
    description:
      'Horizontal bar chart ranking 7 flow sources by directional ' +
      'prediction accuracy with Wilson confidence intervals',
  },
  gex_vs_range: {
    findingsKeys: ['eda', 'top_correctness_predictors'],
    description:
      'Scatter plot of GEX OI (billions) vs day range (pts), ' +
      'dual-panel colored by charm pattern and structure correctness',
  },
  timeline: {
    findingsKeys: ['eda', 'structure_accuracy', 'confidence_calibration'],
    description:
      '4-panel daily timeline: range bars with structure labels, ' +
      'VIX/VIX1D lines, GEX OI bars, and flow agreement bars ' +
      'with red shading on failure days',
  },
  structure_confidence: {
    findingsKeys: ['structure_accuracy', 'confidence_calibration'],
    description:
      'Dual-panel: stacked bar of structure accuracy (PCS/CCS/IC) ' +
      'and bar chart of confidence calibration (HIGH/MODERATE/LOW) ' +
      'with Wilson CIs',
  },
  day_of_week: {
    findingsKeys: ['eda'],
    description:
      'Box plot of day range by day of week (Mon-Fri) with ' +
      'mean/median annotations and individual day swarm overlay',
  },
  stationarity: {
    findingsKeys: ['eda', 'top_range_predictors'],
    description:
      'Multi-panel rolling mean chart for VIX, GEX OI, day range, ' +
      'flow agreement, DP premium, options PCR, and IV open to ' +
      'assess feature stationarity over the dataset window',
  },
  failure_heatmap: {
    findingsKeys: ['eda', 'structure_accuracy', 'top_correctness_predictors'],
    description:
      '2D heatmap of structure accuracy by GEX OI regime (x) ' +
      'and VIX regime (y) with cell annotations showing accuracy ' +
      'rate and sample size',
  },
  dark_pool_vs_range: {
    findingsKeys: ['eda', 'top_correctness_predictors'],
    description:
      'Dual scatter: dark pool total premium ($B) vs day range, ' +
      'colored by support/resistance ratio and by structure correctness',
  },
  cone_consumption: {
    findingsKeys: ['eda', 'top_correctness_predictors'],
    description:
      'Dual-panel: histogram of opening range cone % consumed at ' +
      'entry by correctness, and bar chart of accuracy by cone ' +
      'consumption bucket',
  },
  prev_day_transition: {
    findingsKeys: ['eda', 'top_correctness_predictors'],
    description:
      'Dual scatter: previous day range vs today range, and ' +
      'previous day VIX change vs today range, with failure markers',
  },
  confidence_over_time: {
    findingsKeys: ['confidence_calibration', 'structure_accuracy'],
    description:
      'Rolling accuracy time series (overall, HIGH, MODERATE) ' +
      'with failure markers and 90% target reference line',
  },
  feature_importance_comparison: {
    findingsKeys: ['top_correctness_predictors', 'phase2'],
    description:
      'Side-by-side: EDA point-biserial correlation ranking vs ' +
      'XGBoost gain ranking for top features, with cyan border ' +
      'highlighting features that appear in both lists',
  },
  backtest_equity: {
    findingsKeys: ['backtest'],
    description:
      'Equity curve comparing Claude Analysis (confidence-sized), ' +
      'majority-class baseline (always CCS), and equal-size strategy ' +
      'with metrics box and max drawdown shading',
  },
  clusters_pca: {
    findingsKeys: ['clustering'],
    description:
      'PCA scatter (PC1 vs PC2) of day type clusters with 95% ' +
      'confidence ellipses, date annotations, and color-coded ' +
      'cluster assignments',
  },
  clusters_heatmap: {
    findingsKeys: ['clustering'],
    description:
      'Z-scored feature heatmap showing mean feature values per ' +
      'cluster for VIX, VIX1D/VIX ratio, GEX OI, flow agreement, ' +
      'charm slope, dark pool S/R ratio, options PCR, and IV open',
  },
  phase2_shap: {
    findingsKeys: ['phase2'],
    description:
      'SHAP beeswarm plot from XGBoost multiclass classifier ' +
      'showing top 15 feature contributions to structure prediction ' +
      'with color encoding feature value magnitude',
  },
  pin_settlement: {
    findingsKeys: ['pin_analysis'],
    description:
      'Scatter of proximity-weighted centroid prediction error vs ' +
      'absolute error, colored by confidence tier (HIGH/MEDIUM/LOW) ' +
      'with +/-10 and +/-20 pt reference bands',
  },
  pin_time_decay: {
    findingsKeys: ['pin_analysis'],
    description:
      'Line chart showing average distance from prox-centroid to ' +
      'settlement across 5 time checkpoints (T-4hr through final ' +
      'snapshot) demonstrating prediction improvement near close',
  },
  pin_composite: {
    findingsKeys: ['pin_analysis'],
    description:
      'Bar chart comparing always-0DTE, always-1DTE, and composite ' +
      '(concentration-gated) strategies by avg distance to settlement ' +
      'with +/-10 pt hit rates annotated',
  },
};

/** Get the findings data slice relevant to a specific plot */
export function getPlotFindings(
  plotName: string,
  findings: Record<string, unknown>,
): Record<string, unknown> {
  const ref = PLOT_REFERENCES[plotName];
  if (!ref) return {};
  const slice: Record<string, unknown> = {};
  for (const key of ref.findingsKeys) {
    if (findings[key] !== undefined) slice[key] = findings[key];
  }
  // Always include dataset metadata
  if (findings['dataset']) slice['dataset'] = findings['dataset'];
  return slice;
}
