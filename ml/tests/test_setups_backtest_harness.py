"""Tests for setups_backtest.harness — execution simulation correctness.

Synthetic 1m bars + a stub evaluator that fires a known signal. We verify:
  - Entry at next bar's open + slippage
  - Stop hit
  - Target hit
  - Both-touched bar → conservative stop
  - EoD closeout when neither hit
  - One-position-at-a-time guard
  - P&L and R-multiple accounting
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import pandas as pd
import pytest

from setups_backtest import harness
from setups_backtest.harness import (
    COMMISSION_PER_SIDE,
    CONTRACT_SPECS,
    Direction,
    ExitReason,
    Signal,
    _resolve_trade,
    _simulate_exit,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _utc(ts: str) -> pd.Timestamp:
    return pd.Timestamp(ts, tz="UTC")


def _bars(rows: list[tuple[str, float, float, float, float, int]]) -> pd.DataFrame:
    return pd.DataFrame(
        rows, columns=["ts", "open", "high", "low", "close", "volume"]
    ).assign(ts=lambda d: pd.to_datetime(d["ts"], utc=True))


# ---------------------------------------------------------------------------
# Position simulation
# ---------------------------------------------------------------------------


def test_simulate_exit_long_target_hit():
    sig = Signal(
        setup_name="test",
        decision_ts=_utc("2026-04-15 14:00"),
        direction=Direction.LONG,
        contract="ESM6",
        stop_price=5000.0,
        target_price=5010.0,
    )
    # 2nd bar's high reaches the target.
    bars = _bars(
        [
            ("2026-04-15 14:01", 5005, 5006, 5004, 5005, 100),  # entry bar (skipped here)
            ("2026-04-15 14:02", 5005, 5012, 5004, 5008, 100),  # target hit at 5010
            ("2026-04-15 14:03", 5008, 5009, 5007, 5008, 100),
        ]
    )
    # _simulate_exit walks from the first bar passed (post-entry).
    exit_ts, price, reason = _simulate_exit(
        sig, bars.iloc[1:].reset_index(drop=True)
    )
    assert reason is ExitReason.TARGET
    assert price == pytest.approx(5010.0)
    assert exit_ts == _utc("2026-04-15 14:02")


def test_simulate_exit_long_stop_hit():
    sig = Signal(
        setup_name="test",
        decision_ts=_utc("2026-04-15 14:00"),
        direction=Direction.LONG,
        contract="ESM6",
        stop_price=5000.0,
        target_price=5020.0,
    )
    bars = _bars(
        [
            ("2026-04-15 14:02", 5005, 5006, 4998, 5001, 100),  # low hits stop
        ]
    )
    exit_ts, price, reason = _simulate_exit(sig, bars)
    assert reason is ExitReason.STOP
    assert price == pytest.approx(5000.0)


def test_simulate_exit_short_target_hit():
    sig = Signal(
        setup_name="test",
        decision_ts=_utc("2026-04-15 14:00"),
        direction=Direction.SHORT,
        contract="ESM6",
        stop_price=5010.0,
        target_price=5000.0,
    )
    bars = _bars(
        [
            ("2026-04-15 14:02", 5005, 5006, 4998, 5001, 100),  # low hits target
        ]
    )
    _, price, reason = _simulate_exit(sig, bars)
    assert reason is ExitReason.TARGET
    assert price == pytest.approx(5000.0)


def test_simulate_exit_both_touched_is_stop():
    # Same bar's range covers both target and stop → conservative stop hit.
    sig = Signal(
        setup_name="test",
        decision_ts=_utc("2026-04-15 14:00"),
        direction=Direction.LONG,
        contract="ESM6",
        stop_price=5000.0,
        target_price=5010.0,
    )
    bars = _bars(
        [
            ("2026-04-15 14:02", 5005, 5012, 4998, 5005, 100),  # range covers both
        ]
    )
    _, price, reason = _simulate_exit(sig, bars)
    assert reason is ExitReason.STOP


def test_simulate_exit_eod_close():
    sig = Signal(
        setup_name="test",
        decision_ts=_utc("2026-04-15 14:00"),
        direction=Direction.LONG,
        contract="ESM6",
        stop_price=4990.0,
        target_price=5020.0,
    )
    # Bars touch neither stop nor target.
    bars = _bars(
        [
            ("2026-04-15 14:02", 5005, 5008, 5003, 5007, 100),
            ("2026-04-15 19:59", 5007, 5009, 5005, 5008, 100),  # last bar
        ]
    )
    exit_ts, price, reason = _simulate_exit(sig, bars)
    assert reason is ExitReason.EOD
    assert price == pytest.approx(5008.0)
    assert exit_ts == _utc("2026-04-15 19:59")


# ---------------------------------------------------------------------------
# Cost / P&L accounting
# ---------------------------------------------------------------------------


def test_resolve_trade_long_target_pnl():
    spec = CONTRACT_SPECS["ES"]
    sig = Signal(
        setup_name="test",
        decision_ts=_utc("2026-04-15 14:00"),
        direction=Direction.LONG,
        contract="ESM6",
        stop_price=5000.0,
        target_price=5010.0,
    )
    entry_bar = pd.Series(
        {
            "ts": _utc("2026-04-15 14:01"),
            "open": 5005.0,
            "high": 5006.0,
            "low": 5004.0,
            "close": 5005.0,
        }
    )
    exit_bars = _bars(
        [
            ("2026-04-15 14:02", 5005, 5012, 5004, 5008, 100),
        ]
    )
    trade = _resolve_trade(sig, entry_bar, exit_bars, spec)
    # Entry: 5005 + 1.5*0.25 = 5005.375. Exit: 5010 - 0.375 = 5009.625.
    # P&L price-diff: 4.25 pts. ES = $50/pt → $212.50. Net: 212.50 - 2*1.25 = $210.
    assert trade.entry_price == pytest.approx(5005.375)
    assert trade.exit_price == pytest.approx(5009.625)
    assert trade.gross_pnl_dollars == pytest.approx(212.50)
    assert trade.net_pnl_dollars == pytest.approx(212.50 - 2 * COMMISSION_PER_SIDE)
    # R = (5005 - 5000) = 5 pts = $250 risk. Net / risk = 210 / 250 = 0.84.
    assert trade.r_multiple == pytest.approx(210.0 / 250.0, rel=1e-3)
    assert trade.exit_reason is ExitReason.TARGET


def test_resolve_trade_short_stop_loss_is_negative_r():
    spec = CONTRACT_SPECS["NQ"]
    sig = Signal(
        setup_name="test",
        decision_ts=_utc("2026-04-15 14:00"),
        direction=Direction.SHORT,
        contract="NQM6",
        stop_price=20010.0,
        target_price=19990.0,
    )
    entry_bar = pd.Series(
        {
            "ts": _utc("2026-04-15 14:01"),
            "open": 20000.0,
            "high": 20002.0,
            "low": 19998.0,
            "close": 20000.0,
        }
    )
    exit_bars = _bars(
        [
            ("2026-04-15 14:02", 20000, 20015, 20000, 20012, 100),  # stop hit
        ]
    )
    trade = _resolve_trade(sig, entry_bar, exit_bars, spec)
    assert trade.exit_reason is ExitReason.STOP
    assert trade.r_multiple < 0
    # R-multiple should be roughly -1 net of costs (well, slightly worse due to slippage + commission).
    assert -1.5 < trade.r_multiple < -0.9


# ---------------------------------------------------------------------------
# Full-day driver smoke (with a stub evaluator)
# ---------------------------------------------------------------------------


def test_one_position_at_a_time(monkeypatch):
    """The harness must skip new signals while a position is open, but allow
    re-entry after the position closes (intraday re-entry is legitimate)."""

    @dataclass
    class _AlwaysFiringEvaluator:
        """Fires LONG on every bar that has >= 2 history bars and no open trade.

        Combined with a fast target hit, this should produce multiple trades
        per day. If the harness silently locks to one-trade-per-day, this
        test fails.
        """

        name: str = "always-fires"
        contract_prefix: str = "ES"

        def prepare(self, conn, pg, start, end):
            del conn, pg, start, end
            return None

        def evaluate_minute(self, now, ctx, bars):
            del ctx
            if len(bars) < 2:
                return None
            last = float(bars.iloc[-1]["close"])
            return Signal(
                setup_name=self.name,
                decision_ts=now,
                direction=Direction.LONG,
                contract="",
                stop_price=last - 1,
                target_price=last + 1,
            )

    # Bars where the next-bar high will reach target+1 within 1-2 bars, so
    # each trade closes quickly and the harness can re-enter.
    base = pd.Timestamp("2026-04-15", tz="UTC") + pd.Timedelta(hours=13, minutes=30)
    rows = []
    for i in range(30):
        price = 5000 + i * 0.5
        rows.append(
            (
                (base + pd.Timedelta(minutes=i)).isoformat(),
                price,
                price + 2,  # high reaches target (~last+1 from prior bar) easily
                price - 0.5,  # low does NOT trigger stop
                price + 0.25,
                100,
            )
        )
    fake_bars = _bars(rows)

    def fake_pick(conn, prefix, on):
        del conn, prefix, on
        return "ESM6"

    def fake_load(conn, symbols, on):
        del conn, on
        return fake_bars.assign(symbol=symbols[0])

    monkeypatch.setattr(harness.data_loaders, "pick_front_month", fake_pick)
    monkeypatch.setattr(harness.data_loaders, "load_ohlcv_day", fake_load)

    trades = harness.run_backtest(
        _AlwaysFiringEvaluator(), [date(2026, 4, 15)], conn=object()
    )
    # Multiple trades expected (one per minute is the upper bound; we just
    # need > 1 to prove the position flag resets after exit).
    assert len(trades) > 1, "Harness silently locked to one trade per day"
    # Trades should not overlap in time.
    for prev, nxt in zip(trades, trades[1:]):
        assert nxt.entry_ts > prev.exit_ts, "Overlapping trades — position reset is wrong"


def test_trades_to_dataframe_columns():
    spec = CONTRACT_SPECS["ES"]
    sig = Signal(
        setup_name="test",
        decision_ts=_utc("2026-04-15 14:00"),
        direction=Direction.LONG,
        contract="ESM6",
        stop_price=5000.0,
        target_price=5010.0,
    )
    entry_bar = pd.Series(
        {
            "ts": _utc("2026-04-15 14:01"),
            "open": 5005.0,
            "high": 5006.0,
            "low": 5004.0,
            "close": 5005.0,
        }
    )
    exit_bars = _bars([("2026-04-15 14:02", 5005, 5012, 5004, 5008, 100)])
    trade = _resolve_trade(sig, entry_bar, exit_bars, spec)
    df = harness.trades_to_dataframe([trade])
    assert set(df.columns) >= {
        "setup_name",
        "direction",
        "contract",
        "entry_ts",
        "exit_ts",
        "entry_price",
        "exit_price",
        "stop_price",
        "target_price",
        "exit_reason",
        "gross_pnl_dollars",
        "net_pnl_dollars",
        "r_multiple",
    }
    assert df.iloc[0]["direction"] == "LONG"
    assert df.iloc[0]["exit_reason"] == "TARGET"


def test_trades_to_dataframe_empty():
    df = harness.trades_to_dataframe([])
    assert df.empty
    assert "net_pnl_dollars" in df.columns
