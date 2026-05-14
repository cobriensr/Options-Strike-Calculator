"""Tests for the SPX target-derivation helpers in eod_join.

DB-dependent paths (`_load_spx_daily_from_db`, `_load_spx_close_window`) are
exercised only via the full `build_eod_panel` smoke run; these tests cover
the pure derivation logic that doesn't need Postgres.
"""

from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd

from src.imbalance import eod_join


def _daily_frame(rows: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(rows).set_index("date")
    return df.astype(float)


def test_derive_daily_targets_open_close_overnight_and_next_day() -> None:
    daily = _daily_frame(
        [
            {
                "date": date(2026, 5, 8),
                "spx_open": 7400,
                "spx_high": 7420,
                "spx_low": 7390,
                "spx_close": 7410,
            },
            {
                "date": date(2026, 5, 9),
                "spx_open": 7415,
                "spx_high": 7430,
                "spx_low": 7405,
                "spx_close": 7425,
            },
            {
                "date": date(2026, 5, 12),
                "spx_open": 7440,
                "spx_high": 7460,
                "spx_low": 7430,
                "spx_close": 7450,
            },
        ]
    )
    out = eod_join._derive_daily_targets(daily)

    np.testing.assert_allclose(
        out.loc[date(2026, 5, 8), "spx_ret_open_to_close_bps"],
        (7410 / 7400 - 1) * 10_000,
    )
    np.testing.assert_allclose(
        out.loc[date(2026, 5, 9), "spx_overnight_gap_bps"],
        (7415 / 7410 - 1) * 10_000,
    )
    # First day has no prev close → NaN
    assert pd.isna(out.loc[date(2026, 5, 8), "spx_overnight_gap_bps"])
    # Last day has no next close → next-day cols are NaN
    assert pd.isna(out.loc[date(2026, 5, 12), "spx_next_day_ret_bps"])
    np.testing.assert_allclose(
        out.loc[date(2026, 5, 8), "spx_next_day_ret_bps"],
        (7425 / 7415 - 1) * 10_000,
    )


def test_derive_high_res_target_basic() -> None:
    window = pd.DataFrame(
        {
            "spx_price_1550": [7400.0, 7400.0],
            "spx_price_1559": [7407.4, 7396.3],
        },
        index=[date(2026, 5, 11), date(2026, 5, 12)],
    )
    out = eod_join._derive_high_res_target(window)
    np.testing.assert_allclose(
        out.loc[date(2026, 5, 11), "spx_ret_1550_1600_bps"], 10.0
    )
    np.testing.assert_allclose(
        out.loc[date(2026, 5, 12), "spx_ret_1550_1600_bps"], -5.0
    )


def test_derive_high_res_target_empty_passthrough() -> None:
    out = eod_join._derive_high_res_target(pd.DataFrame())
    assert out.empty


def test_bps_helper() -> None:
    num = pd.Series([110, 99, 100])
    denom = pd.Series([100, 100, 100])
    out = eod_join._bps(num, denom)
    np.testing.assert_allclose(out.to_numpy(), [1000.0, -100.0, 0.0])


def test_bps_handles_nan() -> None:
    num = pd.Series([100, np.nan, 100], dtype="float64")
    denom = pd.Series([100, 100, np.nan], dtype="float64")
    out = eod_join._bps(num, denom)
    np.testing.assert_allclose(out.iloc[0], 0.0)
    assert pd.isna(out.iloc[1])
    assert pd.isna(out.iloc[2])
