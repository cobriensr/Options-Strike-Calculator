/**
 * Calibration examples for ML plot analysis.
 *
 * Initially empty -- populated after the first pipeline run when the
 * developer reviews and edits the uncalibrated output into
 * gold-standard examples. Each entry maps a plot name to the ideal
 * analysis text that Claude should have produced, used as a few-shot
 * calibration signal inside the cached system prompt.
 */

export const PLOT_CALIBRATIONS: Record<string, string> = {
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
};

export function getPlotCalibration(plotName: string): string {
  return PLOT_CALIBRATIONS[plotName] ?? '';
}
