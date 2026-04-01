"""
Comprehensive pytest tests for ml/backtest.py.

Tests cover:
- simulate_strategy: P&L correctness, confidence sizing, overrides, empty input
- compute_metrics: win_rate, profit_factor, max_drawdown, edge cases
- find_max_drawdown_period: peak/trough detection on known equity curves
- print_metrics_table: output correctness (smoke test)
- Constants: SPREAD_WIDTH, CREDIT_PER_CONTRACT, MAX_LOSS_PER_CONTRACT, CONFIDENCE_SIZING
"""

import pandas as pd
import pytest

from backtest import (
    CONFIDENCE_SIZING,
    CREDIT_PER_CONTRACT,
    MAX_LOSS_PER_CONTRACT,
    SPREAD_WIDTH,
    compute_metrics,
    find_max_drawdown_period,
    simulate_strategy,
)


# ── Helpers ─────────────────────────────────────────────────


def make_df(
    records: list[dict],
    start: str = "2025-01-06",
) -> pd.DataFrame:
    """Build a small DataFrame with a date index, mimicking labeled day data."""
    dates = pd.date_range(start, periods=len(records), freq="B")
    df = pd.DataFrame(records, index=dates)
    df.index.name = "date"
    return df


# ── Constants ───────────────────────────────────────────────


class TestConstants:
    """Verify trade model constants are consistent."""

    def test_spread_width(self):
        """SPREAD_WIDTH should be 20 points."""
        assert SPREAD_WIDTH == 20

    def test_credit_per_contract(self):
        """Credit received per contract is $200 ($2.00 * 100)."""
        assert CREDIT_PER_CONTRACT == 200

    def test_max_loss_per_contract(self):
        """Max loss = (spread_width * 100) - credit = $1800."""
        assert MAX_LOSS_PER_CONTRACT == (SPREAD_WIDTH * 100) - CREDIT_PER_CONTRACT
        assert MAX_LOSS_PER_CONTRACT == 1800

    def test_confidence_sizing_keys(self):
        """CONFIDENCE_SIZING must have HIGH, MODERATE, and LOW."""
        assert set(CONFIDENCE_SIZING.keys()) == {"HIGH", "MODERATE", "LOW"}

    def test_confidence_sizing_values(self):
        """HIGH=2x, MODERATE=1x, LOW=1x."""
        assert CONFIDENCE_SIZING["HIGH"] == 2
        assert CONFIDENCE_SIZING["MODERATE"] == 1
        assert CONFIDENCE_SIZING["LOW"] == 1


# ── simulate_strategy ──────────────────────────────────────


