"""Smoke tests for Phase 2 training + SHAP explainer.

Uses a small synthetic dataset (no DB) to verify the full train -> calibrate ->
explain path runs and produces sensible output.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from takeit.shap_explainer import _json_safe, explain_batch, explain_row
from takeit.train import (
    prepare_features,
    select_top_tickers,
    train_final_with_calibration,
    train_one_alert_type,
    walk_forward_cv,
)


def _synthetic_lottery_frame(n: int = 400, seed: int = 42) -> pd.DataFrame:
    """Build a tiny lottery-shaped frame with a real signal so AUC >> 0.5.

    Signal: high `score` + low `session_phase` (early in day) + dealer +γ
    raises P(win); ITM raises P(loss). A few features are noise.
    """
    rng = np.random.default_rng(seed)
    base = pd.to_datetime("2026-04-01 14:30:00+00:00", utc=True)
    fire_times = [base + pd.Timedelta(minutes=int(m)) for m in rng.integers(0, 5 * 24 * 60, n)]
    fire_times.sort()  # time-ordered for walk-forward

    df = pd.DataFrame({
        "id": range(n),
        "date": [t.date() for t in fire_times],
        "fire_time": fire_times,
        "option_chain_id": [f"SPY_{i % 50}" for i in range(n)],
        "underlying_symbol": rng.choice(["SPY", "QQQ", "SPXW", "AAPL", "NVDA"], n),
        "option_type": rng.choice(["C", "P"], n),
        "strike": rng.uniform(100, 600, n),
        "expiry": [t.date() for t in fire_times],
        "dte": rng.integers(0, 5, n),
        "trigger_vol_to_oi_window": rng.uniform(0.5, 5, n),
        "trigger_vol_to_oi_cum": rng.uniform(0.5, 5, n),
        "trigger_iv": rng.uniform(0.1, 0.6, n),
        "trigger_delta": rng.uniform(0.05, 0.40, n),
        "trigger_ask_pct": rng.uniform(0.3, 0.95, n),
        "trigger_window_size": rng.integers(3, 15, n),
        "trigger_window_prints": rng.integers(2, 10, n),
        "entry_price": rng.uniform(0.5, 5, n),
        "open_interest": rng.integers(10, 1000, n),
        "spot_at_first": rng.uniform(100, 600, n),
        "alert_seq": rng.integers(1, 5, n),
        "minutes_since_prev_fire": rng.uniform(1, 240, n),
        "flow_quad": rng.choice(["Q1", "Q2", "Q3", "Q4"], n),
        "tod": rng.choice(["AM_open", "MID", "LUNCH", "PM_close"], n),
        "mode": rng.choice(["A_intraday_0DTE", "B_multi_day_DTE1_3"], n),
        "reload_tagged": rng.random(n) < 0.05,
        "cheap_call_pm_tagged": rng.random(n) < 0.05,
        "burst_ratio_vs_prev": rng.uniform(0.5, 3, n),
        "entry_drop_pct_vs_prev": rng.uniform(-0.5, 0.5, n),
        "mkt_tide_ncp": rng.normal(0, 1, n),
        "mkt_tide_npp": rng.normal(0, 1, n),
        "mkt_tide_diff": rng.normal(0, 2, n),
        "mkt_tide_otm_diff": rng.normal(0, 2, n),
        "spx_flow_diff": rng.normal(0, 1, n),
        "spy_etf_diff": rng.normal(0, 1, n),
        "qqq_etf_diff": rng.normal(0, 1, n),
        "zero_dte_diff": rng.normal(0, 1, n),
        "spx_spot_gamma_oi": rng.normal(0, 3, n),
        "spx_spot_gamma_vol": rng.normal(0, 1, n),
        "spx_spot_charm_oi": rng.normal(0, 1, n),
        "spx_spot_vanna_oi": rng.normal(0, 1, n),
        "gex_strike_call_minus_put": rng.normal(0, 1, n),
        "gex_strike_call_ask_minus_bid": rng.normal(0, 1, n),
        "gex_strike_put_ask_minus_bid": rng.normal(0, 1, n),
        "gex_strike_actual_strike": rng.uniform(100, 600, n),
        "score": rng.integers(0, 25, n),
        "direction_gated": rng.random(n) < 0.05,
        "alert_type": "lottery",
        # Phase-1 derived features:
        "minute_of_day_ct": rng.integers(8 * 60 + 30, 15 * 60, n),
        "day_of_week": rng.integers(0, 5, n),
        "session_phase": rng.integers(1, 6, n),
        "is_itm_at_fire": rng.integers(0, 2, n).astype(np.int8),
        "otm_distance_pct": rng.uniform(-0.1, 0.1, n),
        "dealer_gamma_sign": rng.choice([-1, 1], n).astype(np.int8),
        "aggressive_premium_flag": (rng.random(n) < 0.25).astype(np.int8),
        "burst_storm_badge": rng.integers(0, 2, n).astype(np.int8),
        "burst_storm_distinct_count": rng.integers(0, 8, n),
        "silent_boom_cofire_within_5min": (rng.random(n) < 0.1).astype(np.int8),
        "n_same_dir_fires_last_30min": rng.integers(0, 5, n),
        "prior_session_win_rate_same_ticker": rng.uniform(0, 1, n),
    })

    # Inject a real signal so AUC > heuristic baseline.
    logit = (
        0.15 * df["score"].astype(float)
        + 0.4 * df["dealer_gamma_sign"].astype(float)
        - 0.6 * df["is_itm_at_fire"].astype(float)
        - 0.3 * (df["session_phase"].astype(float) - 3)
    )
    p = 1.0 / (1.0 + np.exp(-logit))
    df["win"] = (rng.random(n) < p).astype(int)
    df["peak_ceiling_pct"] = np.where(df["win"] == 1,
                                       rng.uniform(20, 100, n),
                                       rng.uniform(0, 19, n))
    return df


# ── prepare_features ─────────────────────────────────────────────────────────


def test_prepare_features_drops_identifiers_and_target() -> None:
    df = _synthetic_lottery_frame(n=100)
    X, y, feature_cols, _ = prepare_features(df, "lottery")
    for forbidden in (
        "id", "date", "fire_time", "option_chain_id", "underlying_symbol",
        "alert_type", "expiry", "peak_ceiling_pct", "win", "strike",
        "gex_strike_actual_strike",
    ):
        assert forbidden not in feature_cols, f"non-feature column {forbidden} leaked into X"
    assert len(X) == len(df)
    assert len(y) == len(df)
    assert set(y.tolist()).issubset({0, 1})


def test_prepare_features_one_hots_top_tickers_plus_other() -> None:
    df = _synthetic_lottery_frame(n=200)
    _, _, feature_cols, _ = prepare_features(df, "lottery")
    # 5 distinct tickers in fixture, TOP_N_TICKERS=15 -> all are kept; no OTHER
    # bucket should appear unless cardinality exceeds the cap.
    bucket_cols = [c for c in feature_cols if c.startswith("ticker_bucket_")]
    assert len(bucket_cols) == 5
    assert "ticker_bucket_OTHER" not in feature_cols


def test_select_top_tickers_caps_cardinality() -> None:
    df = _synthetic_lottery_frame(n=200)
    # Force >TOP_N_TICKERS distinct values.
    df["underlying_symbol"] = [f"T{i % 30}" for i in range(len(df))]
    top = select_top_tickers(df, top_n=15)
    assert len(top) == 15


# ── walk_forward_cv ──────────────────────────────────────────────────────────


def test_walk_forward_cv_produces_oof_predictions() -> None:
    # Need enough samples per fold to overcome XGB_PARAMS min_child_weight=50.
    df = _synthetic_lottery_frame(n=3000)
    X, y, _, _ = prepare_features(df, "lottery")
    oof_preds, oof_mask, fold_metrics = walk_forward_cv(X, y, n_splits=3)
    assert oof_mask.sum() > 0
    # OOF rows must have predictions in [0, 1].
    assert (oof_preds[oof_mask] >= 0).all()
    assert (oof_preds[oof_mask] <= 1).all()
    assert len(fold_metrics) == 3
    # On synthetic data with a planted signal, OOF AUC must beat random.
    from sklearn.metrics import roc_auc_score as _auc
    assert _auc(y[oof_mask], oof_preds[oof_mask]) > 0.55


# ── train_final_with_calibration ─────────────────────────────────────────────


def test_calibration_does_not_break_auc() -> None:
    df = _synthetic_lottery_frame(n=400)
    X, y, _, _ = prepare_features(df, "lottery")
    _, _, info = train_final_with_calibration(X, y)
    assert info["n_train"] + info["n_cal"] == len(y)
    # Isotonic is monotone, so AUC is invariant under it.
    assert info["cal_auc"] == pytest.approx(info["raw_auc"], abs=1e-9)
    # Calibration should at least not make Brier dramatically worse.
    assert info["cal_brier"] <= info["raw_brier"] + 0.02


# ── End-to-end train_one_alert_type ──────────────────────────────────────────


def test_train_one_alert_type_writes_artifacts(tmp_path: Path) -> None:
    df = _synthetic_lottery_frame(n=600)
    data_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    findings_dir = tmp_path / "findings"
    data_dir.mkdir()
    df.to_parquet(data_dir / "lottery_training.parquet", index=False)
    findings_dir.mkdir()

    summary = train_one_alert_type("lottery", data_dir, out_dir, findings_dir)
    assert summary is not None
    assert (out_dir / "lottery_classifier.joblib").exists()
    assert (findings_dir / "lottery_metrics.json").exists()
    assert (findings_dir / "lottery_reliability_oof.png").exists()
    assert (findings_dir / "lottery_roc_oof.png").exists()
    assert (findings_dir / "lottery_feature_importance.png").exists()


def test_train_one_alert_type_respects_min_sample_gate(tmp_path: Path) -> None:
    df = _synthetic_lottery_frame(n=100)  # below MIN_LABELED_SAMPLES=500
    data_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    findings_dir = tmp_path / "findings"
    data_dir.mkdir()
    df.to_parquet(data_dir / "silentboom_training.parquet", index=False)
    findings_dir.mkdir()

    summary = train_one_alert_type("silentboom", data_dir, out_dir, findings_dir)
    assert summary is None
    assert not (out_dir / "silentboom_classifier.joblib").exists()


# ── SHAP explainer ───────────────────────────────────────────────────────────


def test_explain_row_returns_top_k(tmp_path: Path) -> None:
    df = _synthetic_lottery_frame(n=600)
    data_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    findings_dir = tmp_path / "findings"
    data_dir.mkdir()
    df.to_parquet(data_dir / "lottery_training.parquet", index=False)
    findings_dir.mkdir()

    train_one_alert_type("lottery", data_dir, out_dir, findings_dir)

    import joblib
    bundle = joblib.load(out_dir / "lottery_classifier.joblib")
    # Use a row from the original frame.
    X, _, _, _ = prepare_features(df, "lottery")
    explanation = explain_row(bundle, X.iloc[0])
    assert 0 <= explanation.prob_calibrated <= 1
    assert 0 <= explanation.prob_raw <= 1
    # Total surfaced features <= 2 * SHAP_TOP_K.
    assert len(explanation.top_positive) <= 3
    assert len(explanation.top_negative) <= 3
    # Top-positive SHAP values must be > 0; top-negative < 0.
    for c in explanation.top_positive:
        assert c.shap_value > 0
    for c in explanation.top_negative:
        assert c.shap_value < 0


def test_json_safe_handles_pandas_and_numpy_edge_inputs() -> None:
    """Defensive scalars: pd.NA, np.nan, numpy bool/int/float, plain Python."""
    assert _json_safe(pd.NA) is None
    assert _json_safe(None) is None
    assert _json_safe(np.nan) is None
    assert _json_safe(np.int8(3)) == 3
    assert isinstance(_json_safe(np.int8(3)), int)
    assert _json_safe(np.float32(1.5)) == pytest.approx(1.5)
    assert isinstance(_json_safe(np.float32(1.5)), float)
    assert _json_safe(np.bool_(True)) is True
    assert isinstance(_json_safe(np.bool_(True)), bool)
    assert _json_safe(7) == 7
    assert _json_safe("OTHER") == "OTHER"


def test_explain_batch_chunked_matches_unchunked(tmp_path: Path) -> None:
    """Chunking must not change the output — same prob + same top features."""
    df = _synthetic_lottery_frame(n=600)
    data_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    findings_dir = tmp_path / "findings"
    data_dir.mkdir()
    df.to_parquet(data_dir / "lottery_training.parquet", index=False)
    findings_dir.mkdir()

    train_one_alert_type("lottery", data_dir, out_dir, findings_dir)

    import joblib
    bundle = joblib.load(out_dir / "lottery_classifier.joblib")
    X, _, _, _ = prepare_features(df, "lottery")

    big = explain_batch(bundle, X.iloc[:50], chunk_size=10_000)
    small = explain_batch(bundle, X.iloc[:50], chunk_size=7)
    assert len(big) == len(small) == 50
    for i in range(50):
        assert big[i].prob_raw == pytest.approx(small[i].prob_raw, abs=1e-9)
        assert big[i].prob_calibrated == pytest.approx(small[i].prob_calibrated, abs=1e-9)


def test_bundle_round_trip_predicts_in_unit_interval(tmp_path: Path) -> None:
    """Reload joblib bundle and verify predictions stay in [0,1] and the
    calibrator is an IsotonicRegression — not just that files exist."""
    from sklearn.isotonic import IsotonicRegression

    df = _synthetic_lottery_frame(n=600)
    data_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    findings_dir = tmp_path / "findings"
    data_dir.mkdir()
    df.to_parquet(data_dir / "lottery_training.parquet", index=False)
    findings_dir.mkdir()

    train_one_alert_type("lottery", data_dir, out_dir, findings_dir)

    import joblib
    bundle = joblib.load(out_dir / "lottery_classifier.joblib")
    assert isinstance(bundle["calibrator"], IsotonicRegression)
    assert "feature_cols" in bundle
    assert "top_tickers" in bundle
    assert bundle["alert_type"] == "lottery"
    X, _, _, _ = prepare_features(df, "lottery")
    raw = bundle["model"].predict_proba(X[bundle["feature_cols"]].iloc[:5])[:, 1]
    cal = bundle["calibrator"].transform(raw)
    assert ((raw >= 0) & (raw <= 1)).all()
    assert ((cal >= 0) & (cal <= 1)).all()


def test_train_one_alert_type_records_honest_lift(tmp_path: Path) -> None:
    df = _synthetic_lottery_frame(n=3000)
    data_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    findings_dir = tmp_path / "findings"
    data_dir.mkdir()
    df.to_parquet(data_dir / "lottery_training.parquet", index=False)
    findings_dir.mkdir()

    summary = train_one_alert_type("lottery", data_dir, out_dir, findings_dir)
    assert summary is not None
    # `oof_auc_no_score` must be present and within [0, 1].
    assert 0 <= summary.oof_auc_no_score <= 1
    # `honest_lift` = oof_auc_no_score - heuristic; can be negative if the new
    # features don't help. Just assert the math.
    assert summary.honest_lift == pytest.approx(
        summary.oof_auc_no_score - summary.heuristic_oof_auc, abs=1e-9
    )
    # Brier gate boolean must be set.
    assert isinstance(summary.brier_ok, bool)


def test_explain_batch_matches_explain_row(tmp_path: Path) -> None:
    df = _synthetic_lottery_frame(n=600)
    data_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    findings_dir = tmp_path / "findings"
    data_dir.mkdir()
    df.to_parquet(data_dir / "lottery_training.parquet", index=False)
    findings_dir.mkdir()

    train_one_alert_type("lottery", data_dir, out_dir, findings_dir)

    import joblib
    bundle = joblib.load(out_dir / "lottery_classifier.joblib")
    X, _, _, _ = prepare_features(df, "lottery")
    batch = explain_batch(bundle, X.iloc[:5])
    assert len(batch) == 5
    one = explain_row(bundle, X.iloc[0])
    assert batch[0].prob_calibrated == pytest.approx(one.prob_calibrated, abs=1e-9)
    assert batch[0].prob_raw == pytest.approx(one.prob_raw, abs=1e-9)


def test_explanation_to_dict_is_json_serializable(tmp_path: Path) -> None:
    df = _synthetic_lottery_frame(n=600)
    data_dir = tmp_path / "data"
    out_dir = tmp_path / "out"
    findings_dir = tmp_path / "findings"
    data_dir.mkdir()
    df.to_parquet(data_dir / "lottery_training.parquet", index=False)
    findings_dir.mkdir()

    train_one_alert_type("lottery", data_dir, out_dir, findings_dir)

    import json

    import joblib
    bundle = joblib.load(out_dir / "lottery_classifier.joblib")
    X, _, _, _ = prepare_features(df, "lottery")
    explanation = explain_row(bundle, X.iloc[0])
    # Round-trip through json.dumps — must not raise.
    payload = json.dumps(explanation.to_dict())
    parsed = json.loads(payload)
    assert "prob_calibrated" in parsed
    assert "top_positive" in parsed
