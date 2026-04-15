"""
Tests for ml/src/flow_eda.py.

Uses seeded synthetic DataFrames to verify each Q function runs end-to-end
and returns the expected findings shape. Plots are exercised via the
non-interactive 'Agg' backend — files may be written to ml/plots/ but
contents are not asserted.

Run:
    cd ml && .venv/bin/python -m pytest tests/test_flow_eda.py -v
"""

from __future__ import annotations

import matplotlib

matplotlib.use("Agg")  # noqa: E402  — must precede pyplot imports downstream

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from flow_eda import (  # type: ignore[import-not-found]  # noqa: E402
    _classify_direction,
    q1_distributions,
    q2_time_of_day,
    q3_directional,
    q4_returns_by_rule,
    q5_premium_vs_return,
)

# ── Synthetic factories ────────────────────────────────────


def _make_flow_df(n: int = 50, seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    rules = rng.choice(
        ["RepeatedHits", "RepeatedHitsAscendingFill", "RepeatedHitsDescendingFill"],
        n,
    )
    types = rng.choice(["call", "put"], n)
    spot = 6800
    strikes = spot + rng.integers(-100, 100, n)
    df = pd.DataFrame(
        {
            "alert_rule": rules,
            "type": types,
            "strike": strikes.astype(float),
            "underlying_price": float(spot) + rng.normal(0, 5, n),
            "total_premium": rng.lognormal(11, 1, n),  # ~$60k median
            "ask_side_ratio": rng.beta(8, 2, n),
            "distance_pct": (strikes - spot) / spot,
            "is_itm": rng.random(n) > 0.6,
            "minute_of_day": rng.integers(510, 900, n),
            "created_at": pd.date_range(
                "2026-04-14T13:30:00Z", periods=n, freq="3min", tz="UTC"
            ),
        }
    )
    return df


def _make_flow_df_with_outcomes(n: int = 50, seed: int = 42) -> pd.DataFrame:
    df = _make_flow_df(n, seed)
    rng = np.random.default_rng(seed + 1)
    df["ret_fwd_5"] = rng.normal(0, 0.002, n)
    df["ret_fwd_15"] = rng.normal(0, 0.004, n)
    df["ret_fwd_30"] = rng.normal(0, 0.006, n)
    return df


# ── _classify_direction ────────────────────────────────────


def test_classify_direction_categories() -> None:
    bull = pd.Series({"type": "call", "is_itm": False})
    bear = pd.Series({"type": "put", "is_itm": False})
    neutral_call = pd.Series({"type": "call", "is_itm": True})
    neutral_put = pd.Series({"type": "put", "is_itm": True})
    assert _classify_direction(bull) == "bullish"
    assert _classify_direction(bear) == "bearish"
    assert _classify_direction(neutral_call) == "neutral"
    assert _classify_direction(neutral_put) == "neutral"


# ── Q1 ─────────────────────────────────────────────────────


def test_q1_distributions_returns_expected_keys() -> None:
    df = _make_flow_df(60)
    result = q1_distributions(df)
    assert result["question"] == "q1_distributions"
    assert result["n"] == 60
    assert "premium_median" in result
    assert "alert_rule_counts" in result
    # All three alert rules should be represented given seed.
    assert sum(result["alert_rule_counts"].values()) == 60


# ── Q2 ─────────────────────────────────────────────────────


def test_q2_time_of_day_runs() -> None:
    df = _make_flow_df(40)
    result = q2_time_of_day(df)
    assert result["question"] == "q2_time_of_day"
    assert result["n"] == 40
    assert isinstance(result["hour_counts_ct"], dict)
    assert sum(result["hour_counts_ct"].values()) == 40


# ── Q3 ─────────────────────────────────────────────────────


def test_q3_directional_classifies_all_rows() -> None:
    df = _make_flow_df(50)
    result = q3_directional(df)
    assert result["question"] == "q3_directional"
    counts = result["counts"]
    assert set(counts.keys()) >= {"bullish", "bearish", "neutral"}
    assert sum(counts.values()) == 50


def test_q3_directional_empty_df() -> None:
    empty = pd.DataFrame()
    result = q3_directional(empty)
    assert result["n"] == 0


# ── Q4 ─────────────────────────────────────────────────────


def test_q4_returns_by_rule_group_means() -> None:
    df = _make_flow_df_with_outcomes(60)
    result = q4_returns_by_rule(df)
    assert result["question"] == "q4_returns_by_rule"
    assert result["n"] > 0
    assert isinstance(result["groups"], dict)
    for payload in result["groups"].values():
        assert "mean_ret_fwd_15" in payload
        assert payload["n"] >= 1


def test_q4_missing_outcome_column() -> None:
    df = _make_flow_df(20)
    result = q4_returns_by_rule(df)
    assert result["status"] == "no_outcome"


# ── Q5 ─────────────────────────────────────────────────────


def test_q5_premium_vs_return_correlation() -> None:
    df = _make_flow_df_with_outcomes(60)
    result = q5_premium_vs_return(df)
    assert result["question"] == "q5_premium_vs_return"
    assert -1.0 <= result["pearson_r"] <= 1.0
    assert 0.0 <= result["p_value"] <= 1.0
    assert result["n"] > 0


def test_q5_insufficient_n() -> None:
    df = _make_flow_df_with_outcomes(5)
    result = q5_premium_vs_return(df)
    assert result["status"] == "insufficient"


def test_q5_missing_columns() -> None:
    df = _make_flow_df(20)  # no ret_fwd_15
    result = q5_premium_vs_return(df)
    assert result["status"] == "no_outcome"


# ── Empty-table main-path guard ────────────────────────────


def test_main_empty_short_circuits(monkeypatch) -> None:
    """main() must no-op cleanly when the source table is empty."""
    import flow_eda  # type: ignore[import-not-found]

    monkeypatch.setattr(flow_eda, "load_flow_alerts", lambda: pd.DataFrame())
    called: dict[str, bool] = {}

    def fake_save(name: str, data: dict) -> None:
        called["name"] = name
        called["status"] = data.get("status")

    monkeypatch.setattr(flow_eda, "save_section_findings", fake_save)
    flow_eda.main()
    assert called.get("name") == "flow_eda"
    assert called.get("status") == "no_data"
