"""Phase 3a — export a trained take-it model to JSON for the TS scorer.

Bundle layout (single JSON file):

    {
      "version": "v2026-05-16",              # ISO date, used as bundle filename
      "alert_type": "lottery" | "silentboom",
      "trained_on_date": "2026-05-16",
      "win_label_threshold_pct": 20.0,
      "xgb_json_schema": "2.1",              # gate for TS loader compatibility
      "feature_cols": [...],                 # expected column order at score time
      "top_tickers": [...],                  # for ticker_bucket one-hot
      "categorical_cols": [...],             # columns to one-hot at score time
      "feature_derivation_constants": {       # same constants the trainer used;
          "AGGRESSIVE_ASK_PCT_THRESHOLD": 0.85, # mirroring config.py guarantees
          "BURST_STORM_WINDOW_MIN": 30,       # the TS feature builder produces
          "BURST_STORM_MIN_COFIRES": 5,       # the exact inputs the model was
          "COFIRE_WINDOW_MIN": 5,             # trained on.
          "TOP_N_TICKERS": 15
      },
      "xgb_model": { ...XGBoost native JSON dump... },
      "isotonic": { "x_thresholds": [...], "y_thresholds": [...] },
      "metrics_snapshot": {
          "oof_auc": 0.6991, "oof_auc_no_score": 0.7017,
          "heuristic_oof_auc": 0.6137, "oof_brier": 0.205,
          "n_train_rows": 626155
      }
    }

The TS scorer's contract:
- read bundle, assert xgb_json_schema matches its supported set, else fail closed.
- one-hot input row using categorical_cols + top_tickers.
- walk every tree in xgb_model.learner.gradient_booster.model.trees.
- sum leaf logits, apply sigmoid, apply isotonic piecewise-linear interp.
"""

from __future__ import annotations

import json
from dataclasses import asdict, is_dataclass
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np
import xgboost as xgb
from ml.src.takeit.config import (
    AGGRESSIVE_ASK_PCT_THRESHOLD,
    BURST_STORM_MIN_COFIRES,
    BURST_STORM_WINDOW_MIN,
    COFIRE_WINDOW_MIN,
    TOP_N_TICKERS,
    WIN_LABEL_THRESHOLD_PCT,
)
from sklearn.isotonic import IsotonicRegression

# Supported XGBoost JSON schema versions. The TS scorer will assert it's one of
# these on load. Update both sides if XGBoost releases a breaking format change.
SUPPORTED_XGB_JSON_SCHEMA = "2.1"

# Required keys on every emitted bundle — the TS loader asserts presence.
REQUIRED_KEYS: tuple[str, ...] = (
    "version",
    "alert_type",
    "trained_on_date",
    "win_label_threshold_pct",
    "xgb_json_schema",
    "feature_cols",
    "top_tickers",
    "categorical_cols",
    "feature_derivation_constants",
    "xgb_model",
    "isotonic",
)


def _xgb_to_json(model: xgb.XGBClassifier) -> dict:
    """Dump the trained XGBoost model to its native JSON shape.

    `save_raw(raw_format='json')` returns bytes; we parse so the bundle holds
    a structured object rather than an opaque string.
    """
    booster = model.get_booster()
    raw = booster.save_raw(raw_format="json")
    return json.loads(raw.decode("utf-8"))


def _isotonic_to_json(iso: IsotonicRegression) -> dict:
    """Extract the piecewise-linear knot arrays.

    sklearn IsotonicRegression exposes `X_thresholds_` and `y_thresholds_` as
    the (x, y) breakpoints of the monotone function; linear interpolation
    between successive points reproduces transform(). Clip-mode is captured so
    the TS scorer matches sklearn behavior at the boundaries.
    """
    return {
        "x_thresholds": iso.X_thresholds_.tolist(),
        "y_thresholds": iso.y_thresholds_.tolist(),
        "out_of_bounds": iso.out_of_bounds,
    }


def _coerce_jsonable(value: Any) -> Any:
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return float(value)
    if isinstance(value, np.ndarray):
        return value.tolist()
    if is_dataclass(value):
        return asdict(value)
    return value


def build_bundle(
    train_bundle: dict,
    metrics: dict,
    version: str | None = None,
) -> dict:
    """Assemble the JSON-ready bundle from the joblib produced by train.py.

    `train_bundle` shape (see train.py):
        {
            "model": xgb.XGBClassifier,
            "calibrator": IsotonicRegression,
            "feature_cols": list[str],
            "top_tickers": list[str],
            "categorical_cols": list[str],
            "alert_type": "lottery" | "silentboom",
            "trained_on_date": "2026-05-16",
            "win_label_threshold_pct": 20.0,
            "xgb_params": {...},
        }
    """
    if version is None:
        version = f"v{date.today().isoformat()}"

    bundle = {
        "version": version,
        "alert_type": train_bundle["alert_type"],
        "trained_on_date": train_bundle["trained_on_date"],
        "win_label_threshold_pct": float(WIN_LABEL_THRESHOLD_PCT),
        "xgb_json_schema": SUPPORTED_XGB_JSON_SCHEMA,
        "feature_cols": list(train_bundle["feature_cols"]),
        "top_tickers": list(train_bundle["top_tickers"]),
        "categorical_cols": list(train_bundle.get("categorical_cols", [])),
        "feature_derivation_constants": {
            "AGGRESSIVE_ASK_PCT_THRESHOLD": AGGRESSIVE_ASK_PCT_THRESHOLD,
            "BURST_STORM_WINDOW_MIN": BURST_STORM_WINDOW_MIN,
            "BURST_STORM_MIN_COFIRES": BURST_STORM_MIN_COFIRES,
            "COFIRE_WINDOW_MIN": COFIRE_WINDOW_MIN,
            "TOP_N_TICKERS": TOP_N_TICKERS,
            "WIN_LABEL_THRESHOLD_PCT": float(WIN_LABEL_THRESHOLD_PCT),
        },
        "xgb_model": _xgb_to_json(train_bundle["model"]),
        "isotonic": _isotonic_to_json(train_bundle["calibrator"]),
        "metrics_snapshot": {
            k: _coerce_jsonable(v) for k, v in metrics.items() if k != "fold_metrics"
        },
    }

    missing = [k for k in REQUIRED_KEYS if k not in bundle]
    if missing:
        raise ValueError(f"export bundle missing required keys: {missing}")
    return bundle


def export_bundle(
    train_bundle: dict,
    metrics: dict,
    out_path: Path,
    version: str | None = None,
) -> dict:
    """Build + write the JSON bundle. Returns the in-memory bundle dict."""
    bundle = build_bundle(train_bundle, metrics, version=version)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(bundle, f, indent=2, default=_coerce_jsonable)
    return bundle
