"""Standard backtest metrics over a list of closed trades.

v1 scope (Phase 1):
- Total P&L (dollars), trade count
- Win rate, avg win, avg loss, expectancy
- Profit factor (gross wins / gross losses)
- Max drawdown (absolute $, percent of starting equity)
- Sharpe, Sortino — annualized, from daily-aggregated P&L
- Exposure %: fraction of eligible-session time spent in a trade
- Duration stats (median, p95)

E1.4b additions:
- Deflated Sharpe Ratio (Bailey & Lopez de Prado 2014). Adjusts raw
  Sharpe for sample length, skew, kurtosis, and most importantly for
  the number of effective independent trials — so a sweep that tries
  10K configs and picks the best doesn't get to claim the best Sharpe
  as edge without deflation.

Still deferred to the sweep orchestrator:
- Stationary bootstrap CIs on Sharpe → `bootstrap.py`
- PBO (Probability of Backtest Overfitting) → `pbo.py`

The guiding principle per the backtesting-frameworks skill: these
numbers are *descriptive*, not promises. The analyzer downstream is
responsible for gating on thresholds (profit_factor > 1.4, etc.).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from scipy import stats

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


# ─────────────────────────────────────────────────────────────────────────
# Deflated Sharpe Ratio (Bailey & Lopez de Prado 2014)
# ─────────────────────────────────────────────────────────────────────────

# Euler-Mascheroni constant — appears in the expected-max-order-statistic
# formula for the normal distribution. Used in `expected_max_sharpe_under_null()`.
_EULER_MASCHERONI = 0.5772156649015329


def expected_max_sharpe_under_null(
    n_trials: int, trial_sharpe_std: float
) -> float:
    """Expected maximum Sharpe ratio across N independent trials under null.

    Bailey & Lopez de Prado 2014 (SSRN 2460551), Eq. 21. Models the best
    of N IID normal-distributed Sharpe ratios drawn from a zero-mean
    distribution with std `trial_sharpe_std`. Gives the "this is what
    sheer luck produces" baseline.

    Formula:
        E[max SR | N, σ] ≈ σ * [ (1 - γ) * Φ^(-1)(1 - 1/N)
                               + γ     * Φ^(-1)(1 - 1/(N*e)) ]

    where γ is the Euler-Mascheroni constant and Φ^(-1) is the inverse
    standard normal CDF.

    Returns 0 when n_trials <= 1 (undefined — no luck-best to compare).
    """
    if n_trials <= 1 or trial_sharpe_std <= 0:
        return 0.0
    z1 = stats.norm.ppf(1.0 - 1.0 / n_trials)
    z2 = stats.norm.ppf(1.0 - 1.0 / (n_trials * np.e))
    return float(
        trial_sharpe_std
        * ((1 - _EULER_MASCHERONI) * z1 + _EULER_MASCHERONI * z2)
    )


def deflated_sharpe_ratio(
    sharpe: float,
    n_samples: int,
    n_effective_trials: int,
    trial_sharpe_std: float,
    skewness: float = 0.0,
    excess_kurtosis: float = 0.0,
) -> dict:
    """Compute the Deflated Sharpe Ratio.

    Parameters
    ----------
    sharpe:
        Observed Sharpe ratio (annualized or not — consistency with
        `n_samples` is what matters).
    n_samples:
        Length of the returns series the Sharpe was computed from.
    n_effective_trials:
        Number of effectively-independent trials the search explored.
        Optuna/TPE typically clusters samples in high-Sharpe regions;
        use the `effective_trial_estimation.param_cluster` method in
        `acceptance.yml` to estimate this from the full sweep.
    trial_sharpe_std:
        Std of Sharpe ratios across all N trials in the sweep.
    skewness:
        Third moment of the returns distribution (not Sharpe). Defaults
        to 0 (Gaussian assumption). Non-zero skew affects the
        denominator — left-skewed returns inflate the deflation.
    excess_kurtosis:
        Fourth-moment minus 3 (Gaussian = 0). Positive kurtosis → fatter
        tails → more uncertainty in Sharpe → more deflation.

    Returns
    -------
    dict with keys:
        `dsr`                      : the Deflated Sharpe Ratio as a
                                     probability in [0, 1]. > 0.95 means
                                     we reject the null of zero edge at
                                     95% confidence.
        `expected_max_sr_null`     : the benchmark the observed Sharpe
                                     must beat.
        `sharpe_std_adjusted`      : denominator used in the deflation.
        `sharpe`, `n_samples`,
        `n_effective_trials`,
        `trial_sharpe_std`         : inputs echoed back for audit.
    """
    if n_samples < 2:
        raise ValueError(f"n_samples must be >= 2, got {n_samples}")

    expected_max_sr = expected_max_sharpe_under_null(
        n_effective_trials, trial_sharpe_std
    )

    # Denominator: Sharpe estimation std with skew/kurt adjustment.
    # Eq. 11 in de Prado 2014 (rearranged for a one-sided comparison).
    # Clamp the bracket to a small positive floor so very high SR values
    # combined with extreme skew/kurt don't cause sqrt(negative).
    bracket = 1 - skewness * sharpe + (excess_kurtosis / 4.0) * sharpe**2
    bracket = max(bracket, 1e-9)
    sharpe_std_adjusted = float(np.sqrt(bracket / (n_samples - 1)))

    if sharpe_std_adjusted <= 0:
        dsr = 1.0 if sharpe > expected_max_sr else 0.0
    else:
        z = (sharpe - expected_max_sr) / sharpe_std_adjusted
        dsr = float(stats.norm.cdf(z))

    return {
        "dsr": dsr,
        "expected_max_sr_null": expected_max_sr,
        "sharpe_std_adjusted": sharpe_std_adjusted,
        "sharpe": sharpe,
        "n_samples": n_samples,
        "n_effective_trials": n_effective_trials,
        "trial_sharpe_std": trial_sharpe_std,
    }


def estimate_effective_trials_by_correlation(
    param_matrix: np.ndarray,
    correlation_threshold: float = 0.7,
) -> int:
    """Estimate the number of effectively-independent trials via clustering.

    Used when a sweep tests thousands of parameter configurations — most
    of which are near-duplicates (TPE/Bayesian search concentrates
    samples in high-Sharpe regions). Naive trial count overstates
    independence; clustering gives a defensible reduction.

    Parameters
    ----------
    param_matrix:
        Shape (N_trials, N_params). Each row is one trial's param vector
        (normalized to [0, 1] or standardized before calling).
    correlation_threshold:
        Trials whose Pearson correlation exceeds this threshold are
        considered the same "cluster" for effective-trial accounting.
        0.7 matches the `acceptance.yml` default.

    Returns
    -------
    Integer count of clusters. Used as `n_effective_trials` in
    `deflated_sharpe_ratio()`.
    """
    M = np.asarray(param_matrix, dtype=np.float64)
    if M.ndim != 2:
        raise ValueError(f"param_matrix must be 2D, got shape {M.shape}")
    n_trials = M.shape[0]
    if n_trials < 2:
        return n_trials

    # Pairwise correlation between trial param vectors. Since params are
    # different dimensions (not a time-series), we correlate ACROSS trials
    # within each parameter, then aggregate. Simpler: just compute the
    # row-pairwise correlation matrix.
    corr = np.corrcoef(M)  # shape (n_trials, n_trials)
    # Greedy clustering: walk trials in order; a trial joins cluster c if
    # it correlates > threshold with any member of c; otherwise start new.
    cluster_of: list[int] = [-1] * n_trials
    next_cluster = 0
    for i in range(n_trials):
        assigned = -1
        for j in range(i):
            if cluster_of[j] >= 0 and abs(corr[i, j]) > correlation_threshold:
                assigned = cluster_of[j]
                break
        if assigned < 0:
            cluster_of[i] = next_cluster
            next_cluster += 1
        else:
            cluster_of[i] = assigned

    return next_cluster
