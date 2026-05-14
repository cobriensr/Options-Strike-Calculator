"""Tests for the Phase 4 analysis helpers."""

from __future__ import annotations

import numpy as np
import pandas as pd

from src.imbalance import eod_analysis


def _panel_slice(n: int, signal_strength: float = 0.0) -> pd.DataFrame:
    rng = np.random.default_rng(seed=42)
    x = rng.normal(0, 100_000, n)
    noise = rng.normal(0, 50, n)
    y = signal_strength * (x / 100_000) * 50 + noise  # bps
    return pd.DataFrame(
        {
            "signed_imbalance_last": x,
            "spx_ret_open_to_close_bps": y,
            "spx_ret_1550_1600_bps": y * 0.5,
        }
    )


def test_correlate_returns_expected_fields() -> None:
    df = _panel_slice(100, signal_strength=0.5)
    res = eod_analysis.correlate(
        df, "signed_imbalance_last", "spx_ret_open_to_close_bps"
    )
    assert res.feature == "signed_imbalance_last"
    assert res.target == "spx_ret_open_to_close_bps"
    assert res.n == 100
    # With a strong signal, rho should be positive and significant
    assert res.rho > 0.3
    assert res.p_value < 0.01


def test_correlate_zero_signal_low_rho() -> None:
    df = _panel_slice(100, signal_strength=0.0)
    res = eod_analysis.correlate(
        df, "signed_imbalance_last", "spx_ret_open_to_close_bps"
    )
    # With pure noise, |rho| should be small
    assert abs(res.rho) < 0.25


def test_correlate_skips_nan_rows() -> None:
    df = pd.DataFrame(
        {
            "signed_imbalance_last": [1, 2, 3, np.nan, 5],
            "spx_ret_open_to_close_bps": [10, 20, 30, 40, np.nan],
        }
    )
    res = eod_analysis.correlate(
        df, "signed_imbalance_last", "spx_ret_open_to_close_bps"
    )
    assert res.n == 3  # rows with both fields present


def test_verdict_edge_found_high_rho_low_p() -> None:
    results = [
        eod_analysis.CorrResult(
            feature="signed_imbalance_last",
            target="spx_ret_open_to_close_bps",
            n=200,
            rho=0.25,
            p_value=0.001,
            pearson_r=0.22,
        )
    ]
    verdict, _ = eod_analysis._verdict(results, decile=None)
    assert verdict == "EDGE FOUND"


def test_verdict_no_edge_below_thresholds() -> None:
    results = [
        eod_analysis.CorrResult(
            feature="signed_imbalance_last",
            target="spx_ret_open_to_close_bps",
            n=200,
            rho=0.10,
            p_value=0.04,
            pearson_r=0.09,
        ),
        eod_analysis.CorrResult(
            feature="signed_imbalance_last",
            target="spx_ret_1550_1600_bps",
            n=50,
            rho=-0.05,
            p_value=0.50,
            pearson_r=-0.04,
        ),
    ]
    verdict, _ = eod_analysis._verdict(results, decile=None)
    assert verdict == "NO EDGE"


def test_verdict_no_edge_when_rho_just_below_threshold() -> None:
    # 0.13 is below the 0.15 threshold even at p=0.01
    results = [
        eod_analysis.CorrResult(
            feature="signed_imbalance_last",
            target="spx_ret_open_to_close_bps",
            n=248,
            rho=0.13,
            p_value=0.01,
            pearson_r=0.12,
        )
    ]
    verdict, _ = eod_analysis._verdict(results, decile=None)
    assert verdict == "NO EDGE"


def test_corr_result_md_row_formatting() -> None:
    res = eod_analysis.CorrResult(
        feature="foo", target="bar", n=100, rho=0.123, p_value=0.456, pearson_r=-0.789
    )
    row = res.as_md_row()
    assert "foo" in row
    assert "bar" in row
    assert "100" in row
    assert "+0.123" in row
    assert "0.4560" in row
    assert "-0.789" in row
