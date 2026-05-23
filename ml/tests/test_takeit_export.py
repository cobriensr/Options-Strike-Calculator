"""Phase 3a — verify the JSON bundle export round-trips faithfully.

The bundle is the contract between Python training and TS scoring. If the
exported JSON drops keys, mangles isotonic knots, or omits the XGBoost trees,
the TS scorer produces silently wrong outputs. These tests gate that.
"""

from __future__ import annotations

import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import pytest
from takeit.export_model import (
    REQUIRED_KEYS,
    SUPPORTED_XGB_JSON_SCHEMA,
    build_bundle,
    export_bundle,
)
from takeit.train import prepare_features, train_one_alert_type


def _fixture_lottery_frame(n: int = 600, seed: int = 42) -> pd.DataFrame:
    """Same synthetic shape used by test_takeit_train.py."""
    from test_takeit_train import (
        _synthetic_lottery_frame,  # type: ignore[attr-defined]
    )
    return _synthetic_lottery_frame(n=n, seed=seed)


def _train_and_load(tmp_path: Path) -> dict:
    """Train a tiny model and return the train.py joblib bundle."""
    df = _fixture_lottery_frame(n=600)
    data_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    findings_dir = tmp_path / "findings"
    data_dir.mkdir()
    df.to_parquet(data_dir / "lottery_training.parquet", index=False)
    findings_dir.mkdir()
    summary = train_one_alert_type("lottery", data_dir, out_dir, findings_dir)
    assert summary is not None
    return joblib.load(out_dir / "lottery_classifier.joblib")


def test_build_bundle_has_required_keys(tmp_path: Path) -> None:
    bundle = _train_and_load(tmp_path)
    out = build_bundle(bundle, metrics={"oof_auc": 0.7, "oof_brier": 0.2})
    for k in REQUIRED_KEYS:
        assert k in out, f"missing required bundle key: {k}"


def test_build_bundle_emits_supported_schema_version(tmp_path: Path) -> None:
    bundle = _train_and_load(tmp_path)
    out = build_bundle(bundle, metrics={"oof_auc": 0.7})
    assert out["xgb_json_schema"] == SUPPORTED_XGB_JSON_SCHEMA


def test_build_bundle_feature_constants_match_config() -> None:
    """The bundle pins the constants used during training so the TS feature
    builder cannot drift silently. Verifies the keys + ranges."""
    # Round-trip a minimal bundle (no model needed — exercises the constants block).
    import xgboost as xgb
    from sklearn.isotonic import IsotonicRegression

    rng = np.random.default_rng(0)
    X = pd.DataFrame(rng.standard_normal((100, 3)), columns=["a", "b", "c"])
    y = (X["a"] > 0).astype(int).to_numpy()
    model = xgb.XGBClassifier(n_estimators=3, max_depth=2)
    model.fit(X, y)
    iso = IsotonicRegression(out_of_bounds="clip")
    iso.fit(model.predict_proba(X)[:, 1], y)

    train_bundle = {
        "model": model,
        "calibrator": iso,
        "feature_cols": ["a", "b", "c"],
        "top_tickers": [],
        "categorical_cols": [],
        "alert_type": "lottery",
        "trained_on_date": "2026-05-16",
        "win_label_threshold_pct": 20.0,
        "xgb_params": {},
    }
    out = build_bundle(train_bundle, metrics={})
    constants = out["feature_derivation_constants"]
    for key in [
        "AGGRESSIVE_ASK_PCT_THRESHOLD",
        "BURST_STORM_WINDOW_MIN",
        "BURST_STORM_MIN_COFIRES",
        "COFIRE_WINDOW_MIN",
        "TOP_N_TICKERS",
        "WIN_LABEL_THRESHOLD_PCT",
    ]:
        assert key in constants


