"""Tests for ml/src/flow_outcomes.py — touch-ITM win rule + path diagnostics."""

from __future__ import annotations

from datetime import UTC, date as dt_date, datetime

import polars as pl

from flow_outcomes import compute_outcomes, synthesize_minute_bars


# --- synthesize_minute_bars --------------------------------------


def _flow_row(
    *,
    minute: int,
    second: int = 0,
    symbol: str = "SPY",
    underlying: float = 650.0,
) -> dict:
    return {
        "executed_at": datetime(2026, 4, 22, 14, minute, second, tzinfo=UTC),
        "underlying_symbol": symbol,
        "underlying_price": underlying,
    }


def test_synthesize_minute_bars_takes_last_close_per_minute() -> None:
    df = pl.DataFrame(
        [
            _flow_row(minute=30, second=0, underlying=650.0),
            _flow_row(minute=30, second=30, underlying=651.0),
            _flow_row(minute=30, second=59, underlying=650.5),  # last in minute 14:30
            _flow_row(minute=31, second=10, underlying=652.0),
        ]
    )
    bars = synthesize_minute_bars(df)
    assert bars.height == 2
    bar_30 = bars.filter(pl.col("minute") == datetime(2026, 4, 22, 14, 30, tzinfo=UTC))
    assert bar_30["close"][0] == 650.5
    assert bar_30["high"][0] == 651.0
    assert bar_30["low"][0] == 650.0


def test_synthesize_minute_bars_separates_by_underlying() -> None:
    df = pl.DataFrame(
        [
            _flow_row(minute=30, symbol="SPY", underlying=650.0),
            _flow_row(minute=30, symbol="QQQ", underlying=550.0),
            _flow_row(minute=31, symbol="SPY", underlying=651.0),
        ]
    )
    bars = synthesize_minute_bars(df)
    assert bars.height == 3  # (SPY, 30), (QQQ, 30), (SPY, 31)
    spy_bars = bars.filter(pl.col("underlying_symbol") == "SPY")
    assert spy_bars.height == 2


# --- compute_outcomes: shared fixtures ---------------------------


def _outlier(
    *,
    option_type: str,
    side: str,
    strike: float,
    print_minute: int = 30,
    symbol: str = "SPY",
) -> dict:
    """Outlier print at 14:HH:00 UTC = 09:HH CT (in DST)."""
    return {
        "executed_at": datetime(2026, 4, 22, 14, print_minute, tzinfo=UTC),
        "underlying_symbol": symbol,
        "strike": strike,
        "option_type": option_type,
        "side": side,
    }


