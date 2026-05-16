"""Unit tests for Setup 5: zero-gamma-magnet."""

from __future__ import annotations

import pandas as pd

from setups_backtest.evaluators.setup_5_zg_magnet import EVALUATOR, _Setup5Context
from setups_backtest.harness import Direction


def _utc(ts: str) -> pd.Timestamp:
    return pd.Timestamp(ts, tz="UTC")


def _es_bars(n: int = 30, base: float = 6000.0) -> pd.DataFrame:
    start = pd.Timestamp("2026-03-15", tz="UTC") + pd.Timedelta(hours=13, minutes=30)
    rows = []
    for i in range(n):
        p = base + i * 0.1  # tight, low-ATR series
        rows.append(
            (
                (start + pd.Timedelta(minutes=i)).isoformat(),
                p,
                p + 0.5,
                p - 0.5,
                p + 0.1,
                100,
            )
        )
    return pd.DataFrame(
        rows, columns=["ts", "open", "high", "low", "close", "volume"]
    ).assign(ts=lambda d: pd.to_datetime(d["ts"], utc=True), symbol="ESM6")


def _zg_at(zg: float, decision_ts: pd.Timestamp) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "ts": [decision_ts - pd.Timedelta(minutes=1)],
            "zero_gamma": [zg],
            "confidence": [0.8],
        }
    )


def _gamma(value: float, decision_ts: pd.Timestamp) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "ts": [decision_ts - pd.Timedelta(minutes=1)],
            "net_gamma": [value],
        }
    )


def test_no_signal_when_data_unavailable():
    bars = _es_bars()
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    ctx = _Setup5Context(
        conn=None,
        pg=None,
        zg_levels=pd.DataFrame(),
        dealer_gamma=pd.DataFrame(),
        data_available=False,
        unavailable_reason="test",
    )
    assert EVALUATOR.evaluate_minute(decision_ts, ctx, bars) is None


def test_long_signal_when_below_zg_neg_gamma():
    bars = _es_bars(n=30, base=6000.0)
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    es_close = float(bars.iloc[-1]["close"])
    ctx = _Setup5Context(
        conn=None,
        pg=None,
        zg_levels=_zg_at(zg=es_close + 0.05, decision_ts=decision_ts),  # just above
        dealer_gamma=_gamma(-1e9, decision_ts),
        data_available=True,
    )
    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, bars)
    assert sig is not None
    assert sig.direction is Direction.LONG
    assert sig.target_price > es_close
    assert sig.stop_price < es_close  # adverse-move stop, standard geometry


def test_short_signal_when_above_zg_neg_gamma():
    bars = _es_bars(n=30, base=6000.0)
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    es_close = float(bars.iloc[-1]["close"])
    ctx = _Setup5Context(
        conn=None,
        pg=None,
        zg_levels=_zg_at(zg=es_close - 0.05, decision_ts=decision_ts),
        dealer_gamma=_gamma(-1e9, decision_ts),
        data_available=True,
    )
    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, bars)
    assert sig is not None
    assert sig.direction is Direction.SHORT


def test_no_signal_when_dealer_gamma_positive():
    bars = _es_bars(n=30)
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    es_close = float(bars.iloc[-1]["close"])
    ctx = _Setup5Context(
        conn=None,
        pg=None,
        zg_levels=_zg_at(zg=es_close + 0.05, decision_ts=decision_ts),
        dealer_gamma=_gamma(+1e9, decision_ts),  # positive — disables magnet
        data_available=True,
    )
    assert EVALUATOR.evaluate_minute(decision_ts, ctx, bars) is None


def test_no_signal_when_too_far_from_zg():
    bars = _es_bars(n=30, base=6000.0)
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    es_close = float(bars.iloc[-1]["close"])
    ctx = _Setup5Context(
        conn=None,
        pg=None,
        zg_levels=_zg_at(zg=es_close + 50.0, decision_ts=decision_ts),  # way far
        dealer_gamma=_gamma(-1e9, decision_ts),
        data_available=True,
    )
    assert EVALUATOR.evaluate_minute(decision_ts, ctx, bars) is None
