"""Tests for `ml/scripts/train_pac_classifier.py`.

The trainer is a script, but the math + decision logic + walk-forward
windowing are testable in isolation. We import the helpers directly
and exercise them with synthetic per-event data.

Coverage:
- `_expected_r_at_threshold`: take-rate + mean realized_R, threshold cutoff
- `_r2`, `_spearman`: standard math, NaN on degenerate input
- `_verdict`: AND-gate on AUC + Expected R per window
- `evaluate_window`: end-to-end on a synthetic year — finite metrics, no errors
- `run_walk_forward`: 2 years of synthetic data → 1 window; 3 years → 2 windows
- `load_dataset_by_year`: skip missing years with warning, return loaded ones

We do NOT test classifier *quality* (real signal lives or dies on
real data); we test that the pipeline produces the expected shape +
that the gates evaluate correctly.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

# The trainer is in ml/scripts/, not ml/src/, so import it via spec.
_TRAINER_PATH = Path(__file__).resolve().parents[1] / "scripts" / "train_pac_classifier.py"
_spec = importlib.util.spec_from_file_location("_pac_trainer", _TRAINER_PATH)
assert _spec is not None and _spec.loader is not None
trainer = importlib.util.module_from_spec(_spec)
sys.modules["_pac_trainer"] = trainer
_spec.loader.exec_module(trainer)


def _synthetic_year(year: int, n: int = 400, seed: int = 0) -> pd.DataFrame:
    """Build a synthetic per-event frame matching the dataset schema.

    Features have a mild signal-on-label_a relationship so xgboost
    converges to a non-trivial AUC — but not perfectly, so the test
    isn't testing the ceiling, it's testing the plumbing.
    """
    rng = np.random.default_rng(seed + year)
    # Build a noisy-but-signal-bearing dataset
    feature_a = rng.standard_normal(n)  # informative
    feature_b = rng.standard_normal(n)  # informative
    feature_c = rng.standard_normal(n)  # noise
    # label_a hinges on feature_a + noise
    logits = 0.7 * feature_a + 0.3 * feature_b + 0.4 * rng.standard_normal(n)
    label_a = (logits > 0).astype(float)
    # ~20% timeout (NaN label_a) — realistic
    timeout_mask = rng.uniform(size=n) < 0.20
    label_a[timeout_mask] = np.nan
    # realized_R: +1.5 when label_a=1, -1.0 when label_a=0, drift for timeout
    realized_r = np.where(
        np.isclose(label_a, 1.0),
        1.5,
        np.where(np.isclose(label_a, 0.0), -1.0, rng.standard_normal(n) * 0.4),
    )
    # forward_return_dollars correlates with logits
    forward_return = 5.0 * logits + rng.standard_normal(n) * 2.0
    return pd.DataFrame(
        {
            "bar_idx": np.arange(n, dtype=np.int64),
            "ts_event": pd.date_range(f"{year}-01-02 09:30", periods=n, freq="5min", tz="UTC"),
            "signal_type": rng.choice(["BOS", "CHOCH", "CHOCHPLUS"], n),
            "signal_direction": rng.choice(["up", "dn"], n),
            "entry_price": 15000.0 + rng.standard_normal(n).cumsum(),
            "label_a": label_a,
            "exit_reason": ["target"] * n,
            "bars_to_exit": rng.integers(1, 48, n),
            "realized_R": realized_r,
            "forward_return_dollars": forward_return,
            "atr_14": np.full(n, 25.0) + rng.standard_normal(n),
            "adx_14": np.full(n, 22.0) + rng.standard_normal(n),
            "session_bucket": rng.choice(["am", "pm", "lunch"], n),
            "feature_a": feature_a,
            "feature_b": feature_b,
            "feature_c": feature_c,
        }
    )


# ---------------------------------------------------------------------------
# _expected_r_at_threshold
# ---------------------------------------------------------------------------


def test_expected_r_take_rate_at_threshold_zero_takes_all() -> None:
    proba = np.array([0.1, 0.5, 0.9])
    realized = np.array([1.0, 2.0, 3.0])
    er, tr = trainer._expected_r_at_threshold(proba, realized, 0.0)
    assert er == pytest.approx(2.0)  # mean(1, 2, 3)
    assert tr == pytest.approx(1.0)


def test_expected_r_threshold_filters_correctly() -> None:
    proba = np.array([0.1, 0.5, 0.9])
    realized = np.array([1.0, 2.0, 3.0])
    er, tr = trainer._expected_r_at_threshold(proba, realized, 0.6)
    # Only proba >= 0.6 → only 0.9 passes → realized=3.0, take_rate 1/3
    assert er == pytest.approx(3.0)
    assert tr == pytest.approx(1 / 3)


def test_expected_r_no_trades_returns_nan() -> None:
    proba = np.array([0.1, 0.2, 0.3])
    realized = np.array([1.0, 2.0, 3.0])
    er, tr = trainer._expected_r_at_threshold(proba, realized, 0.99)
    assert np.isnan(er)
    assert tr == pytest.approx(0.0)


def test_expected_r_skips_nan_realized() -> None:
    """Timeouts in realized_R must not poison the mean. NaN-skip is intentional."""
    proba = np.array([0.7, 0.7, 0.7])
    realized = np.array([np.nan, 1.0, 2.0])
    er, tr = trainer._expected_r_at_threshold(proba, realized, 0.5)
    assert er == pytest.approx(1.5)  # mean of 1, 2; NaN excluded
    assert tr == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# _r2 and _spearman
# ---------------------------------------------------------------------------


def test_r2_perfect_prediction() -> None:
    y_true = np.array([1.0, 2.0, 3.0])
    y_pred = y_true.copy()
    assert trainer._r2(y_true, y_pred) == pytest.approx(1.0)


def test_r2_constant_y_true_is_nan() -> None:
    y_true = np.array([5.0, 5.0, 5.0])
    y_pred = np.array([4.0, 5.0, 6.0])
    assert np.isnan(trainer._r2(y_true, y_pred))


def test_spearman_monotonic_perfect() -> None:
    x = np.array([1.0, 2.0, 3.0, 4.0])
    y = np.array([10.0, 20.0, 30.0, 40.0])
    assert trainer._spearman(x, y) == pytest.approx(1.0)


def test_spearman_constant_returns_nan() -> None:
    x = np.array([1.0, 1.0, 1.0])
    y = np.array([4.0, 5.0, 6.0])
    assert np.isnan(trainer._spearman(x, y))


# ---------------------------------------------------------------------------
# _verdict
# ---------------------------------------------------------------------------


def test_verdict_pass_when_all_windows_clear_both_gates() -> None:
    win = trainer.WindowResult(
        name="W1",
        train_years=[2022],
        test_year=2023,
        n_train=100,
        n_test=100,
        n_train_resolved=80,
        n_test_resolved=80,
        timeout_rate_test=0.2,
        auc_a=0.60,
        expected_r_at_threshold={"p0.50": 0.15, "p0.55": 0.20, "p0.60": 0.25},
    )
    v = trainer._verdict([win])
    assert v["all_windows_pass"] is True
    assert v["per_window"][0]["passed"] is True


def test_verdict_fail_when_auc_low() -> None:
    win = trainer.WindowResult(
        name="W1",
        train_years=[2022],
        test_year=2023,
        n_train=100,
        n_test=100,
        n_train_resolved=80,
        n_test_resolved=80,
        timeout_rate_test=0.2,
        auc_a=0.51,  # below 0.55
        expected_r_at_threshold={"p0.50": 0.15},
    )
    v = trainer._verdict([win])
    assert v["all_windows_pass"] is False
    assert v["per_window"][0]["auc_pass"] is False


def test_verdict_fail_when_expected_r_low() -> None:
    win = trainer.WindowResult(
        name="W1",
        train_years=[2022],
        test_year=2023,
        n_train=100,
        n_test=100,
        n_train_resolved=80,
        n_test_resolved=80,
        timeout_rate_test=0.2,
        auc_a=0.60,
        expected_r_at_threshold={"p0.50": 0.05},  # below 0.10
    )
    v = trainer._verdict([win])
    assert v["all_windows_pass"] is False
    assert v["per_window"][0]["expected_r_pass"] is False


def test_verdict_one_failing_window_drops_overall() -> None:
    pass_win = trainer.WindowResult(
        name="W1", train_years=[2022], test_year=2023,
        n_train=100, n_test=100, n_train_resolved=80, n_test_resolved=80,
        timeout_rate_test=0.2, auc_a=0.60,
        expected_r_at_threshold={"p0.50": 0.15},
    )
    fail_win = trainer.WindowResult(
        name="W2", train_years=[2022, 2023], test_year=2024,
        n_train=200, n_test=100, n_train_resolved=160, n_test_resolved=80,
        timeout_rate_test=0.2, auc_a=0.50,
        expected_r_at_threshold={"p0.50": 0.05},
    )
    v = trainer._verdict([pass_win, fail_win])
    assert v["all_windows_pass"] is False
    assert v["per_window"][0]["passed"] is True
    assert v["per_window"][1]["passed"] is False


# ---------------------------------------------------------------------------
# evaluate_window — end-to-end on synthetic data
# ---------------------------------------------------------------------------


def test_evaluate_window_produces_finite_metrics() -> None:
    train = _synthetic_year(2022, n=500, seed=1)
    test = _synthetic_year(2023, n=300, seed=2)
    train["__year"] = 2022
    test["__year"] = 2023
    encoded_train, cats = trainer._encode_categoricals(train)
    encoded_test = trainer._apply_categoricals(test, cats)

    res = trainer.evaluate_window("W1", encoded_train, encoded_test, seed=42)
    assert res.auc_a is not None
    assert 0.0 <= res.auc_a <= 1.0
    # On signal-bearing synthetic data with seed=42, AUC should be > 0.5
    assert res.auc_a > 0.5
    # Feature importance dict is populated
    assert len(res.feature_importance_a) > 0
    # Model B regression should produce a finite R²
    assert res.r2_b is not None
    assert np.isfinite(res.r2_b)


def test_evaluate_window_handles_too_few_samples() -> None:
    """When training data is below the threshold, both models skip
    cleanly and return None metrics (rather than crashing)."""
    train = _synthetic_year(2022, n=20, seed=1)
    test = _synthetic_year(2023, n=10, seed=2)
    train["__year"] = 2022
    test["__year"] = 2023
    encoded_train, cats = trainer._encode_categoricals(train)
    encoded_test = trainer._apply_categoricals(test, cats)

    res = trainer.evaluate_window("W1", encoded_train, encoded_test, seed=42)
    assert res.auc_a is None
    assert res.r2_b is None


# ---------------------------------------------------------------------------
# run_walk_forward — windowing
# ---------------------------------------------------------------------------


def test_run_walk_forward_two_years_one_window() -> None:
    df_by_year = {
        2022: _synthetic_year(2022, n=400, seed=1),
        2023: _synthetic_year(2023, n=400, seed=2),
    }
    windows, feature_cols = trainer.run_walk_forward(df_by_year, seed=42)
    assert len(windows) == 1
    assert windows[0].train_years == [2022]
    assert windows[0].test_year == 2023
    assert len(feature_cols) > 0


def test_run_walk_forward_three_years_two_windows() -> None:
    df_by_year = {
        2022: _synthetic_year(2022, n=400, seed=1),
        2023: _synthetic_year(2023, n=400, seed=2),
        2024: _synthetic_year(2024, n=400, seed=3),
    }
    windows, _ = trainer.run_walk_forward(df_by_year, seed=42)
    assert len(windows) == 2
    # W1 trains on 2022, tests on 2023; W2 trains on 2022+2023, tests on 2024
    assert windows[0].train_years == [2022]
    assert windows[0].test_year == 2023
    assert windows[1].train_years == [2022, 2023]
    assert windows[1].test_year == 2024
    # Expanding window: W2 train > W1 train
    assert windows[1].n_train > windows[0].n_train


def test_run_walk_forward_one_year_raises() -> None:
    df_by_year = {2022: _synthetic_year(2022, n=400, seed=1)}
    with pytest.raises(ValueError):
        trainer.run_walk_forward(df_by_year, seed=42)


# ---------------------------------------------------------------------------
# load_dataset_by_year
# ---------------------------------------------------------------------------


def test_load_dataset_by_year_skips_missing(tmp_path: Path) -> None:
    """Years with no on-disk parquet are skipped with a warning rather
    than crashing — caller decides whether 1 missing year is fatal."""
    df = _synthetic_year(2022, n=20, seed=0)
    df.to_parquet(tmp_path / "5m_NQ_2022.parquet", index=False, engine="pyarrow")
    # Don't write 2023 or 2024
    out = trainer.load_dataset_by_year(tmp_path, "5m", "NQ", [2022, 2023, 2024])
    assert sorted(out.keys()) == [2022]
    assert len(out[2022]) == 20


def test_load_dataset_by_year_round_trip(tmp_path: Path) -> None:
    """Verify the loader's path convention matches the builder's
    output path exactly. <data_dir>/<timeframe>_<symbol>_<year>.parquet."""
    df = _synthetic_year(2024, n=15, seed=0)
    df.to_parquet(tmp_path / "1m_ES_2024.parquet", index=False, engine="pyarrow")
    out = trainer.load_dataset_by_year(tmp_path, "1m", "ES", [2024])
    assert 2024 in out
    assert len(out[2024]) == 15
