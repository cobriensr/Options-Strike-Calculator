"""Tests for ml/src/flow_outliers.py — scoring + enrichment + summarization."""

from __future__ import annotations

from datetime import UTC, date as dt_date, datetime

import polars as pl
import pytest

from flow_outliers import (
    DELTA_WEIGHTED_NOTIONAL_USD,
    PREMIUM_TIER_1_USD,
    PREMIUM_TIER_2_USD,
    add_bucket_columns,
    enrich_print_features,
    score_prints,
    summarize_outliers,
)


def _row(**overrides) -> dict:
    """Default schema-aligned row; overrides set the interesting fields."""
    base = {
        "executed_at": datetime(2026, 4, 22, 14, 30, tzinfo=UTC),
        "underlying_symbol": "SPY",
        "option_chain_id": "SPY260422C00650000",
        "side": "ask",
        "strike": 650.0,
        "option_type": "call",
        "expiry": dt_date(2026, 4, 22),
        "underlying_price": 645.0,
        "nbbo_bid": 1.20,
        "nbbo_ask": 1.30,
        "ewma_nbbo_bid": 1.20,
        "ewma_nbbo_ask": 1.30,
        "price": 1.25,
        "size": 100,
        "premium": 100_000.0,
        "volume": 5000,
        "open_interest": 10000,
        "implied_volatility": 0.25,
        "delta": 0.30,
        "theta": -0.05,
        "gamma": 0.01,
        "vega": 0.10,
        "rho": -0.02,
        "theo": 1.25,
        "sector": None,
        "exchange": "XPHO",
        "report_flags": "{}",
        "canceled": False,
        "upstream_condition_detail": "auto",
        "equity_type": "ETF",
    }
    base.update(overrides)
    return base


# --- enrich_print_features --------------------------------------


def test_enrich_computes_spread_width_pct() -> None:
    df = pl.DataFrame([_row(nbbo_bid=1.0, nbbo_ask=1.10, price=1.05)])
    out = enrich_print_features(df)
    # spread = 0.10, mid = 1.05, width% = 0.0952
    assert out["spread_width_pct"][0] == pytest.approx(0.10 / 1.05, rel=1e-6)


def test_enrich_nbbo_position_at_ask_is_one() -> None:
    df = pl.DataFrame([_row(nbbo_bid=1.0, nbbo_ask=1.10, price=1.10)])
    out = enrich_print_features(df)
    assert out["nbbo_position"][0] == pytest.approx(1.0)


def test_enrich_nbbo_position_at_bid_is_neg_one() -> None:
    df = pl.DataFrame([_row(nbbo_bid=1.0, nbbo_ask=1.10, price=1.0)])
    out = enrich_print_features(df)
    assert out["nbbo_position"][0] == pytest.approx(-1.0)


def test_enrich_nbbo_position_at_mid_is_zero() -> None:
    df = pl.DataFrame([_row(nbbo_bid=1.0, nbbo_ask=1.10, price=1.05)])
    out = enrich_print_features(df)
    assert out["nbbo_position"][0] == pytest.approx(0.0)


def test_enrich_distance_from_spot() -> None:
    df = pl.DataFrame([_row(strike=660.0, underlying_price=645.0)])
    out = enrich_print_features(df)
    assert out["distance_from_spot_pts"][0] == pytest.approx(15.0)
    assert out["distance_from_spot_pct"][0] == pytest.approx(15.0 / 645.0)


