"""Unit tests for Setup 4: basis-stress-fade."""

from __future__ import annotations

import pandas as pd

from setups_backtest.evaluators.setup_4_basis_stress import (
    EVALUATOR,
    _Setup4Context,
)
from setups_backtest.harness import Direction


def _utc(ts: str) -> pd.Timestamp:
    return pd.Timestamp(ts, tz="UTC")


def _es_bars(n: int = 60, base: float = 6000.0) -> pd.DataFrame:
    start = pd.Timestamp("2026-03-15", tz="UTC") + pd.Timedelta(hours=13, minutes=30)
    rows = []
    for i in range(n):
        p = base + i * 0.5
        rows.append(
            (
                (start + pd.Timedelta(minutes=i)).isoformat(),
                p,
                p + 1,
                p - 1,
                p + 0.25,
                100,
            )
        )
    return pd.DataFrame(
        rows, columns=["ts", "open", "high", "low", "close", "volume"]
    ).assign(ts=lambda d: pd.to_datetime(d["ts"], utc=True), symbol="ESM6")


def _spx_with_basis(es_close: float, basis: float, decision_ts: pd.Timestamp) -> pd.DataFrame:
    """SPX bar one minute before decision_ts where SPX = es_close - basis."""
    return pd.DataFrame(
        {
            "ts": [decision_ts - pd.Timedelta(minutes=1)],
            "close": [es_close - basis],
        }
    )


def _gamma_value(dealer_g: float, decision_ts: pd.Timestamp) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "ts": [decision_ts - pd.Timedelta(minutes=1)],
            "net_gamma": [dealer_g],
        }
    )


def test_no_signal_when_data_unavailable():
    bars = _es_bars()
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    ctx = _Setup4Context(
        conn=None,
        pg=None,
        spx_bars=pd.DataFrame(),
        dealer_gamma=pd.DataFrame(),
        cl_bars=pd.DataFrame(),
        vix_bars=pd.DataFrame(),
        data_available=False,
        unavailable_reason="test",
    )
    assert EVALUATOR.evaluate_minute(decision_ts, ctx, bars) is None


def test_short_signal_fires_on_basis_stress():
    bars = _es_bars()
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    es_close = float(bars.iloc[-1]["close"])
    ctx = _Setup4Context(
        conn=None,
        pg=None,
        spx_bars=_spx_with_basis(es_close, basis=6.0, decision_ts=decision_ts),
        dealer_gamma=_gamma_value(dealer_g=1e9, decision_ts=decision_ts),
        cl_bars=pd.DataFrame(columns=["ts", "close"]),
        vix_bars=pd.DataFrame(columns=["ts", "close"]),
        data_available=True,
    )
    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, bars)
    assert sig is not None
    assert sig.direction is Direction.SHORT
    assert sig.stop_price > es_close
    assert sig.target_price < es_close
    assert sig.metadata["basis"] == 6.0


def test_no_signal_when_basis_below_threshold():
    bars = _es_bars()
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    es_close = float(bars.iloc[-1]["close"])
    ctx = _Setup4Context(
        conn=None,
        pg=None,
        spx_bars=_spx_with_basis(es_close, basis=3.0, decision_ts=decision_ts),
        dealer_gamma=_gamma_value(dealer_g=1e9, decision_ts=decision_ts),
        cl_bars=pd.DataFrame(columns=["ts", "close"]),
        vix_bars=pd.DataFrame(columns=["ts", "close"]),
        data_available=True,
    )
    assert EVALUATOR.evaluate_minute(decision_ts, ctx, bars) is None


def test_no_signal_when_dealer_gamma_negative():
    bars = _es_bars()
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    es_close = float(bars.iloc[-1]["close"])
    ctx = _Setup4Context(
        conn=None,
        pg=None,
        spx_bars=_spx_with_basis(es_close, basis=6.0, decision_ts=decision_ts),
        dealer_gamma=_gamma_value(dealer_g=-1e9, decision_ts=decision_ts),
        cl_bars=pd.DataFrame(columns=["ts", "close"]),
        vix_bars=pd.DataFrame(columns=["ts", "close"]),
        data_available=True,
    )
    assert EVALUATOR.evaluate_minute(decision_ts, ctx, bars) is None


def test_vix_spike_disqualifies():
    bars = _es_bars()
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    es_close = float(bars.iloc[-1]["close"])
    vix_rows = [
        {"ts": decision_ts - pd.Timedelta(minutes=4), "close": 18.0},
        {"ts": decision_ts - pd.Timedelta(minutes=1), "close": 21.0},  # +3 in 4m
    ]
    vix = pd.DataFrame(vix_rows)
    vix["ts"] = pd.to_datetime(vix["ts"], utc=True)
    ctx = _Setup4Context(
        conn=None,
        pg=None,
        spx_bars=_spx_with_basis(es_close, basis=6.0, decision_ts=decision_ts),
        dealer_gamma=_gamma_value(dealer_g=1e9, decision_ts=decision_ts),
        cl_bars=pd.DataFrame(columns=["ts", "close"]),
        vix_bars=vix,
        data_available=True,
    )
    assert EVALUATOR.evaluate_minute(decision_ts, ctx, bars) is None
