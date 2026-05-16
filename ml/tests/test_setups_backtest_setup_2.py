"""Unit tests for Setup 2: nq-leads-es-catchup."""

from __future__ import annotations

import pandas as pd

from setups_backtest.evaluators.setup_2_nq_leads_es import (
    EVALUATOR,
    _Setup2Context,
)
from setups_backtest.harness import Direction


def _utc(ts: str) -> pd.Timestamp:
    return pd.Timestamp(ts, tz="UTC")


def _es_bars(n: int = 120, base: float = 6000.0) -> pd.DataFrame:
    """Synthetic ES session: small steady uptrend (0.1% / min)."""
    start = pd.Timestamp("2026-04-15", tz="UTC") + pd.Timedelta(hours=13, minutes=30)
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
    ).assign(
        ts=lambda d: pd.to_datetime(d["ts"], utc=True),
        symbol="ESM6",
    )


def _nq_bars_synced(n: int = 120, base: float = 20000.0, slope: float = 4.0) -> pd.DataFrame:
    """NQ bars on the same timestamps, rising 4 pts/min (faster than ES)."""
    start = pd.Timestamp("2026-04-15", tz="UTC") + pd.Timedelta(hours=13, minutes=30)
    rows = []
    for i in range(n):
        p = base + i * slope
        rows.append(
            (
                (start + pd.Timedelta(minutes=i)).isoformat(),
                p,
                p + 2,
                p - 2,
                p + 1,
                100,
            )
        )
    return pd.DataFrame(
        rows, columns=["ts", "open", "high", "low", "close", "volume"]
    ).assign(ts=lambda d: pd.to_datetime(d["ts"], utc=True))


def _tbbo_strong_buy(end_ts: pd.Timestamp, n: int = 90) -> pd.DataFrame:
    rows = [
        {
            "minute": end_ts - pd.Timedelta(minutes=n - i),
            "buy_vol": 1000,
            "sell_vol": 50,
        }
        for i in range(n)
    ]
    return pd.DataFrame(rows)


def _tbbo_balanced(end_ts: pd.Timestamp, n: int = 90) -> pd.DataFrame:
    rows = [
        {
            "minute": end_ts - pd.Timedelta(minutes=n - i),
            "buy_vol": 100,
            "sell_vol": 95,
        }
        for i in range(n)
    ]
    return pd.DataFrame(rows)


def _make_ctx() -> _Setup2Context:
    return _Setup2Context(conn=None)


def test_no_signal_when_history_short():
    ctx = _make_ctx()
    sig = EVALUATOR.evaluate_minute(_utc("2026-04-15 14:00"), ctx, _es_bars(n=30))
    assert sig is None


def test_long_signal_fires_on_classic_catchup(monkeypatch):
    """NQ heavy buying (1h OFI ≥ 0.4), ES barely buying (≤ 0.1), still
    correlated (≥ 0.7): signal fires LONG ES with NQ-implied target above."""
    ctx = _make_ctx()
    es_bars = _es_bars(n=120)
    nq = _nq_bars_synced(n=120)
    decision_ts = es_bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)

    from setups_backtest.evaluators import setup_2_nq_leads_es as mod

    def fake_tbbo(cache, conn, prefix, d):
        if prefix == "NQ":
            return _tbbo_strong_buy(decision_ts)
        # ES: barely positive
        rows = [
            {
                "minute": decision_ts - pd.Timedelta(minutes=90 - i),
                "buy_vol": 110,
                "sell_vol": 100,
            }
            for i in range(90)
        ]
        return pd.DataFrame(rows)

    monkeypatch.setattr(mod, "_cached_tbbo", fake_tbbo)
    monkeypatch.setattr(mod, "_cached_ohlcv_nq", lambda cache, conn, d: nq)

    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, es_bars)
    assert sig is not None
    assert sig.direction is Direction.LONG
    assert sig.contract == "ESM6"
    last_close = float(es_bars.iloc[-1]["close"])
    assert sig.target_price > last_close
    assert sig.stop_price < last_close
    assert sig.metadata["nq_ofi_1h"] >= 0.4
    assert sig.metadata["es_ofi_1h"] <= 0.1
    assert sig.metadata["es_nq_corr_30m"] >= 0.7


def test_no_signal_when_es_ofi_already_high(monkeypatch):
    """If ES is already heavily bought (OFI > 0.1), there's nothing to
    catch up to."""
    ctx = _make_ctx()
    es_bars = _es_bars(n=120)
    nq = _nq_bars_synced(n=120)
    decision_ts = es_bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)

    from setups_backtest.evaluators import setup_2_nq_leads_es as mod

    def fake_tbbo(cache, conn, prefix, d):
        return _tbbo_strong_buy(decision_ts)  # Both ES and NQ strong-buy.

    monkeypatch.setattr(mod, "_cached_tbbo", fake_tbbo)
    monkeypatch.setattr(mod, "_cached_ohlcv_nq", lambda cache, conn, d: nq)

    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, es_bars)
    assert sig is None


def test_no_signal_when_corr_below_threshold(monkeypatch):
    """ES uptrend, NQ random walk — low correlation → reject."""
    ctx = _make_ctx()
    es_bars = _es_bars(n=120)
    # NQ that DOESN'T move with ES — random-ish closes.
    import numpy as np

    rng = np.random.default_rng(42)
    start = pd.Timestamp("2026-04-15", tz="UTC") + pd.Timedelta(hours=13, minutes=30)
    nq_rows = []
    for i in range(120):
        p = 20000.0 + rng.standard_normal() * 30
        nq_rows.append(
            (
                (start + pd.Timedelta(minutes=i)).isoformat(),
                p,
                p + 2,
                p - 2,
                p + rng.standard_normal() * 2,
                100,
            )
        )
    nq = pd.DataFrame(
        nq_rows, columns=["ts", "open", "high", "low", "close", "volume"]
    ).assign(ts=lambda d: pd.to_datetime(d["ts"], utc=True))
    decision_ts = es_bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)

    from setups_backtest.evaluators import setup_2_nq_leads_es as mod

    def fake_tbbo(cache, conn, prefix, d):
        if prefix == "NQ":
            return _tbbo_strong_buy(decision_ts)
        rows = [
            {
                "minute": decision_ts - pd.Timedelta(minutes=90 - i),
                "buy_vol": 110,
                "sell_vol": 100,
            }
            for i in range(90)
        ]
        return pd.DataFrame(rows)

    monkeypatch.setattr(mod, "_cached_tbbo", fake_tbbo)
    monkeypatch.setattr(mod, "_cached_ohlcv_nq", lambda cache, conn, d: nq)

    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, es_bars)
    assert sig is None


def test_no_signal_when_nq_ohlcv_empty(monkeypatch):
    ctx = _make_ctx()
    es_bars = _es_bars(n=120)
    decision_ts = es_bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)

    from setups_backtest.evaluators import setup_2_nq_leads_es as mod

    monkeypatch.setattr(
        mod, "_cached_tbbo", lambda cache, conn, prefix, d: _tbbo_strong_buy(decision_ts)
    )
    monkeypatch.setattr(mod, "_cached_ohlcv_nq", lambda cache, conn, d: pd.DataFrame())

    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, es_bars)
    assert sig is None