class TestSimulateStrategy:
    """Tests for simulate_strategy."""

    def test_all_wins_default_sizing(self):
        """All wins with MODERATE confidence should each yield +$200."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
        ])
        result = simulate_strategy(df, name="test")

        assert len(result) == 3
        assert list(result["pnl"]) == [200, 200, 200]
        assert list(result["cumulative"]) == [200, 400, 600]
        assert all(result["win"])

    def test_all_losses_default_sizing(self):
        """All losses with MODERATE confidence should each yield -$1800."""
        df = make_df([
            {"recommended_structure": "PCS", "label_confidence": "MODERATE", "structure_correct": False},
            {"recommended_structure": "PCS", "label_confidence": "MODERATE", "structure_correct": False},
        ])
        result = simulate_strategy(df, name="test")

        assert list(result["pnl"]) == [-1800, -1800]
        assert list(result["cumulative"]) == [-1800, -3600]
        assert not any(result["win"])

    def test_mixed_wins_and_losses(self):
        """Mixed scenario: win, loss, win should produce correct cumulative P&L."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
        ])
        result = simulate_strategy(df, name="test")

        assert list(result["pnl"]) == [200, -1800, 200]
        assert list(result["cumulative"]) == [200, -1600, -1400]

    def test_high_confidence_sizing(self):
        """HIGH confidence should trade 2 contracts: win=+$400, loss=-$3600."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "HIGH", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "HIGH", "structure_correct": False},
        ])
        result = simulate_strategy(df, name="test", use_confidence_sizing=True)

        assert list(result["contracts"]) == [2, 2]
        assert result["pnl"].iloc[0] == 400   # 200 * 2
        assert result["pnl"].iloc[1] == -3600  # -1800 * 2

    def test_low_confidence_sizing(self):
        """LOW confidence should trade 1 contract."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "LOW", "structure_correct": True},
        ])
        result = simulate_strategy(df, name="test", use_confidence_sizing=True)

        assert result["contracts"].iloc[0] == 1
        assert result["pnl"].iloc[0] == 200

    def test_mixed_confidence_levels(self):
        """Different confidence levels in the same run size correctly."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "HIGH", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "LOW", "structure_correct": True},
        ])
        result = simulate_strategy(df, name="test", use_confidence_sizing=True)

        assert list(result["contracts"]) == [2, 1, 1]
        assert list(result["pnl"]) == [400, 200, 200]

    def test_confidence_sizing_disabled(self):
        """When use_confidence_sizing=False, always trade 1 contract regardless."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "HIGH", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "HIGH", "structure_correct": False},
        ])
        result = simulate_strategy(df, name="test", use_confidence_sizing=False)

        assert list(result["contracts"]) == [1, 1]
        assert result["pnl"].iloc[0] == 200
        assert result["pnl"].iloc[1] == -1800

    def test_override_structure(self):
        """override_structure replaces recommended_structure in the output."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "PCS", "label_confidence": "MODERATE", "structure_correct": True},
        ])
        result = simulate_strategy(df, name="test", override_structure="IC")

        assert list(result["structure"]) == ["IC", "IC"]

    def test_override_contracts(self):
        """override_contracts forces a specific contract count regardless of confidence."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "HIGH", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "LOW", "structure_correct": False},
        ])
        result = simulate_strategy(df, name="test", override_contracts=3)

        assert list(result["contracts"]) == [3, 3]
        assert result["pnl"].iloc[0] == 200 * 3   # win
        assert result["pnl"].iloc[1] == -1800 * 3  # loss

    def test_override_contracts_with_confidence_sizing_true(self):
        """override_contracts takes precedence over use_confidence_sizing."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "HIGH", "structure_correct": True},
        ])
        result = simulate_strategy(
            df, name="test",
            use_confidence_sizing=True,
            override_contracts=5,
        )

        assert result["contracts"].iloc[0] == 5
        assert result["pnl"].iloc[0] == 200 * 5

    def test_max_equity_and_drawdown(self):
        """max_equity tracks high-water mark; drawdown is cumulative - max_equity."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
        ])
        result = simulate_strategy(df, name="test")

        # cumulative: 200, 400, -1400, -1200
        assert list(result["max_equity"]) == [200, 400, 400, 400]
        assert list(result["drawdown"]) == [0, 0, -1800, -1600]

    def test_name_attribute(self):
        """The result DataFrame should store the strategy name in attrs."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
        ])
        result = simulate_strategy(df, name="My Strategy")

        assert result.attrs["name"] == "My Strategy"

    def test_empty_dataframe(self):
        """An empty DataFrame should return an empty DataFrame."""
        df = make_df([])
        result = simulate_strategy(df, name="empty")

        assert len(result) == 0

    def test_unknown_confidence_defaults_to_one(self):
        """An unknown confidence level should default to 1 contract via .get fallback."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "UNKNOWN_LEVEL", "structure_correct": True},
        ])
        result = simulate_strategy(df, name="test", use_confidence_sizing=True)

        assert result["contracts"].iloc[0] == 1

    def test_structure_preserved_from_recommended(self):
        """Without override, the structure column reflects recommended_structure."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "PCS", "label_confidence": "MODERATE", "structure_correct": False},
            {"recommended_structure": "IC", "label_confidence": "MODERATE", "structure_correct": True},
        ])
        result = simulate_strategy(df, name="test")

        assert list(result["structure"]) == ["CCS", "PCS", "IC"]

    def test_result_columns(self):
        """Verify the result DataFrame has all expected columns."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
        ])
        result = simulate_strategy(df, name="test")

        expected_cols = {"pnl", "cumulative", "max_equity", "drawdown", "win", "structure", "contracts"}
        assert set(result.columns) == expected_cols

    def test_index_is_date_sorted(self):
        """Result should be indexed by date and sorted ascending."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
        ])
        result = simulate_strategy(df, name="test")

        assert result.index.name == "date"
        assert result.index.is_monotonic_increasing


# ── compute_metrics ─────────────────────────────────────────


class TestComputeMetrics:
    """Tests for compute_metrics."""

    def test_all_wins(self):
        """100% win rate with known P&L values."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
        ])
        trades = simulate_strategy(df, name="test")
        m = compute_metrics(trades)

        assert m["total_pnl"] == 1000
        assert m["win_rate"] == 1.0
        assert m["num_trades"] == 5
        assert m["avg_win"] == 200
        assert m["avg_loss"] == 0
        assert m["profit_factor"] == float("inf")
        assert m["max_drawdown"] == 0
        assert m["peak_equity"] == 1000

    def test_all_losses(self):
        """0% win rate with known P&L values."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False},
        ])
        trades = simulate_strategy(df, name="test")
        m = compute_metrics(trades)

        assert m["total_pnl"] == -5400
        assert m["win_rate"] == 0.0
        assert m["num_trades"] == 3
        assert m["avg_loss"] == -1800
        assert m["avg_win"] == 0
        # gross_wins = 0, gross_losses > 0 => profit_factor = 0 / gross_losses
        # Actually: gross_wins = 0, so profit_factor = 0 / abs(losses) = 0
        # Wait -- the code does: gross_wins / gross_losses if gross_losses > 0
        # gross_wins = 0, so 0 / gross_losses = 0
        assert m["profit_factor"] == 0.0

    def test_mixed_win_rate(self):
        """8 wins and 2 losses -> 80% win rate."""
        records = [
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True}
            for _ in range(8)
        ] + [
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False}
            for _ in range(2)
        ]
        df = make_df(records)
        trades = simulate_strategy(df, name="test")
        m = compute_metrics(trades)

        assert m["num_trades"] == 10
        assert m["win_rate"] == pytest.approx(0.8)
        # total pnl: 8*200 - 2*1800 = 1600 - 3600 = -2000
        assert m["total_pnl"] == -2000

    def test_profit_factor_calculation(self):
        """Verify profit_factor = gross_wins / gross_losses."""
        # 9 wins, 1 loss -> gross_wins = 1800, gross_losses = 1800 -> PF = 1.0
        records = [
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True}
            for _ in range(9)
        ] + [
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False},
        ]
        df = make_df(records)
        trades = simulate_strategy(df, name="test")
        m = compute_metrics(trades)

        assert m["profit_factor"] == pytest.approx(1.0)
        assert m["total_pnl"] == 0  # breakeven at 9:1

    def test_max_drawdown(self):
        """Verify max_drawdown is the worst peak-to-trough drop."""
        # win, win, loss, win => cumulative: 200, 400, -1400, -1200
        # max_equity: 200, 400, 400, 400
        # drawdown: 0, 0, -1800, -1600
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
        ])
        trades = simulate_strategy(df, name="test")
        m = compute_metrics(trades)

        assert m["max_drawdown"] == -1800
        assert m["peak_equity"] == 400

    def test_max_drawdown_pct(self):
        """max_drawdown_pct = max_dd / peak_equity * 100."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False},
        ])
        trades = simulate_strategy(df, name="test")
        m = compute_metrics(trades)

        # cumulative: 200, 400, -1400
        # peak: 400, max_dd: -1800
        # pct: -1800 / 400 * 100 = -450%
        assert m["max_drawdown_pct"] == pytest.approx(-450.0)

    def test_max_drawdown_pct_no_positive_equity(self):
        """When peak equity never goes positive, max_drawdown_pct should be 0."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False},
        ])
        trades = simulate_strategy(df, name="test")
        m = compute_metrics(trades)

        # cumulative: -1800, -3600 => max_equity: -1800, -1800 (cummax)
        # peak_equity = max of max_equity = -1800 => not > 0 => pct = 0
        assert m["max_drawdown_pct"] == 0

    def test_empty_trades(self):
        """compute_metrics on an empty DataFrame returns an empty dict."""
        df = make_df([])
        trades = simulate_strategy(df, name="test")
        m = compute_metrics(trades)

        assert m == {}

    def test_single_win(self):
        """Single winning trade metrics."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
        ])
        trades = simulate_strategy(df, name="test")
        m = compute_metrics(trades)

        assert m["total_pnl"] == 200
        assert m["win_rate"] == 1.0
        assert m["num_trades"] == 1
        assert m["avg_win"] == 200
        assert m["avg_loss"] == 0
        assert m["profit_factor"] == float("inf")
        assert m["max_drawdown"] == 0
        assert m["peak_equity"] == 200

    def test_single_loss(self):
        """Single losing trade metrics."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False},
        ])
        trades = simulate_strategy(df, name="test")
        m = compute_metrics(trades)

        assert m["total_pnl"] == -1800
        assert m["win_rate"] == 0.0
        assert m["num_trades"] == 1
        assert m["avg_loss"] == -1800
        assert m["avg_win"] == 0

    def test_high_confidence_affects_metrics(self):
        """HIGH confidence (2x) should produce doubled P&L in metrics."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "HIGH", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "HIGH", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "HIGH", "structure_correct": False},
        ])
        trades = simulate_strategy(df, name="test", use_confidence_sizing=True)
        m = compute_metrics(trades)

        # 2 wins at 400 each, 1 loss at -3600
        assert m["total_pnl"] == 800 - 3600
        assert m["avg_win"] == 400
        assert m["avg_loss"] == -3600
        assert m["profit_factor"] == pytest.approx(800 / 3600)


