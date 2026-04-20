"""Standard backtest metrics over a list of closed trades.

v1 scope (Phase 1):
- Total P&L (dollars), trade count
- Win rate, avg win, avg loss, expectancy
- Profit factor (gross wins / gross losses)
- Max drawdown (absolute $, percent of starting equity)
- Sharpe, Sortino — annualized, from daily-aggregated P&L
- Exposure %: fraction of eligible-session time spent in a trade
- Duration stats (median, p95)

Deferred to Phase 2:
- Deflated Sharpe Ratio (Bailey & Lopez de Prado). Requires the sweep
  context (number of trials, correlation of trial returns) that only
  exists at E1.4 time.
- Stationary bootstrap CIs on Sharpe.
- PBO (Probability of Backtest Overfitting) — again, sweep-level.

The guiding principle per the backtesting-frameworks skill: these
numbers are *descriptive*, not promises. The analyzer downstream is
responsible for gating on thresholds (profit_factor > 1.4, etc.).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from pac_backtest.trades import Trade


@dataclass
class BacktestMetrics:
    """Flat container of all computed metrics for one backtest run."""

    trade_count: int = 0
    wins: int = 0
    losses: int = 0
    scratches: int = 0  # zero-P&L trades (rare but possible)

    total_pnl_dollars: float = 0.0
    gross_wins_dollars: float = 0.0
    gross_losses_dollars: float = 0.0  # negative value

    win_rate: float = 0.0
    avg_win_dollars: float = 0.0
    avg_loss_dollars: float = 0.0
    expectancy_dollars: float = 0.0
    profit_factor: float = 0.0

    max_drawdown_dollars: float = 0.0  # negative value (worst trough)
    max_drawdown_pct: float = 0.0  # drawdown / peak equity, negative

    sharpe_annualized: float = 0.0
    sortino_annualized: float = 0.0

    exposure_pct: float = 0.0  # fraction of eligible session time in a trade

    median_duration_minutes: float = 0.0
    p95_duration_minutes: float = 0.0

    # Retention for debug / audit — which entry/exit reasons drove wins vs losses
    by_setup_tag: dict[str, dict[str, float]] = field(default_factory=dict)


def _safe_div(a: float, b: float) -> float:
    """Division that returns 0 for zero denominators (for ratios in empty sets)."""
    return a / b if b != 0 else 0.0


def compute_metrics(
    trades: list[Trade],
    *,
    trading_days_per_year: int = 252,
    eligible_bars_count: int | None = None,
    total_bars_in_trade: int | None = None,
) -> BacktestMetrics:
    """Aggregate metrics from a list of closed Trades.

    Parameters
    ----------
    trades:
        List of closed Trade objects (status == "closed").
    trading_days_per_year:
        For annualizing Sharpe / Sortino. 252 for US futures.
    eligible_bars_count, total_bars_in_trade:
        Optional for computing `exposure_pct`. If not supplied, the metric
        defaults to 0.0.

    Returns
    -------
    BacktestMetrics with all fields populated.
    """
    m = BacktestMetrics()

    if not trades:
        return m

    closed = [t for t in trades if t.status == "closed" and t.pnl_dollars is not None]
    m.trade_count = len(closed)

    if m.trade_count == 0:
        return m

    pnls = np.array([t.pnl_dollars for t in closed], dtype=float)
    m.total_pnl_dollars = float(pnls.sum())

    wins_mask = pnls > 0
    losses_mask = pnls < 0

    m.wins = int(wins_mask.sum())
    m.losses = int(losses_mask.sum())
    m.scratches = m.trade_count - m.wins - m.losses

    m.gross_wins_dollars = float(pnls[wins_mask].sum()) if m.wins else 0.0
    m.gross_losses_dollars = float(pnls[losses_mask].sum()) if m.losses else 0.0

    m.win_rate = m.wins / m.trade_count
    m.avg_win_dollars = _safe_div(m.gross_wins_dollars, m.wins)
    m.avg_loss_dollars = _safe_div(m.gross_losses_dollars, m.losses)
    m.expectancy_dollars = float(pnls.mean())
    # Profit factor: gross wins / |gross losses|. Convention: +inf if no losses,
    # 0 if no wins. We clamp +inf to a large finite value (999.0) so downstream
    # stats pipelines don't break on JSON serialization.
    if m.gross_losses_dollars < 0:
        m.profit_factor = float(m.gross_wins_dollars / abs(m.gross_losses_dollars))
    elif m.gross_wins_dollars > 0:
        m.profit_factor = 999.0  # no losses — near-infinity
    else:
        m.profit_factor = 0.0

    # --- Drawdown (computed on cumulative equity curve, per-trade cadence) ---
    equity = pnls.cumsum()
    peaks = np.maximum.accumulate(equity)
    drawdowns = equity - peaks  # negative values
    m.max_drawdown_dollars = float(drawdowns.min()) if len(drawdowns) else 0.0
    # Percent drawdown uses the peak that preceded the trough; if peak is 0 or
    # negative (underwater from the start), we report absolute dollars only.
    peak_at_trough_idx = int(drawdowns.argmin())
    peak_at_trough = peaks[peak_at_trough_idx]
    if peak_at_trough > 0:
        m.max_drawdown_pct = m.max_drawdown_dollars / peak_at_trough
    else:
        m.max_drawdown_pct = 0.0

    # --- Sharpe / Sortino — from daily-aggregated P&L ---
    df_trades = pd.DataFrame(
        {
            "day": [t.exit_ts.date() for t in closed],
            "pnl": pnls,
        }
    )
    daily_pnl = df_trades.groupby("day")["pnl"].sum().to_numpy()
    if len(daily_pnl) > 1:
        mean_d = daily_pnl.mean()
        std_d = daily_pnl.std(ddof=1)
        m.sharpe_annualized = float(
            _safe_div(mean_d, std_d) * np.sqrt(trading_days_per_year)
        )
        # Sortino: downside deviation only
        downside = daily_pnl[daily_pnl < 0]
        if len(downside) > 0:
            downside_std = np.sqrt((downside**2).mean())
            m.sortino_annualized = float(
                _safe_div(mean_d, downside_std) * np.sqrt(trading_days_per_year)
            )
        else:
            m.sortino_annualized = 999.0  # no losing days
    else:
        m.sharpe_annualized = 0.0
        m.sortino_annualized = 0.0

    # --- Exposure ---
    if eligible_bars_count and total_bars_in_trade:
        m.exposure_pct = total_bars_in_trade / eligible_bars_count

    # --- Duration ---
    durations = np.array(
        [t.duration_minutes for t in closed if t.duration_minutes is not None],
        dtype=float,
    )
    if len(durations) > 0:
        m.median_duration_minutes = float(np.median(durations))
        m.p95_duration_minutes = float(np.percentile(durations, 95))

    # --- Per-setup breakdown (useful for cohort analysis) ---
    for tag in {t.setup_tag for t in closed}:
        tag_pnls = np.array(
            [t.pnl_dollars for t in closed if t.setup_tag == tag], dtype=float
        )
        tag_wins = int((tag_pnls > 0).sum())
        m.by_setup_tag[tag] = {
            "count": float(len(tag_pnls)),
            "total_pnl": float(tag_pnls.sum()),
            "win_rate": float(_safe_div(tag_wins, len(tag_pnls))),
            "avg_pnl": float(tag_pnls.mean()),
        }

    return m


def metrics_to_dict(m: BacktestMetrics) -> dict:
    """Flatten BacktestMetrics to a dict for JSON / DataFrame export."""
    return {
        "trade_count": m.trade_count,
        "wins": m.wins,
        "losses": m.losses,
        "scratches": m.scratches,
        "total_pnl_dollars": m.total_pnl_dollars,
        "gross_wins_dollars": m.gross_wins_dollars,
        "gross_losses_dollars": m.gross_losses_dollars,
        "win_rate": m.win_rate,
        "avg_win_dollars": m.avg_win_dollars,
        "avg_loss_dollars": m.avg_loss_dollars,
        "expectancy_dollars": m.expectancy_dollars,
        "profit_factor": m.profit_factor,
        "max_drawdown_dollars": m.max_drawdown_dollars,
        "max_drawdown_pct": m.max_drawdown_pct,
        "sharpe_annualized": m.sharpe_annualized,
        "sortino_annualized": m.sortino_annualized,
        "exposure_pct": m.exposure_pct,
        "median_duration_minutes": m.median_duration_minutes,
        "p95_duration_minutes": m.p95_duration_minutes,
        "by_setup_tag": m.by_setup_tag,
    }
