"""Unit tests for Setup 1: nq-ofi-extreme.

Pure-Python tests with synthetic frames + a stubbed ctx — no DB or parquet
hits. The full backtest is exercised by the CLI end-to-end run, not here.
"""

from __future__ import annotations

import pandas as pd

from setups_backtest.evaluators.setup_1_nq_ofi_extreme import (
    EVALUATOR,
    _Setup1Context,
)
from setups_backtest.harness import Direction


def _utc(ts: str) -> pd.Timestamp:
    return pd.Timestamp(ts, tz="UTC")


def _ohlcv(rows: list[tuple[str, float, float, float, float, int]]) -> pd.DataFrame:
    return (
        pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"])
        .assign(ts=lambda d: pd.to_datetime(d["ts"], utc=True))
        .assign(symbol="NQM6")
    )


def _tbbo_with_strong_buy(end_minute: str, minutes_back: int = 90) -> pd.DataFrame:
    """Synthetic TBBO frame with overwhelming buy flow in the last hour."""
    end = pd.Timestamp(end_minute, tz="UTC")
    rows = []
    for i in range(minutes_back):
        m = end - pd.Timedelta(minutes=minutes_back - i)
        rows.append({"minute": m, "buy_vol": 1000, "sell_vol": 50})
    return pd.DataFrame(rows)


def _make_long_session_bars(n: int = 120, base_price: float = 20000) -> pd.DataFrame:
    """Synthetic 1m NQ session: steady uptrend with 5pt range bars."""
    base = pd.Timestamp("2026-04-15", tz="UTC") + pd.Timedelta(hours=13, minutes=30)
    rows = []
    for i in range(n):
        p = base_price + i * 0.5
        rows.append(
            (
                (base + pd.Timedelta(minutes=i)).isoformat(),
                p,
                p + 3,
                p - 2,
                p + 0.5,
                100,
            )
        )
    return _ohlcv(rows)


def _make_ctx(
    p95: float,
    *,
    with_cl_stress: bool = False,
    decision_ts: pd.Timestamp | None = None,
) -> _Setup1Context:
    """Build a stub context with the desired threshold and CL stress state.

    If ``with_cl_stress``, the CL frame is positioned so that the 30-min window
    ending at ``decision_ts`` contains a >2% move.
    """
    if with_cl_stress and decision_ts is not None:
        # CL frame showing a +3.1% move over 30m, ending JUST before decision_ts.
        window_start = decision_ts - pd.Timedelta(minutes=29)
        window_end = decision_ts - pd.Timedelta(minutes=1)
        cl_rows = [
            (window_start.isoformat(), 80.0, 80.0, 80.0, 80.0, 100),
            (window_end.isoformat(), 82.5, 82.5, 82.5, 82.5, 100),
        ]
    else:
        cl_rows = []
    cl_df = (
        pd.DataFrame(cl_rows, columns=["ts", "open", "high", "low", "close", "volume"])
        if cl_rows
        else pd.DataFrame(columns=["ts", "close"])
    )
    if not cl_df.empty:
        cl_df["ts"] = pd.to_datetime(cl_df["ts"], utc=True)
    return _Setup1Context(
        p95_threshold=p95,
        threshold_n_samples=10000,
        cl_ohlcv=cl_df,
        conn=None,
    )


def test_no_signal_when_history_too_short():
    ctx = _make_ctx(p95=0.30)
    bars = _make_long_session_bars(n=30)
    sig = EVALUATOR.evaluate_minute(_utc("2026-04-15 14:00"), ctx, bars)
    assert sig is None


def test_no_signal_when_threshold_nan():
    ctx = _make_ctx(p95=float("nan"))
    bars = _make_long_session_bars(n=120)
    sig = EVALUATOR.evaluate_minute(_utc("2026-04-15 14:30"), ctx, bars)
    assert sig is None


def test_long_signal_fires_on_strong_buy(monkeypatch):
    """When |OFI| > p95 and OFI > 0, evaluator returns a LONG signal with a
    stop below price and a target above price."""
    ctx = _make_ctx(p95=0.30)
    bars = _make_long_session_bars(n=120)
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)

    # Patch the per-day TBBO loader to return a strong-buy frame.
    from setups_backtest.evaluators import setup_1_nq_ofi_extreme as mod

    def fake_loader(ctx_, conn, contract, d):
        return _tbbo_with_strong_buy(decision_ts.isoformat())

    monkeypatch.setattr(mod, "_get_tbbo_for_day", fake_loader)
    # Patch the prior-profile cache: today's date, with a VAH 50pt above.
    last_close = float(bars.iloc[-1]["close"])
    monkeypatch.setattr(
        mod,
        "_get_prior_profile",
        lambda ctx_, conn, today: {
            "poc": last_close + 30,
            "vah": last_close + 50,
            "val": last_close - 50,
        },
    )

    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, bars)
    assert sig is not None
    assert sig.direction is Direction.LONG
    assert sig.stop_price < last_close
    assert sig.target_price > last_close
    assert sig.metadata["ofi_1h"] > 0
    assert sig.metadata["ofi_1h"] > ctx.p95_threshold


def test_short_signal_fires_on_strong_sell(monkeypatch):
    ctx = _make_ctx(p95=0.30)
    bars = _make_long_session_bars(n=120)
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)

    from setups_backtest.evaluators import setup_1_nq_ofi_extreme as mod

    def fake_loader(ctx_, conn, contract, d):
        end = pd.Timestamp(decision_ts)
        rows = [
            {"minute": end - pd.Timedelta(minutes=90 - i), "buy_vol": 50, "sell_vol": 1000}
            for i in range(90)
        ]
        return pd.DataFrame(rows)

    monkeypatch.setattr(mod, "_get_tbbo_for_day", fake_loader)
    last_close = float(bars.iloc[-1]["close"])
    monkeypatch.setattr(
        mod,
        "_get_prior_profile",
        lambda ctx_, conn, today: {
            "poc": last_close - 30,
            "vah": last_close + 50,
            "val": last_close - 50,
        },
    )

    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, bars)
    assert sig is not None
    assert sig.direction is Direction.SHORT
    assert sig.stop_price > last_close
    assert sig.target_price < last_close