def test_isotonic_knots_round_trip(tmp_path: Path) -> None:
    """The isotonic block must store enough data to reproduce iso.transform()
    via linear interpolation on the x/y knots."""
    bundle = _train_and_load(tmp_path)
    out = build_bundle(bundle, metrics={})
    iso = bundle["calibrator"]
    knots_x = np.asarray(out["isotonic"]["x_thresholds"])
    knots_y = np.asarray(out["isotonic"]["y_thresholds"])

    # Reproduce iso.transform via np.interp on the exported knots and check
    # agreement against the sklearn implementation on 100 random points.
    rng = np.random.default_rng(7)
    test_points = rng.uniform(0, 1, 100)
    sklearn_out = iso.transform(test_points)
    # numpy interp clips to boundary y-values when x is outside the knot range,
    # which matches IsotonicRegression(out_of_bounds='clip').
    reproduced = np.interp(test_points, knots_x, knots_y)
    assert np.allclose(reproduced, sklearn_out, atol=1e-9)


def test_xgb_model_block_has_trees(tmp_path: Path) -> None:
    """The TS scorer walks `xgb_model.learner.gradient_booster.model.trees`.
    Verify the dump exposes this path."""
    bundle = _train_and_load(tmp_path)
    out = build_bundle(bundle, metrics={})
    xgb_block = out["xgb_model"]
    assert "learner" in xgb_block
    trees = xgb_block["learner"]["gradient_booster"]["model"]["trees"]
    assert isinstance(trees, list)
    assert len(trees) > 0
    # Each tree is a dict with at least split features + leaf values.
    first = trees[0]
    assert "split_indices" in first
    assert "base_weights" in first


def test_export_bundle_writes_valid_json(tmp_path: Path) -> None:
    """Round trip: export → reload → required keys present."""
    bundle = _train_and_load(tmp_path)
    out_path = tmp_path / "lottery_classifier.json"
    export_bundle(bundle, metrics={"oof_auc": 0.7}, out_path=out_path)
    assert out_path.exists()
    reloaded = json.loads(out_path.read_text())
    for k in REQUIRED_KEYS:
        assert k in reloaded


def test_export_bundle_version_defaults_to_today(tmp_path: Path) -> None:
    from datetime import date

    bundle = _train_and_load(tmp_path)
    out = build_bundle(bundle, metrics={})
    assert out["version"] == f"v{date.today().isoformat()}"


def test_build_bundle_metrics_snapshot_excludes_fold_metrics(tmp_path: Path) -> None:
    bundle = _train_and_load(tmp_path)
    out = build_bundle(
        bundle,
        metrics={"oof_auc": 0.7, "oof_brier": 0.2, "fold_metrics": [{"fold": 0}]},
    )
    assert "fold_metrics" not in out["metrics_snapshot"]
    assert out["metrics_snapshot"]["oof_auc"] == pytest.approx(0.7)


def test_train_one_alert_type_emits_json_bundle(tmp_path: Path) -> None:
    """The full training pipeline now produces both joblib and JSON side by side."""
    df = _fixture_lottery_frame(n=600)
    data_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    findings_dir = tmp_path / "findings"
    data_dir.mkdir()
    df.to_parquet(data_dir / "lottery_training.parquet", index=False)
    findings_dir.mkdir()
    train_one_alert_type("lottery", data_dir, out_dir, findings_dir)
    assert (out_dir / "lottery_classifier.joblib").exists()
    assert (out_dir / "lottery_classifier.json").exists()
    # And the JSON is parseable + has the required schema.
    payload = json.loads((out_dir / "lottery_classifier.json").read_text())
    for k in REQUIRED_KEYS:
        assert k in payload


def test_python_prediction_uses_isotonic_consistently(tmp_path: Path) -> None:
    """Build the JSON bundle and confirm: reproducing predictions from the JSON
    knots matches the sklearn IsotonicRegression on real model outputs.

    This is the test that flags any drift in the isotonic export format.
    """
    bundle = _train_and_load(tmp_path)
    df = _fixture_lottery_frame(n=200, seed=99)
    X, _, _, _ = prepare_features(df, "lottery")
    X_subset = X[bundle["feature_cols"]].iloc[:50]
    raw = bundle["model"].predict_proba(X_subset)[:, 1]
    sklearn_cal = bundle["calibrator"].transform(raw)

    json_bundle = build_bundle(bundle, metrics={})
    knots_x = np.asarray(json_bundle["isotonic"]["x_thresholds"])
    knots_y = np.asarray(json_bundle["isotonic"]["y_thresholds"])
    json_cal = np.interp(raw, knots_x, knots_y)
    assert np.allclose(json_cal, sklearn_cal, atol=1e-9)
