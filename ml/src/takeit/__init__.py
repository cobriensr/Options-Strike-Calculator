"""Take-It Score: per-alert calibrated win-probability model.

Spec: docs/superpowers/specs/alert-takeit-score-2026-05-16.md

Win label: peak_ceiling_pct >= WIN_LABEL_THRESHOLD_PCT (default 20).
Rows where peak_ceiling_pct IS NULL are dropped from training.
"""

from ml.src.takeit.config import (
    AGGRESSIVE_ASK_PCT_THRESHOLD,
    BURST_STORM_MIN_COFIRES,
    BURST_STORM_WINDOW_MIN,
    COFIRE_WINDOW_MIN,
    TOP_N_TICKERS,
    WIN_LABEL_THRESHOLD_PCT,
)

__all__ = [
    "AGGRESSIVE_ASK_PCT_THRESHOLD",
    "BURST_STORM_MIN_COFIRES",
    "BURST_STORM_WINDOW_MIN",
    "COFIRE_WINDOW_MIN",
    "TOP_N_TICKERS",
    "WIN_LABEL_THRESHOLD_PCT",
]