def test_macro_stress_disqualifies_signal(monkeypatch):
    """Even with a valid OFI extreme, MACRO-STRESS active should produce no signal."""
    bars = _make_long_session_bars(n=120)
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    ctx = _make_ctx(p95=0.30, with_cl_stress=True, decision_ts=decision_ts)

    from setups_backtest.evaluators import setup_1_nq_ofi_extreme as mod

    monkeypatch.setattr(
        mod,
        "_get_tbbo_for_day",
        lambda ctx_, conn, contract, d: _tbbo_with_strong_buy(decision_ts.isoformat()),
    )
    monkeypatch.setattr(
        mod,
        "_get_prior_profile",
        lambda ctx_, conn, today: {"poc": 21000, "vah": 21050, "val": 20950},
    )

    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, bars)
    assert sig is None


def test_no_signal_when_prior_profile_nan_and_atr_nan(monkeypatch):
    """If neither yesterday's VAH/VAL nor today's ATR(14) is available, no target
    candidate exists on the favorable side and the evaluator must return None."""
    ctx = _make_ctx(p95=0.30)
    # Only 60 bars — fewer than ATR window of 14 will resolve, but here we
    # explicitly force NaN-prior-profile and observe what happens. Build a
    # frame with constant prices so ATR is still computed but very small.
    bars = _make_long_session_bars(n=120)
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)

    from setups_backtest.evaluators import setup_1_nq_ofi_extreme as mod

    monkeypatch.setattr(
        mod,
        "_get_tbbo_for_day",
        lambda ctx_, conn, contract, d: _tbbo_with_strong_buy(decision_ts.isoformat()),
    )
    # Force prior profile to all-NaN AND make ATR very small so 2*ATR target
    # also falls below last_close (failing the favorable-side filter).
    monkeypatch.setattr(
        mod,
        "_get_prior_profile",
        lambda ctx_, conn, today: {
            "poc": float("nan"),
            "vah": float("nan"),
            "val": float("nan"),
        },
    )
    # Override ATR to NaN so neither candidate is finite.
    monkeypatch.setattr(
        mod.features,
        "atr",
        lambda *args, **kwargs: pd.Series([float("nan")] * len(bars), index=bars["ts"]),
    )
    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, bars)
    assert sig is None


def test_no_signal_when_30m_swing_is_wrong_side(monkeypatch):
    """If the 30m swing low is ABOVE the current close (impossible in normal
    bars but possible with a strongly downsloping construction), LONG should
    reject. Inverse for SHORT.

    We build a bar series where the last 30 bars' low > last close — a
    degenerate but worth-pinning case so the evaluator's safety check is
    exercised."""
    ctx = _make_ctx(p95=0.30)
    # Build bars where every bar's low equals its open, but the last bar's
    # close is below the trailing-30 lows.
    base = pd.Timestamp("2026-04-15", tz="UTC") + pd.Timedelta(hours=13, minutes=30)
    rows = [
        (
            (base + pd.Timedelta(minutes=i)).isoformat(),
            20000.0,
            20002.0,
            20000.0,  # low never goes below 20000
            20000.5,
            100,
        )
        for i in range(120)
    ]
    # Force the LAST bar's close BELOW the swing low — degenerate but tests
    # the safety check.
    rows[-1] = (
        (base + pd.Timedelta(minutes=119)).isoformat(),
        20000.0,
        20002.0,
        20000.0,
        19999.0,  # last close below all 30m swing lows
        100,
    )
    bars = _ohlcv(rows)
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)

    from setups_backtest.evaluators import setup_1_nq_ofi_extreme as mod

    monkeypatch.setattr(
        mod,
        "_get_tbbo_for_day",
        lambda ctx_, conn, contract, d: _tbbo_with_strong_buy(decision_ts.isoformat()),
    )
    monkeypatch.setattr(
        mod,
        "_get_prior_profile",
        lambda ctx_, conn, today: {"poc": 20050, "vah": 20100, "val": 19900},
    )
    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, bars)
    # Stop would be at 20000 (the 30m low), but last_close is 19999, so for a
    # LONG signal stop_price >= last_close — rejected.
    assert sig is None


def test_no_signal_when_bars_symbol_missing(monkeypatch):
    """Defensive: if the bars frame has no `symbol` column or it's None,
    the evaluator must not crash and must return None."""
    ctx = _make_ctx(p95=0.30)
    bars = _make_long_session_bars(n=120)
    bars = bars.drop(columns=["symbol"])  # remove the column entirely
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, bars)
    assert sig is None


def test_below_threshold_returns_none(monkeypatch):
    """OFI inside the normal band: no signal."""
    ctx = _make_ctx(p95=0.30)
    bars = _make_long_session_bars(n=120)
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)

    from setups_backtest.evaluators import setup_1_nq_ofi_extreme as mod

    def fake_balanced(ctx_, conn, contract, d):
        end = pd.Timestamp(decision_ts)
        rows = [
            {"minute": end - pd.Timedelta(minutes=90 - i), "buy_vol": 100, "sell_vol": 100}
            for i in range(90)
        ]
        return pd.DataFrame(rows)

    monkeypatch.setattr(mod, "_get_tbbo_for_day", fake_balanced)
    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, bars)
    assert sig is None
