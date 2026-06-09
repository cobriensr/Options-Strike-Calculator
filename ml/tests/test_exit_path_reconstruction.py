import pandas as pd
import pytest

import exit_engine.path_reconstruction as pr


def _trades(rows):
    return pd.DataFrame(
        rows,
        columns=["executed_at", "option_chain_id", "nbbo_bid", "nbbo_ask", "price", "canceled"],
    ).astype({"executed_at": "datetime64[ns, UTC]"})


def test_minute_path_drops_canceled_and_computes_mid():
    t = _trades([
        ("2026-04-13T14:30:10Z", "X", 1.0, 1.2, 1.1, False),
        ("2026-04-13T14:30:50Z", "X", 1.2, 1.4, 1.3, False),   # same minute -> last wins
        ("2026-04-13T14:31:10Z", "X", 5.0, 5.0, 5.0, "t"),      # canceled -> dropped
        ("2026-04-13T14:32:10Z", "X", 2.0, 2.4, 2.2, False),
    ])
    path = pr.build_minute_path(t, entry_ts=pd.Timestamp("2026-04-13T14:30:00Z"), entry_price=1.0)
    assert path["mid"].tolist() == pytest.approx([1.3, 2.2])  # 14:30 last mid, 14:32 mid; 14:31 canceled gone
    assert path["minutes_since_entry"].tolist() == [0.0, 2.0]
    assert path["spread"].iloc[1] == pytest.approx(0.4)


def test_assemble_multiday_concats_sessions_in_order():
    day1 = _trades([("2026-04-13T19:00:10Z", "X", 1.0, 1.2, 1.1, False)])
    day2 = _trades([("2026-04-14T14:30:10Z", "X", 3.0, 3.2, 3.1, False)])
    path = pr.assemble_multiday_path(
        [day1, day2], entry_ts=pd.Timestamp("2026-04-13T19:00:00Z"), entry_price=1.0
    )
    assert len(path) == 2
    assert path["minutes_since_entry"].is_monotonic_increasing
    assert path["mid"].iloc[-1] == pytest.approx(3.1)


def test_build_minute_path_coerces_decimal_nbbo():
    from decimal import Decimal
    t = pd.DataFrame(
        [("2026-01-02T14:30:10Z", "X", Decimal("1.00"), Decimal("1.20"), Decimal("1.10"), False)],
        columns=["executed_at", "option_chain_id", "nbbo_bid", "nbbo_ask", "price", "canceled"],
    ).astype({"executed_at": "datetime64[ns, UTC]"})
    path = pr.build_minute_path(t, entry_ts=pd.Timestamp("2026-01-02T14:30:00Z"), entry_price=1.0)
    assert path["mid"].iloc[0] == pytest.approx(1.10)
    assert path["spread"].iloc[0] == pytest.approx(0.20)
    # mid must be a real float, not Decimal/object
    assert path["mid"].dtype == "float64"


def test_minute_path_drops_zero_mid_minutes():
    """A minute with 0/0 NBBO (no market) must be excluded from the path."""
    t = _trades([
        ("2026-04-13T14:30:10Z", "X", 1.0, 1.2, 1.1, False),   # minute 0 -> mid 1.1
        ("2026-04-13T14:31:10Z", "X", 0.0, 0.0, 0.0, False),    # minute 1 -> mid 0 (no market)
        ("2026-04-13T14:32:10Z", "X", 2.0, 2.4, 2.2, False),    # minute 2 -> mid 2.2
    ])
    path = pr.build_minute_path(t, entry_ts=pd.Timestamp("2026-04-13T14:30:00Z"), entry_price=1.0)
    # Zero-mid minute at 14:31 must be absent
    assert len(path) == 2
    assert path["mid"].tolist() == pytest.approx([1.1, 2.2])
    # minutes_since_entry reflects only the surviving minutes (0 and 2)
    assert path["minutes_since_entry"].tolist() == pytest.approx([0.0, 2.0])


def test_build_minute_path_carries_greeks_and_coerces_decimal():
    from decimal import Decimal
    t = pd.DataFrame(
        [
            ("2026-01-02T14:30:10Z", "X", Decimal("1.0"), Decimal("1.2"), Decimal("1.1"), False,
             Decimal("0.45"), Decimal("0.30"), Decimal("0.02"), Decimal("500.0"), Decimal("495.0"), "call"),
        ],
        columns=["executed_at", "option_chain_id", "nbbo_bid", "nbbo_ask", "price", "canceled",
                 "implied_volatility", "delta", "gamma", "underlying_price", "strike", "option_type"],
    ).astype({"executed_at": "datetime64[ns, UTC]"})
    path = pr.build_minute_path(t, entry_ts=pd.Timestamp("2026-01-02T14:30:00Z"), entry_price=1.0)
    assert path["implied_volatility"].iloc[0] == pytest.approx(0.45)
    assert path["delta"].iloc[0] == pytest.approx(0.30)
    assert path["gamma"].iloc[0] == pytest.approx(0.02)
    assert path["underlying_price"].iloc[0] == pytest.approx(500.0)
    assert path["strike"].iloc[0] == pytest.approx(495.0)
    assert path["option_type"].iloc[0] == "call"
    assert path["implied_volatility"].dtype == "float64"


def test_build_minute_path_without_greeks_still_works():
    t = pd.DataFrame(
        [("2026-04-13T14:30:10Z", "X", 1.0, 1.2, 1.1, False)],
        columns=["executed_at", "option_chain_id", "nbbo_bid", "nbbo_ask", "price", "canceled"],
    ).astype({"executed_at": "datetime64[ns, UTC]"})
    path = pr.build_minute_path(t, entry_ts=pd.Timestamp("2026-04-13T14:30:00Z"), entry_price=1.0)
    assert path["mid"].iloc[0] == pytest.approx(1.1)
    assert "implied_volatility" not in path.columns
