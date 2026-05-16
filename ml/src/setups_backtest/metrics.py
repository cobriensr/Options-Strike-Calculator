"""Performance metrics + Markdown report generator for the futures backtest.

All metrics specified in docs/superpowers/specs/futures-setups-backtest-2026-05-15.md:
  - N signals, win rate, avg R, expectancy ($), profit factor
  - Max consecutive losers
  - Hit-rate by time-of-day bucket
  - Sharpe on signal-day returns (annualized)
  - Max drawdown ($ and % of cumulative equity)

Everything is a pure function over the Trade DataFrame produced by
``harness.trades_to_dataframe``.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

import numpy as np
import pandas as pd

# Time-of-day buckets in minutes-since-RTH-open (13:30 UTC = 09:30 ET).
# Spec called for 15/15/30/60/60/60/30 = 270 minutes (covers through 18:00 UTC =
# 14:00 ET), but RTH actually ends at 20:00 UTC = 16:00 ET. We extend with two
# 60-min buckets so the final two hours of trade are reported, not silently
# dropped. Documented deviation from the spec.
TOD_BUCKETS_MIN: list[tuple[str, int, int]] = [
    ("13:30-13:45", 0, 15),
    ("13:45-14:00", 15, 30),
    ("14:00-14:30", 30, 60),
    ("14:30-15:30", 60, 120),
    ("15:30-16:30", 120, 180),
    ("16:30-17:30", 180, 240),
    ("17:30-18:00", 240, 270),
    ("18:00-19:00", 270, 330),
    ("19:00-20:00", 330, 390),
]

ANNUALIZATION_FACTOR = 252


# ---------------------------------------------------------------------------
# Core metrics
# ---------------------------------------------------------------------------


def compute_metrics(trades: pd.DataFrame) -> dict[str, Any]:
    """Compute all spec'd metrics from a trade-log DataFrame.

    Returns a dict with scalar + nested time-of-day breakdowns. Numeric NaNs
    are returned as ``None`` so the dict is JSON-serializable.
    """
    if trades.empty:
        return _empty_metrics()

    trades = trades.copy()
    trades["is_win"] = trades["net_pnl_dollars"] > 0
    trades["is_loss"] = trades["net_pnl_dollars"] < 0

    n = int(len(trades))
    n_wins = int(trades["is_win"].sum())
    n_losses = int(trades["is_loss"].sum())
    win_rate = n_wins / n if n > 0 else float("nan")

    avg_r = float(trades["r_multiple"].mean())
    expectancy = float(trades["net_pnl_dollars"].mean())

    gross_win = float(trades.loc[trades["is_win"], "net_pnl_dollars"].sum())
    gross_loss = float(trades.loc[trades["is_loss"], "net_pnl_dollars"].sum())
    profit_factor = (
        gross_win / abs(gross_loss) if gross_loss < 0 else float("inf")
    )

    max_consec_losers = _max_consecutive(trades["is_loss"].to_list())

    tod_breakdown = _tod_breakdown(trades)
    sharpe = _signal_day_sharpe(trades)
    dd_dollars, dd_pct = _max_drawdown(trades)

    return {
        "n_signals": n,
        "n_wins": n_wins,
        "n_losses": n_losses,
        "win_rate": _nan_to_none(win_rate),
        "avg_r_multiple": _nan_to_none(avg_r),
        "expectancy_dollars": _nan_to_none(expectancy),
        "profit_factor": _nan_to_none(profit_factor)
        if profit_factor != float("inf")
        else "inf",
        "max_consecutive_losers": max_consec_losers,
        "sharpe_signal_days": _nan_to_none(sharpe),
        "max_drawdown_dollars": _nan_to_none(dd_dollars),
        "max_drawdown_pct": _nan_to_none(dd_pct),
        "time_of_day": tod_breakdown,
        "gross_win_dollars": _nan_to_none(gross_win),
        "gross_loss_dollars": _nan_to_none(gross_loss),
        "cumulative_net_pnl_dollars": float(trades["net_pnl_dollars"].sum()),
    }


def _empty_metrics() -> dict[str, Any]:
    return {
        "n_signals": 0,
        "n_wins": 0,
        "n_losses": 0,
        "win_rate": None,
        "avg_r_multiple": None,
        "expectancy_dollars": None,
        "profit_factor": None,
        "max_consecutive_losers": 0,
        "sharpe_signal_days": None,
        "max_drawdown_dollars": None,
        "max_drawdown_pct": None,
        "time_of_day": {},
        "gross_win_dollars": 0.0,
        "gross_loss_dollars": 0.0,
        "cumulative_net_pnl_dollars": 0.0,
    }


def _nan_to_none(x: float) -> float | None:
    return None if pd.isna(x) else float(x)


def _max_consecutive(flags: Sequence[bool]) -> int:
    """Longest run of True values."""
    best = 0
    cur = 0
    for f in flags:
        if f:
            cur += 1
            best = max(best, cur)
        else:
            cur = 0
    return best


def _tod_breakdown(trades: pd.DataFrame) -> dict[str, dict[str, Any]]:
    """Per-time-of-day-bucket stats (n, win_rate, expectancy)."""
    if trades.empty:
        return {}
    rth_open_minutes = 13 * 60 + 30  # 13:30 UTC
    entry_minutes = (
        trades["entry_ts"].dt.hour * 60 + trades["entry_ts"].dt.minute - rth_open_minutes
    )
    out: dict[str, dict[str, Any]] = {}
    for label, lo, hi in TOD_BUCKETS_MIN:
        mask = (entry_minutes >= lo) & (entry_minutes < hi)
        sub = trades.loc[mask]
        n = int(len(sub))
        if n == 0:
            out[label] = {"n": 0, "win_rate": None, "expectancy_dollars": None}
            continue
        wins = int((sub["net_pnl_dollars"] > 0).sum())
        out[label] = {
            "n": n,
            "win_rate": wins / n,
            "expectancy_dollars": float(sub["net_pnl_dollars"].mean()),
        }
    return out


def _signal_day_sharpe(trades: pd.DataFrame) -> float:
    """Annualized Sharpe on per-signal-day P&L sums.

    Aggregates trades by entry date, then annualizes the daily P&L series
    with ``sqrt(252)``. Returns NaN if fewer than 2 signal days.
    """
    daily = trades.groupby(trades["entry_ts"].dt.date)["net_pnl_dollars"].sum()
    if len(daily) < 2:
        return float("nan")
    std = daily.std(ddof=1)
    if std == 0 or pd.isna(std):
        return float("nan")
    return float(daily.mean() / std * np.sqrt(ANNUALIZATION_FACTOR))


def _max_drawdown(trades: pd.DataFrame) -> tuple[float, float]:
    """Max drawdown ($ and as % of running peak).

    Equity curve is the running sum of net_pnl ordered by entry_ts.
    """
    if trades.empty:
        return float("nan"), float("nan")
    sorted_ = trades.sort_values("entry_ts")
    equity = sorted_["net_pnl_dollars"].cumsum()
    running_peak = equity.cummax()
    dd_dollars = (equity - running_peak).min()
    # As a percentage of running peak, with floor at 1 to avoid zero-div.
    peak_at_min = running_peak.loc[(equity - running_peak).idxmin()]
    dd_pct = (
        float(dd_dollars) / float(peak_at_min) * 100.0
        if peak_at_min > 0
        else float("nan")
    )
    return float(dd_dollars), dd_pct


# ---------------------------------------------------------------------------
# Markdown report
# ---------------------------------------------------------------------------


def format_report(
    setup_name: str,
    metrics: dict[str, Any],
    test_window: tuple[str, str],
    *,
    notes: str | None = None,
) -> str:
    """Render a per-setup Markdown report.

    Args:
        setup_name: e.g. ``"nq-ofi-extreme"``.
        metrics: output of ``compute_metrics``.
        test_window: ``(start_iso, end_iso)`` to print in the header.
        notes: optional free-form notes section appended at the bottom.
    """
    n = metrics["n_signals"]
    if n == 0:
        return _empty_report(setup_name, test_window, notes)

    lines = [
        f"# Setup: `{setup_name}`",
        "",
        f"**Test window:** {test_window[0]} → {test_window[1]}",
        f"**Generated:** {datetime.now(UTC).strftime('%Y-%m-%dT%H:%M:%S')}Z",
        "",
        "## Headline",
        "",
        f"- **N signals:** {n}",
        f"- **Win rate:** {_fmt_pct(metrics['win_rate'])}",
        f"- **Avg R:** {_fmt_num(metrics['avg_r_multiple'])}",
        f"- **Expectancy / signal:** {_fmt_dollar(metrics['expectancy_dollars'])}",
        f"- **Cumulative net P&L:** {_fmt_dollar(metrics['cumulative_net_pnl_dollars'])}",
        f"- **Profit factor:** {_fmt_num(metrics['profit_factor'])}",
        f"- **Max consecutive losers:** {metrics['max_consecutive_losers']}",
        f"- **Sharpe (signal-day, annualized):** {_fmt_num(metrics['sharpe_signal_days'])}",
        f"- **Max drawdown:** {_fmt_dollar(metrics['max_drawdown_dollars'])} ({_fmt_pct_simple(metrics['max_drawdown_pct'])})",
        "",
        "## Hit rate by time-of-day",
        "",
        "| Bucket (UTC)  | N | Win rate | Expectancy ($) |",
        "| ------------- | - | -------- | -------------- |",
    ]
    for label, _, _ in TOD_BUCKETS_MIN:
        bucket = metrics["time_of_day"].get(label, {})
        bn = bucket.get("n", 0)
        wr = bucket.get("win_rate")
        ex = bucket.get("expectancy_dollars")
        lines.append(
            f"| {label} | {bn} | {_fmt_pct(wr) if wr is not None else '—'} "
            f"| {_fmt_dollar(ex) if ex is not None else '—'} |"
        )

    lines.extend(
        [
            "",
            "## Caveats",
            "",
            "- **Sharpe is signal-day-only** — non-signal days are dropped, not "
            "zero-filled. A low-frequency setup with a few large wins will look "
            "better here than in deployment. Compare *expectancy × signal "
            "frequency* across setups for a deployment-grade view.",
            "- **Slippage = 1.5 ticks per side** plus **$1.25/side commission**. "
            "Net of cost. Conservative for liquid midday, tight for the open and "
            "around news.",
            "- **R-multiple denominator uses pre-slippage entry** (chart risk), "
            "numerator is net P&L — slippage flows only into the numerator.",
            "",
            "## Threshold for go/no-go",
            "",
            f"- N signals ≥ 20: {'YES' if n >= 20 else 'NO (insufficient sample)'}",
            f"- Expectancy > 0: {'YES' if (metrics['expectancy_dollars'] or 0) > 0 else 'NO'}",
            f"- Profit factor > 1.3: {'YES' if isinstance(metrics['profit_factor'], (int, float)) and metrics['profit_factor'] > 1.3 else 'NO'}",
            "",
        ]
    )
    if notes:
        lines.extend(["## Notes", "", notes, ""])
    return "\n".join(lines)


def _empty_report(
    setup_name: str,
    window: tuple[str, str],
    notes: str | None,
) -> str:
    body = [
        f"# Setup: `{setup_name}`",
        "",
        f"**Test window:** {window[0]} → {window[1]}",
        f"**Generated:** {datetime.now(UTC).strftime('%Y-%m-%dT%H:%M:%S')}Z",
        "",
        "**No signals fired in the test window.**",
        "",
        "Either the rule's thresholds are too strict for the current regime,",
        "or required data (e.g., earnings calendar, dealer gamma history) is",
        "missing for this period. See `results.json` for `data_unavailable`",
        "flags if applicable.",
        "",
    ]
    if notes:
        body.extend(["## Notes", "", notes, ""])
    return "\n".join(body)


def _fmt_pct(x: float | None) -> str:
    if x is None or pd.isna(x):
        return "—"
    return f"{x * 100:.1f}%"


def _fmt_pct_simple(x: float | None) -> str:
    if x is None or pd.isna(x):
        return "—"
    return f"{x:.1f}%"


def _fmt_num(x: float | str | None) -> str:
    if x is None:
        return "—"
    if isinstance(x, str):
        return x
    if pd.isna(x):
        return "—"
    return f"{x:.3f}"


def _fmt_dollar(x: float | None) -> str:
    if x is None or pd.isna(x):
        return "—"
    sign = "-" if x < 0 else ""
    return f"{sign}${abs(x):,.2f}"