def _make_minute_bars(
    *,
    underlying_path: list[tuple[int, float]],
    symbol: str = "SPY",
) -> pl.DataFrame:
    """Build a minute_bars DataFrame from a list of (minute_offset_from_14:00, close).
    Each bar uses close=high=low for simplicity in tests.
    """
    rows = []
    for minute_offset, close in underlying_path:
        minute = datetime(2026, 4, 22, 14 + minute_offset // 60, minute_offset % 60, tzinfo=UTC)
        rows.append(
            {
                "underlying_symbol": symbol,
                "minute": minute,
                "high": close,
                "low": close,
                "close": close,
            }
        )
    return pl.DataFrame(rows)


# --- compute_outcomes: buyer wins --------------------------------


def test_call_buy_wins_when_underlying_touches_strike_late() -> None:
    """User's NDXP-style example: bought 27200C at 10:00, doesn't touch until 14:55.
    Should be a WIN."""
    outliers = pl.DataFrame(
        [_outlier(option_type="call", side="ask", strike=650.0, print_minute=30)]
    )
    # SPY drifts from 645 → 650 over 4 hours (touches 650 at minute=270 = 18:30 UTC = 13:30 CT)
    bars = _make_minute_bars(
        underlying_path=[
            (40, 645.0),
            (60, 646.0),
            (120, 647.5),
            (240, 649.0),
            (270, 650.0),  # touches strike here
            (300, 649.5),  # round-trips back below
        ]
    )
    out = compute_outcomes(outliers, bars)
    assert out["won"][0] is True
    assert out["time_to_itm_min"][0] == 240  # 14:30 → 18:30 = 240 min
    assert out["time_in_itm_min"][0] == 1  # only one bar at exactly 650
    # mfe = max_high (650) - strike (650) = 0
    assert out["mfe_pts"][0] == 0.0
    # round-tripped: close (649.5) is below strike → close_won False
    assert out["close_won"][0] is False


def test_put_buy_wins_when_underlying_drops_below_strike() -> None:
    outliers = pl.DataFrame(
        [_outlier(option_type="put", side="ask", strike=640.0, print_minute=30)]
    )
    bars = _make_minute_bars(
        underlying_path=[(40, 645.0), (60, 642.0), (90, 639.0)]  # touches at minute 90
    )
    out = compute_outcomes(outliers, bars)
    assert out["won"][0] is True
    assert out["time_to_itm_min"][0] == 60  # 14:30 → 15:30 = 60 min
    assert out["close_won"][0] is True  # closed below


def test_call_buy_loses_when_never_touches_strike() -> None:
    outliers = pl.DataFrame(
        [_outlier(option_type="call", side="ask", strike=660.0, print_minute=30)]
    )
    bars = _make_minute_bars(
        underlying_path=[(40, 645.0), (60, 650.0), (120, 655.0), (240, 658.0)]
    )
    out = compute_outcomes(outliers, bars)
    assert out["won"][0] is False
    assert out["time_to_itm_min"][0] is None
    assert out["time_in_itm_min"][0] == 0
    # MFE = max_high (658) - strike (660) = -2  (favorable direction but never reached)
    assert out["mfe_pts"][0] == -2.0


# --- compute_outcomes: seller wins --------------------------------


def test_put_sell_wins_when_underlying_stays_above_strike() -> None:
    """User's NDXP-style: sold 27000P at 10:53, NDX never touches → win."""
    outliers = pl.DataFrame(
        [_outlier(option_type="put", side="bid", strike=640.0, print_minute=30)]
    )
    # SPY stays 645–650 entire session, never touches 640
    bars = _make_minute_bars(
        underlying_path=[(40, 645.0), (60, 647.0), (120, 648.5), (240, 650.0)]
    )
    out = compute_outcomes(outliers, bars)
    assert out["won"][0] is True
    # MAE = min_low (645) - strike (640) = +5 (comfortable)
    assert out["mae_pts"][0] == 5.0


def test_put_sell_loses_when_underlying_breaches_strike_at_any_point() -> None:
    """Even a brief intraday breach kills a seller's win — has to roll/cover."""
    outliers = pl.DataFrame(
        [_outlier(option_type="put", side="bid", strike=640.0, print_minute=30)]
    )
    bars = _make_minute_bars(
        underlying_path=[
            (40, 645.0),
            (60, 639.5),  # brief breach below 640
            (120, 645.0),  # recovers
            (240, 648.0),  # closes well above
        ]
    )
    out = compute_outcomes(outliers, bars)
    # Brief touch loses for the seller — the spec is explicit about this
    assert out["won"][0] is False
    # MAE = 639.5 - 640 = -0.5 (breached by 0.5 pts)
    assert out["mae_pts"][0] == -0.5
    # close_won (stricter): underlying closed at 648 > 640, so put-seller's close wins
    assert out["close_won"][0] is True


def test_call_sell_wins_when_underlying_stays_below_strike() -> None:
    outliers = pl.DataFrame(
        [_outlier(option_type="call", side="bid", strike=660.0, print_minute=30)]
    )
    bars = _make_minute_bars(
        underlying_path=[(40, 645.0), (60, 650.0), (120, 655.0), (240, 658.0)]
    )
    out = compute_outcomes(outliers, bars)
    assert out["won"][0] is True
    # MAE = 660 - 658 (max_high) = 2 pts away (good for seller)
    assert out["mae_pts"][0] == 2.0


# --- compute_outcomes: edge cases --------------------------------


def test_compute_outcomes_handles_empty_outliers() -> None:
    empty = pl.DataFrame(
        schema={
            "executed_at": pl.Datetime("us", "UTC"),
            "underlying_symbol": pl.Utf8,
            "strike": pl.Float64,
            "option_type": pl.Utf8,
            "side": pl.Utf8,
        }
    )
    bars = _make_minute_bars(underlying_path=[(0, 650.0)])
    out = compute_outcomes(empty, bars)
    assert out.height == 0
    assert "won" in out.columns


def test_compute_outcomes_undirected_side_returns_null_won() -> None:
    """no_side / mid prints get null `won` — neither buy nor sell semantics."""
    outliers = pl.DataFrame(
        [_outlier(option_type="call", side="no_side", strike=650.0, print_minute=30)]
    )
    bars = _make_minute_bars(underlying_path=[(40, 651.0)])
    out = compute_outcomes(outliers, bars)
    assert out["won"][0] is None


def test_compute_outcomes_filters_to_post_print_window() -> None:
    """A bar BEFORE the print should not be considered for win detection."""
    outliers = pl.DataFrame(
        [_outlier(option_type="call", side="ask", strike=650.0, print_minute=30)]
    )
    bars = _make_minute_bars(
        underlying_path=[
            # Pre-print bar has the strike — should NOT count as a touch
            (10, 651.0),
            # Post-print bars stay below strike → no win
            (40, 649.0),
            (60, 648.0),
        ]
    )
    out = compute_outcomes(outliers, bars)
    assert out["won"][0] is False


def test_compute_outcomes_filters_to_pre_session_close() -> None:
    """A bar after 20:00 UTC (15:00 CT close) should be excluded."""
    outliers = pl.DataFrame(
        [_outlier(option_type="call", side="ask", strike=650.0, print_minute=30)]
    )
    # Print at 14:30, session close at 20:00. Bar at 20:30 should be ignored.
    bars = pl.DataFrame(
        [
            {
                "underlying_symbol": "SPY",
                "minute": datetime(2026, 4, 22, 15, 0, tzinfo=UTC),
                "high": 649.0,
                "low": 649.0,
                "close": 649.0,
            },
            {
                "underlying_symbol": "SPY",
                "minute": datetime(2026, 4, 22, 20, 30, tzinfo=UTC),  # after-hours
                "high": 651.0,  # would touch the strike if counted
                "low": 651.0,
                "close": 651.0,
            },
        ]
    )
    out = compute_outcomes(outliers, bars)
    # The 20:30 touch should NOT count
    assert out["won"][0] is False