# ── find_max_drawdown_period ────────────────────────────────


class TestFindMaxDrawdownPeriod:
    """Tests for find_max_drawdown_period."""

    def test_simple_drawdown(self):
        """Win, win, loss => peak is day 2, trough is day 3."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False},
        ])
        trades = simulate_strategy(df, name="test")
        peak, trough = find_max_drawdown_period(trades)

        # Peak is when cumulative was at its max before the trough
        # cumulative: 200, 400, -1400 => peak at index[1], trough at index[2]
        assert peak == trades.index[1]
        assert trough == trades.index[2]

    def test_drawdown_with_recovery(self):
        """Win, win, loss, win, win => drawdown period is day2 to day3."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
        ])
        trades = simulate_strategy(df, name="test")
        peak, trough = find_max_drawdown_period(trades)

        # cumulative: 200, 400, -1400, -1200, -1000
        # Only one loss so the max drawdown is from day2 peak (400) to day3 trough (-1400)
        assert peak == trades.index[1]
        assert trough == trades.index[2]

    def test_two_drawdowns_picks_worst(self):
        """When there are two separate drawdowns, the function returns the worst one."""
        records = [
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False},
            # Recover with many wins
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            # Second drawdown: 2 losses in a row (worse)
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False},
        ]
        df = make_df(records)
        trades = simulate_strategy(df, name="test")
        peak, trough = find_max_drawdown_period(trades)

        # First drawdown: 200 -> -1600, dd=-1800
        # After recovery: cumulative reaches 200 + (-1800) + 10*200 = 400
        # Second drawdown: 400 -> 400-3600 = -3200, dd=-3600 (worse)
        # Trough should be the last row (index 13)
        assert trough == trades.index[-1]

    def test_no_drawdown_all_wins(self):
        """All wins means drawdown is always 0; peak and trough are the same."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
        ])
        trades = simulate_strategy(df, name="test")
        peak, trough = find_max_drawdown_period(trades)

        # drawdown is all zeros, idxmin picks the first occurrence
        # peak and trough should be the same or very close
        assert peak == trough

    def test_empty_trades(self):
        """Empty trades returns (None, None)."""
        df = make_df([])
        trades = simulate_strategy(df, name="test")
        peak, trough = find_max_drawdown_period(trades)

        assert peak is None
        assert trough is None

    def test_single_loss(self):
        """Single loss: peak and trough are the same date."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False},
        ])
        trades = simulate_strategy(df, name="test")
        peak, trough = find_max_drawdown_period(trades)

        # Only one row; trough is that row, peak candidates at that row
        assert peak == trough
        assert peak == trades.index[0]

    def test_immediate_loss_then_wins(self):
        """Loss on day 1 then wins: peak is day 1, trough is day 1."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
        ])
        trades = simulate_strategy(df, name="test")
        peak, trough = find_max_drawdown_period(trades)

        # cumulative: -1800, -1600, -1400, ..., 0
        # running_max: -1800, -1600, -1400, ..., 0 (monotonically increasing)
        # drawdown: 0 everywhere since cumulative == running_max at each point
        # Actually: cummax starts at -1800, then max(-1800, -1600)=-1600, etc.
        # So drawdown = cum - running_max, e.g. day1: -1800 - (-1800) = 0
        # All zeros => peak == trough
        assert peak == trough


# ── print_metrics_table ─────────────────────────────────────


class TestPrintMetricsTable:
    """Smoke tests for print_metrics_table."""

    def test_prints_without_error(self, capsys):
        """print_metrics_table should print output without raising."""
        metrics = {
            "Claude Analysis": {
                "total_pnl": 1000,
                "win_rate": 0.9,
                "profit_factor": 2.0,
                "max_drawdown": -1800,
                "num_trades": 10,
            },
            "Baseline": {
                "total_pnl": -500,
                "win_rate": 0.8,
                "profit_factor": 0.5,
                "max_drawdown": -3600,
                "num_trades": 10,
            },
        }
        from backtest import print_metrics_table
        print_metrics_table(metrics)

        captured = capsys.readouterr()
        assert "Claude Analysis" in captured.out
        assert "Baseline" in captured.out

    def test_empty_metrics_skipped(self, capsys):
        """Strategies with empty metric dicts should be skipped."""
        metrics = {
            "Empty": {},
            "Valid": {
                "total_pnl": 200,
                "win_rate": 1.0,
                "profit_factor": float("inf"),
                "max_drawdown": 0,
                "num_trades": 1,
            },
        }
        from backtest import print_metrics_table
        print_metrics_table(metrics)

        captured = capsys.readouterr()
        assert "Valid" in captured.out
        # "Empty" appears as a key but its row is skipped (no P&L line for it)
        # The name might appear in the header area but not as a data row
        assert "$" in captured.out  # at least the Valid row printed


# ── Integration-style tests ─────────────────────────────────


class TestIntegration:
    """End-to-end tests combining simulate + metrics."""

    def test_breakeven_at_nine_to_one(self):
        """At 9:1 risk/reward, 9 wins and 1 loss should break even."""
        records = [
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True}
            for _ in range(9)
        ] + [
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False},
        ]
        df = make_df(records)
        trades = simulate_strategy(df, name="test")
        m = compute_metrics(trades)

        assert m["total_pnl"] == 0
        assert m["win_rate"] == pytest.approx(0.9)
        assert m["profit_factor"] == pytest.approx(1.0)

    def test_profitable_above_ninety_pct(self):
        """10 wins and 1 loss at 1x sizing: net positive."""
        records = [
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True}
            for _ in range(10)
        ] + [
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False},
        ]
        df = make_df(records)
        trades = simulate_strategy(df, name="test")
        m = compute_metrics(trades)

        # 10 * 200 - 1 * 1800 = 200
        assert m["total_pnl"] == 200
        assert m["profit_factor"] > 1.0

    def test_unprofitable_below_ninety_pct(self):
        """8 wins and 2 losses at 1x sizing: net negative."""
        records = [
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True}
            for _ in range(8)
        ] + [
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False}
            for _ in range(2)
        ]
        df = make_df(records)
        trades = simulate_strategy(df, name="test")
        m = compute_metrics(trades)

        # 8 * 200 - 2 * 1800 = 1600 - 3600 = -2000
        assert m["total_pnl"] == -2000
        assert m["profit_factor"] < 1.0

    def test_override_contracts_larger_sizing(self):
        """Override to 5 contracts scales both wins and losses."""
        df = make_df([
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": True},
            {"recommended_structure": "CCS", "label_confidence": "MODERATE", "structure_correct": False},
        ])
        trades = simulate_strategy(df, name="test", override_contracts=5)
        m = compute_metrics(trades)

        assert m["total_pnl"] == (200 * 5) + (-1800 * 5)
        assert m["avg_win"] == 1000
        assert m["avg_loss"] == -9000
