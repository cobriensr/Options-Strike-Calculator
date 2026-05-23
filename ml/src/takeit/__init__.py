"""Take-It Score: per-alert calibrated win-probability model.

Spec: docs/superpowers/specs/alert-takeit-score-2026-05-16.md

Win label: peak_ceiling_pct >= WIN_LABEL_THRESHOLD_PCT (default 20).
Rows where peak_ceiling_pct IS NULL are dropped from training.
"""

from .config import (
    AGGRESSIVE_ASK_PCT_THRESHOLD,
    BRIER_ALERT_THRESHOLD,
    BURST_STORM_MIN_COFIRES,
    BURST_STORM_WINDOW_MIN,
    COFIRE_WINDOW_MIN,
    ISOTONIC_HOLDOUT_FRAC,
    SHAP_TOP_K,
    TOP_N_TICKERS,
    WALK_FORWARD_FOLDS,
    WIN_LABEL_THRESHOLD_PCT,
    XGB_PARAMS,
)

__all__ = [
    "AGGRESSIVE_ASK_PCT_THRESHOLD",
    "BRIER_ALERT_THRESHOLD",
    "BURST_STORM_MIN_COFIRES",
    "BURST_STORM_WINDOW_MIN",
    "COFIRE_WINDOW_MIN",
    "ISOTONIC_HOLDOUT_FRAC",
    "SHAP_TOP_K",
    "TOP_N_TICKERS",
    "WALK_FORWARD_FOLDS",
    "WIN_LABEL_THRESHOLD_PCT",
    "XGB_PARAMS",
]
