"""Tests for the Phase 5 cross-venue index aggregator."""

from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd

from src.imbalance import index_aggregator as agg


def _panel_row(
    *,
    d: date,
    symbol: str,
    dataset: str,
    auction_type: str = "C",
    signed_first: float = 0.0,
    signed_last: float = 0.0,
    ref_first: float = 100.0,
    ref_last: float = 100.0,
    daily_ret: float = 0.0,
) -> dict:
    return {
        "date": d,
        "symbol": symbol,
        "dataset": dataset,
        "auction_type": auction_type,
        "signed_imbalance_first": signed_first,
        "signed_imbalance_last": signed_last,
        "ref_price_first": ref_first,
        "ref_price_last": ref_last,
        "spx_ret_open_to_close_bps": daily_ret,
        "spx_ret_1550_1600_bps": daily_ret * 0.3,
    }


def test_filter_primary_drops_secondary_venues() -> None:
    rows = [
        _panel_row(d=date(2026, 5, 12), symbol="SPY", dataset="ARCX.PILLAR"),
        _panel_row(d=date(2026, 5, 12), symbol="SPY", dataset="XNAS.ITCH"),
        _panel_row(d=date(2026, 5, 12), symbol="AAPL", dataset="XNAS.ITCH"),
        _panel_row(d=date(2026, 5, 12), symbol="JPM", dataset="XNYS.PILLAR"),
    ]
    panel = pd.DataFrame(rows)
    out = agg._filter_primary(panel)
    # SPY-on-XNAS should be dropped (SPY's primary is ARCX)
    spy = out[out["symbol"] == "SPY"]
    assert len(spy) == 1
    assert (spy["dataset"] == "ARCX.PILLAR").all()
    # AAPL on XNAS kept; JPM on XNYS kept
    assert set(out[["symbol", "dataset"]].apply(tuple, axis=1)) == {
        ("SPY", "ARCX.PILLAR"),
        ("AAPL", "XNAS.ITCH"),
        ("JPM", "XNYS.PILLAR"),
    }


def test_aggregate_notional_sums_signed_qty_times_price() -> None:
    rows = [
        _panel_row(d=date(2026, 5, 12), symbol="SPY", dataset="ARCX.PILLAR",
                   signed_first=1_000, ref_first=400.0),
        _panel_row(d=date(2026, 5, 12), symbol="IWM", dataset="ARCX.PILLAR",
                   signed_first=-500, ref_first=200.0),
        # Different date — should not contribute
        _panel_row(d=date(2026, 5, 13), symbol="SPY", dataset="ARCX.PILLAR",
                   signed_first=2_000, ref_first=400.0),
    ]
    out = agg.aggregate_notional(pd.DataFrame(rows), {"SPY", "IWM"}, "first")
    assert out.loc[date(2026, 5, 12), "notional"] == 1_000 * 400 + (-500) * 200
    assert out.loc[date(2026, 5, 13), "notional"] == 2_000 * 400


def test_aggregate_notional_rejects_bad_position() -> None:
    try:
        agg.aggregate_notional(pd.DataFrame(), set(), "middle")
    except ValueError as e:
        assert "position must be" in str(e)
    else:
        raise AssertionError("expected ValueError")


def test_correlate_group_returns_filled_fields_with_signal() -> None:
    rng = np.random.default_rng(seed=7)
    dates = pd.date_range("2025-05-13", periods=120, freq="B").date
    rows = []
    for d in dates:
        notional_seed = float(rng.normal(0, 100_000_000))
        # Construct a real positive relationship: ret = 0.5 * notional/scale + noise
        ret = notional_seed * 1e-7 + rng.normal(0, 20)
        rows.append(
            _panel_row(d=d, symbol="SPY", dataset="ARCX.PILLAR",
                       signed_first=notional_seed / 400, ref_first=400.0,
                       daily_ret=ret)
        )
    panel = pd.DataFrame(rows)
    res = agg.correlate_group(
        panel, panel, "test", {"SPY"}, "first", "spx_ret_open_to_close_bps"
    )
    assert res.group == "test"
    assert res.feature == "notional_first"
    assert res.n == 120
    assert res.rho > 0.3
    assert res.p_value < 0.01
    assert res.r_squared > 0.05


def test_run_phase5_returns_predictive_and_explanatory_decisions(tmp_path) -> None:
    rng = np.random.default_rng(seed=11)
    dates = pd.date_range("2025-05-13", periods=60, freq="B").date
    rows = []
    for d in dates:
        # Symbols populated for two venue groups so all branches resolve
        for sym, ds in [("SPY", "ARCX.PILLAR"), ("AAPL", "XNAS.ITCH"), ("JPM", "XNYS.PILLAR")]:
            sf = float(rng.normal(0, 50_000))
            sl = sf * 0.3 + float(rng.normal(0, 5_000))
            rows.append(
                _panel_row(d=d, symbol=sym, dataset=ds,
                           signed_first=sf, signed_last=sl,
                           ref_first=300.0, ref_last=300.0,
                           daily_ret=float(rng.normal(0, 30)))
            )
    panel = pd.DataFrame(rows)
    results, decision = agg.run_phase5(panel)
    assert {"predictive", "explanatory", "recommendation"} <= set(decision)
    assert decision["predictive"]["position"] == "first"
    assert decision["explanatory"]["position"] == "last"
    # All three groups × 4 (feature × target) = 12 rows
    assert len(results) == 12


def test_decision_block_renders_expected_fields() -> None:
    decision = {
        "position": "first",
        "kind": "predictive (sample)",
        "nyse_r2": 0.0211,
        "all_r2": 0.0025,
        "ratio": 0.118,
        "nasdaq_adds_material_info": False,
    }
    lines = agg._decision_block(decision)
    joined = "\n".join(lines)
    assert "predictive (sample)" in joined
    assert "0.0211" in joined
    assert "0.0025" in joined
    assert "0.118" in joined
    assert "False" in joined
