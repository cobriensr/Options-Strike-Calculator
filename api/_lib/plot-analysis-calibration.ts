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
  trace_error_distribution: '',
  trace_predicted_vs_actual: '',
  trace_accuracy_by_confidence: '',
  trace_accuracy_by_vix_regime: '',
  trace_signal_strength: '',
  trace_rolling_error: '',
  trace_error_vs_range: '',
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
};

export function getPlotCalibration(plotName: string): string {
  return PLOT_CALIBRATIONS[plotName] ?? '';
}