def test_enrich_repeat_count_partitions_by_chain() -> None:
    """Three big prints on chain X, two on chain Y, one tiny on X — repeat counts
    should be 0,1,2 for X-bigs and 0,1 for Y-bigs and 0 for the tiny X print."""
    df = pl.DataFrame(
        [
            _row(option_chain_id="X", premium=600_000.0, executed_at=datetime(2026, 4, 22, 14, 0, tzinfo=UTC)),
            _row(option_chain_id="X", premium=700_000.0, executed_at=datetime(2026, 4, 22, 14, 5, tzinfo=UTC)),
            _row(option_chain_id="Y", premium=600_000.0, executed_at=datetime(2026, 4, 22, 14, 1, tzinfo=UTC)),
            _row(option_chain_id="X", premium=100_000.0, executed_at=datetime(2026, 4, 22, 14, 10, tzinfo=UTC)),
            _row(option_chain_id="X", premium=800_000.0, executed_at=datetime(2026, 4, 22, 14, 15, tzinfo=UTC)),
            _row(option_chain_id="Y", premium=900_000.0, executed_at=datetime(2026, 4, 22, 14, 20, tzinfo=UTC)),
        ]
    )
    out = enrich_print_features(df).sort(["option_chain_id", "executed_at"])
    # X chain: big(0), big(1), tiny(2 prior bigs), big(2 prior bigs)
    # Y chain: big(0), big(1)
    x = out.filter(pl.col("option_chain_id") == "X").sort("executed_at")
    y = out.filter(pl.col("option_chain_id") == "Y").sort("executed_at")
    assert x["repeat_print_count_today"].to_list() == [0, 1, 2, 2]
    assert y["repeat_print_count_today"].to_list() == [0, 1]


def test_enrich_handles_zero_spread() -> None:
    """If nbbo_ask == nbbo_bid, nbbo_position should be null, not divide-by-zero."""
    df = pl.DataFrame([_row(nbbo_bid=1.05, nbbo_ask=1.05, price=1.05)])
    out = enrich_print_features(df)
    assert out["nbbo_position"][0] is None


# --- score_prints -----------------------------------------------


def test_score_prints_known_outlier_pattern() -> None:
    """The NDXP-pattern print: 0DTE, large premium, ask-side, sweep flagged.
    Should score at least 4 (zero_dte + premium_1m + premium_5m + sweep).
    """
    df = pl.DataFrame(
        [
            _row(
                premium=6_500_000.0,
                expiry=dt_date(2026, 4, 22),
                executed_at=datetime(2026, 4, 22, 14, 0, tzinfo=UTC),
                report_flags="{intermarket_sweep}",
            )
        ]
    )
    out = score_prints(df)
    assert out["significance_score"][0] >= 4


def test_score_prints_small_print_scores_zero() -> None:
    """A typical small print should score 0."""
    df = pl.DataFrame(
        [
            _row(
                premium=5_000.0,
                expiry=dt_date(2026, 5, 15),  # not 0DTE
                report_flags="{}",
            )
        ]
    )
    out = score_prints(df)
    assert out["significance_score"][0] == 0


def test_score_prints_premium_tiers() -> None:
    rows = [
        _row(premium=999_999.0),  # below tier 1 → 0
        _row(premium=1_000_001.0),  # tier 1 only → 1
        _row(premium=5_000_001.0),  # tier 1 + 2 → 2
    ]
    df = pl.DataFrame(rows)
    out = score_prints(df)
    # Use score_breakdown to inspect just the premium criteria
    breakdowns = out["score_breakdown"].to_list()
    assert breakdowns[0]["c_premium_1m"] == 0
    assert breakdowns[0]["c_premium_5m"] == 0
    assert breakdowns[1]["c_premium_1m"] == 1
    assert breakdowns[1]["c_premium_5m"] == 0
    assert breakdowns[2]["c_premium_1m"] == 1
    assert breakdowns[2]["c_premium_5m"] == 1


def test_score_prints_outside_nbbo() -> None:
    rows = [
        _row(price=1.40, nbbo_ask=1.30, nbbo_bid=1.20),  # above ask
        _row(price=1.10, nbbo_ask=1.30, nbbo_bid=1.20),  # below bid
        _row(price=1.25, nbbo_ask=1.30, nbbo_bid=1.20),  # inside spread
    ]
    df = pl.DataFrame(rows)
    out = score_prints(df)
    breakdowns = out["score_breakdown"].to_list()
    assert breakdowns[0]["c_outside_nbbo"] == 1
    assert breakdowns[1]["c_outside_nbbo"] == 1
    assert breakdowns[2]["c_outside_nbbo"] == 0


def test_score_prints_delta_weighted_size() -> None:
    """abs(size × delta × 100 × spot) >= $10M triggers the criterion."""
    # 1000 × 0.5 × 100 × $200 = $10M exactly → triggers
    triggering = _row(size=1000, delta=0.5, underlying_price=200.0)
    # 100 × 0.3 × 100 × $50 = $150K → doesn't trigger
    not_triggering = _row(size=100, delta=0.3, underlying_price=50.0)
    df = pl.DataFrame([triggering, not_triggering])
    out = score_prints(df)
    breakdowns = out["score_breakdown"].to_list()
    assert breakdowns[0]["c_delta_weighted"] == 1
    assert breakdowns[1]["c_delta_weighted"] == 0


def test_score_prints_sweep_handles_null_report_flags() -> None:
    """Null report_flags (rare but possible from CSV) shouldn't crash. Use
    schema_overrides because a single None in a column infers the dtype as
    Null in Polars; real CSV scans produce Utf8 with null values."""
    df = pl.DataFrame(
        [_row(report_flags=None)],
        schema_overrides={"report_flags": pl.Utf8},
    )
    out = score_prints(df)
    breakdowns = out["score_breakdown"].to_list()
    assert breakdowns[0]["c_sweep"] == 0


def test_score_prints_constants_are_pinned() -> None:
    """Sanity that the spec's locked thresholds match the module constants."""
    assert PREMIUM_TIER_1_USD == 1_000_000
    assert PREMIUM_TIER_2_USD == 5_000_000
    assert DELTA_WEIGHTED_NOTIONAL_USD == 10_000_000


# --- add_bucket_columns -----------------------------------------


def test_signed_direction_call_buy_is_bullish() -> None:
    df = pl.DataFrame([_row(option_type="call", side="ask")])
    out = add_bucket_columns(df)
    assert out["signed_direction"][0] == "bullish_call_buy"


def test_signed_direction_put_sell_is_bullish() -> None:
    df = pl.DataFrame([_row(option_type="put", side="bid")])
    out = add_bucket_columns(df)
    assert out["signed_direction"][0] == "bullish_put_sell"


def test_signed_direction_put_buy_is_bearish() -> None:
    df = pl.DataFrame([_row(option_type="put", side="ask")])
    out = add_bucket_columns(df)
    assert out["signed_direction"][0] == "bearish_put_buy"


def test_signed_direction_call_sell_is_bearish() -> None:
    df = pl.DataFrame([_row(option_type="call", side="bid")])
    out = add_bucket_columns(df)
    assert out["signed_direction"][0] == "bearish_call_sell"


def test_signed_direction_no_side_is_undirected() -> None:
    df = pl.DataFrame([_row(side="no_side")])
    out = add_bucket_columns(df)
    assert out["signed_direction"][0] == "undirected"


def test_time_bucket_morning() -> None:
    # 14:30 UTC = 09:30 CT → "open" bucket (08:30-10:00)
    df = pl.DataFrame([_row(executed_at=datetime(2026, 4, 22, 14, 30, tzinfo=UTC))])
    out = add_bucket_columns(df)
    assert out["time_bucket"][0] == "open"


def test_time_bucket_close() -> None:
    # 19:45 UTC = 14:45 CT → "close" bucket (14:30-15:00)
    df = pl.DataFrame([_row(executed_at=datetime(2026, 4, 22, 19, 45, tzinfo=UTC))])
    out = add_bucket_columns(df)
    assert out["time_bucket"][0] == "close"


def test_time_bucket_after_close() -> None:
    # 20:30 UTC = 15:30 CT → "after_close"
    df = pl.DataFrame([_row(executed_at=datetime(2026, 4, 22, 20, 30, tzinfo=UTC))])
    out = add_bucket_columns(df)
    assert out["time_bucket"][0] == "after_close"


def test_time_bucket_exact_close_boundary_is_after_close() -> None:
    # Exactly 20:00 UTC = exactly 15:00 CT — by spec this is exclusive of
    # the cash session, so it should be "after_close" not "close".
    df = pl.DataFrame([_row(executed_at=datetime(2026, 4, 22, 20, 0, tzinfo=UTC))])
    out = add_bucket_columns(df)
    assert out["time_bucket"][0] == "after_close"


def test_time_bucket_handles_standard_time_dst() -> None:
    """In November (CST = UTC-6), 15:30 UTC should be 09:30 CT = 'open',
    NOT 10:30 CT = 'morning' (which is what a hardcoded UTC-5 offset gives).
    Catches the DST regression."""
    # 2026-11-10 is well into standard time
    df = pl.DataFrame([_row(executed_at=datetime(2026, 11, 10, 15, 30, tzinfo=UTC))])
    out = add_bucket_columns(df)
    assert out["time_bucket"][0] == "open"


def test_dte_bucket_zero() -> None:
    df = pl.DataFrame(
        [
            _row(
                executed_at=datetime(2026, 4, 22, 14, 0, tzinfo=UTC),
                expiry=dt_date(2026, 4, 22),
            )
        ]
    )
    out = add_bucket_columns(df)
    assert out["dte_bucket"][0] == "0DTE"


def test_dte_bucket_buckets() -> None:
    rows = [
        _row(executed_at=datetime(2026, 4, 22, 14, 0, tzinfo=UTC), expiry=dt_date(2026, 4, 23)),  # 1
        _row(executed_at=datetime(2026, 4, 22, 14, 0, tzinfo=UTC), expiry=dt_date(2026, 4, 25)),  # 3
        _row(executed_at=datetime(2026, 4, 22, 14, 0, tzinfo=UTC), expiry=dt_date(2026, 5, 22)),  # 30
    ]
    df = pl.DataFrame(rows)
    out = add_bucket_columns(df)
    assert out["dte_bucket"].to_list() == ["1DTE", "2-7DTE", "8DTE+"]


def test_ticker_family() -> None:
    rows = [
        _row(underlying_symbol="SPX"),
        _row(underlying_symbol="SPXW"),
        _row(underlying_symbol="SPY"),
        _row(underlying_symbol="QQQ"),
        _row(underlying_symbol="NDXP"),
        _row(underlying_symbol="NVDA"),
        _row(underlying_symbol="TSLA"),
    ]
    df = pl.DataFrame(rows)
    out = add_bucket_columns(df)
    assert out["ticker_family"].to_list() == [
        "spx_complex",
        "spx_complex",
        "index_etf",
        "index_etf",
        "index_etf",
        "single_name",
        "single_name",
    ]


# --- summarize_outliers -----------------------------------------


def test_summarize_outliers_without_won_returns_counts_only() -> None:
    df = pl.DataFrame(
        [
            _row(option_type="call", side="ask"),
            _row(option_type="call", side="ask"),
            _row(option_type="put", side="ask"),
        ]
    )
    bucketed = add_bucket_columns(df)
    summary = summarize_outliers(bucketed)
    assert "n" in summary.columns
    assert "win_rate" not in summary.columns
    # Two bullish_call_buy + one bearish_put_buy → 2 buckets total
    assert summary["n"].sum() == 3


def test_summarize_outliers_computes_win_rate_when_won_present() -> None:
    df = pl.DataFrame(
        [
            _row(option_type="call", side="ask"),  # bullish_call_buy bucket
            _row(option_type="call", side="ask"),
        ]
    )
    bucketed = add_bucket_columns(df).with_columns(won=pl.Series([True, False]))
    summary = summarize_outliers(bucketed)
    assert "win_rate" in summary.columns
    bullish_row = summary.filter(pl.col("signed_direction") == "bullish_call_buy")
    assert bullish_row["win_rate"][0] == pytest.approx(0.5)
    assert bullish_row["n_won"][0] == 1


def test_summarize_outliers_custom_group_by() -> None:
    df = pl.DataFrame(
        [
            _row(underlying_symbol="SPX", option_type="call", side="ask"),
            _row(underlying_symbol="NVDA", option_type="call", side="ask"),
        ]
    )
    bucketed = add_bucket_columns(df)
    summary = summarize_outliers(bucketed, group_by=["ticker_family"])
    assert sorted(summary["ticker_family"].to_list()) == ["single_name", "spx_complex"]
