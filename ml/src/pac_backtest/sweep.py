"""Optuna-inside-CPCV sweep orchestrator.

One Optuna study per CPCV fold (not one for the whole history) —
per Wiecki et al. 2016 this is the key discipline that prevents
Bayesian search from clustering samples in in-sample noise.
Combined with joblib parallelism across folds + configs, a typical
sweep finishes in minutes not hours.

v1 search space (per v5 plan, broadened beyond pure reversal):

  entry_trigger:       {CHOCH_REVERSAL, CHOCH_PLUS_REVERSAL, BOS_BREAKOUT}
  exit_trigger:        {OPPOSITE_CHOCH, OPPOSITE_BOS, ATR_TARGET, SESSION_END}
  stop_placement:      {N_ATR, SWING_EXTREME}
  stop_atr_multiple:   float [0.5, 3.0]
  target_atr_multiple: float [1.0, 4.0]
  session:             {RTH, NY_OPEN, RTH_EX_LUNCH}
  iv_tercile_filter:   {None, low, mid, high}
  event_day_filter:    {None, skip_events, events_only}

Objective: maximize in-sample Sharpe. Secondary metrics (PF, DD,
expectancy) are recorded but don't steer Optuna — per the plan, the
gating happens in cross_market.py against the locked acceptance.yml.

Output per fold: dict with best IS params, full OOS metrics, all
trials' IS Sharpe (for effective-trial-count estimation downstream).
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np
import optuna
import pandas as pd
from joblib import Parallel, delayed

from pac_backtest.loop import run_backtest
from pac_backtest.metrics import compute_metrics
from pac_backtest.params import (
    EntryTrigger,
    EntryVsOb,
    ExitTrigger,
    OnOppositeSignal,
    SessionBucket,
    SessionFilter,
    StopPlacement,
    StrategyParams,
)

# Keep Optuna logs clean unless the caller explicitly opts in
optuna.logging.set_verbosity(optuna.logging.WARNING)

_LOG = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────
# Fold result structure
# ─────────────────────────────────────────────────────────────────────────


@dataclass
class FoldResult:
    """All output from a single CPCV fold's Optuna study + OOS eval."""

    fold_index: int
    n_train_bars: int
    n_test_bars: int
    n_trials: int
    best_is_sharpe: float
    best_params: dict[str, Any]
    oos_metrics: dict[str, Any]
    trial_sharpes: list[float] = field(default_factory=list)
    # params for each trial (for effective-trial-count estimation)
    trial_params_vectors: list[list[float]] = field(default_factory=list)


def fold_result_to_dict(fr: FoldResult) -> dict[str, Any]:
    """Convert FoldResult to a JSON-serializable dict."""
    d = asdict(fr)
    # asdict leaves dataclass nesting intact; lists of floats/dicts serialize fine
    return d


# ─────────────────────────────────────────────────────────────────────────
# Optuna search-space definition
# ─────────────────────────────────────────────────────────────────────────


def _sample_params(trial: optuna.Trial) -> StrategyParams:
    """Sample a StrategyParams from the Optuna search space.

    v4 (E1.4d) adds 9 dimensions: session_bucket, min_ob_volume_z,
    min_ob_pct_atr, entry_vs_ob, min_z_entry_vwap, min_adx_14,
    on_opposite_signal, exit_after_n_bos, plus OB_BOUNDARY in stop_placement.
    """
    entry_str = trial.suggest_categorical(
        "entry_trigger",
        [t.value for t in EntryTrigger],
    )
    exit_str = trial.suggest_categorical(
        "exit_trigger",
        [t.value for t in ExitTrigger],
    )
    stop_str = trial.suggest_categorical(
        "stop_placement",
        [s.value for s in StopPlacement],
    )
    session_str = trial.suggest_categorical(
        "session",
        [s.value for s in SessionFilter],
    )
    stop_atr = trial.suggest_float("stop_atr_multiple", 0.5, 3.0, step=0.25)
    target_atr = trial.suggest_float("target_atr_multiple", 1.0, 4.0, step=0.25)
    iv_filter = trial.suggest_categorical(
        "iv_tercile_filter", [None, "low", "mid", "high"]
    )
    event_filter = trial.suggest_categorical(
        "event_day_filter", [None, "skip_events", "events_only"]
    )

    # ── E1.4d v4 search-space additions ───────────────────────────────
    session_bucket_str = trial.suggest_categorical(
        "session_bucket", [s.value for s in SessionBucket]
    )
    # Cardinality reduced for v4 coarse-pass: the first sweep needs to
    # answer "does this filter matter at all?", not pinpoint a threshold.
    # Total search-space volume ~11× smaller than the first v4 design so
    # 50 trials cover proportionally more of it. v5 can zoom in on
    # whichever dims the v4 winner used.
    min_ob_vol_z = trial.suggest_categorical(
        "min_ob_volume_z", [None, 1.0, 2.0]
    )
    min_ob_pct = trial.suggest_categorical(
        "min_ob_pct_atr", [None, 50.0]
    )
    entry_vs_ob_str = trial.suggest_categorical(
        "entry_vs_ob", [s.value for s in EntryVsOb]
    )
    min_z_vwap = trial.suggest_categorical(
        "min_z_entry_vwap", [None, 1.0]
    )
    min_adx = trial.suggest_categorical(
        "min_adx_14", [None, 20.0, 30.0]
    )
    on_opp_str = trial.suggest_categorical(
        "on_opposite_signal", [s.value for s in OnOppositeSignal]
    )
    exit_after_bos = trial.suggest_categorical(
        "exit_after_n_bos", [None, 2, 3, 4]
    )

    return StrategyParams(
        entry_trigger=EntryTrigger(entry_str),
        exit_trigger=ExitTrigger(exit_str),
        stop_placement=StopPlacement(stop_str),
        stop_atr_multiple=stop_atr,
        target_atr_multiple=target_atr,
        session=SessionFilter(session_str),
        iv_tercile_filter=iv_filter,
        event_day_filter=event_filter,
        # v4
        session_bucket=SessionBucket(session_bucket_str),
        min_ob_volume_z=min_ob_vol_z,
        min_ob_pct_atr=min_ob_pct,
        entry_vs_ob=EntryVsOb(entry_vs_ob_str),
        min_z_entry_vwap=min_z_vwap,
        min_adx_14=min_adx,
        on_opposite_signal=OnOppositeSignal(on_opp_str),
        exit_after_n_bos=exit_after_bos,
    )


def _params_to_vector(params: StrategyParams) -> list[float]:
    """Convert StrategyParams to a numeric vector for effective-trial clustering.

    Categorical values are int-encoded. Floats carried as-is. Used by
    `metrics.estimate_effective_trials_by_correlation()` downstream.

    v4 (E1.4d) extends the vector by 9 dimensions to mirror the expanded
    search space.
    """
    entry_map = {t: i for i, t in enumerate(EntryTrigger)}
    exit_map = {t: i for i, t in enumerate(ExitTrigger)}
    stop_map = {s: i for i, s in enumerate(StopPlacement)}
    session_map = {s: i for i, s in enumerate(SessionFilter)}
    iv_map = {None: 0, "low": 1, "mid": 2, "high": 3}
    event_map = {None: 0, "skip_events": 1, "events_only": 2}
    session_bucket_map = {s: i for i, s in enumerate(SessionBucket)}
    entry_vs_ob_map = {s: i for i, s in enumerate(EntryVsOb)}
    on_opp_map = {s: i for i, s in enumerate(OnOppositeSignal)}

    # None values for thresholds map to 0; finite values pass through. The
    # categorical "is filter on?" signal is captured implicitly by 0 vs nonzero.
    def _opt_float(v: float | None) -> float:
        return 0.0 if v is None else float(v)

    return [
        float(entry_map[params.entry_trigger]),
        float(exit_map[params.exit_trigger]),
        float(stop_map[params.stop_placement]),
        float(params.stop_atr_multiple),
        float(params.target_atr_multiple),
        float(session_map[params.session]),
        float(iv_map[params.iv_tercile_filter]),
        float(event_map[params.event_day_filter]),
        # v4
        float(session_bucket_map[params.session_bucket]),
        _opt_float(params.min_ob_volume_z),
        _opt_float(params.min_ob_pct_atr),
        float(entry_vs_ob_map[params.entry_vs_ob]),
        _opt_float(params.min_z_entry_vwap),
        _opt_float(params.min_adx_14),
        float(on_opp_map[params.on_opposite_signal]),
        _opt_float(params.exit_after_n_bos),
    ]


# ─────────────────────────────────────────────────────────────────────────
# Fold execution
# ─────────────────────────────────────────────────────────────────────────


def _sharpe_or_minus_inf(trades: list, fallback: float = -10.0) -> float:
    """Return annualized Sharpe if computable, else a penalty value.

    Optuna can't handle NaN as an objective; we return a large-negative
    fallback for failed runs so the sampler deprioritizes those regions.
    """
    if not trades:
        return fallback
    m = compute_metrics(trades)
    if m.trade_count < 2 or m.sharpe_annualized == 0.0:
        return fallback
    return m.sharpe_annualized


def _run_one_fold(
    fold_index: int,
    bars: pd.DataFrame,
    train_idx: np.ndarray,
    test_idx: np.ndarray,
    n_trials: int,
    seed: int,
) -> FoldResult:
    """Run Optuna on the train window, then evaluate the winner on test."""
    sampler = optuna.samplers.TPESampler(seed=seed)
    study = optuna.create_study(direction="maximize", sampler=sampler)

    trial_sharpes: list[float] = []
    trial_params_vectors: list[list[float]] = []

    def objective(trial: optuna.Trial) -> float:
        params = _sample_params(trial)
        trades = run_backtest(bars, params, entry_eligible_indices=train_idx)
        sharpe = _sharpe_or_minus_inf(trades)
        trial_sharpes.append(sharpe)
        trial_params_vectors.append(_params_to_vector(params))
        return sharpe

    study.optimize(objective, n_trials=n_trials, show_progress_bar=False)

    # Re-instantiate best params and evaluate on OOS (test_idx)
    best_dict = study.best_params
    best_params = StrategyParams(
        entry_trigger=EntryTrigger(best_dict["entry_trigger"]),
        exit_trigger=ExitTrigger(best_dict["exit_trigger"]),
        stop_placement=StopPlacement(best_dict["stop_placement"]),
        stop_atr_multiple=best_dict["stop_atr_multiple"],
        target_atr_multiple=best_dict["target_atr_multiple"],
        session=SessionFilter(best_dict["session"]),
        iv_tercile_filter=best_dict["iv_tercile_filter"],
        event_day_filter=best_dict["event_day_filter"],
        # v4 dims — fall back to defaults if a v3 study is being re-evaluated
        session_bucket=SessionBucket(
            best_dict.get("session_bucket", SessionBucket.ANY.value)
        ),
        min_ob_volume_z=best_dict.get("min_ob_volume_z"),
        min_ob_pct_atr=best_dict.get("min_ob_pct_atr"),
        entry_vs_ob=EntryVsOb(
            best_dict.get("entry_vs_ob", EntryVsOb.ANY.value)
        ),
        min_z_entry_vwap=best_dict.get("min_z_entry_vwap"),
        min_adx_14=best_dict.get("min_adx_14"),
        on_opposite_signal=OnOppositeSignal(
            best_dict.get("on_opposite_signal", OnOppositeSignal.HOLD_AND_SKIP.value)
        ),
        exit_after_n_bos=best_dict.get("exit_after_n_bos"),
    )

    oos_trades = run_backtest(bars, best_params, entry_eligible_indices=test_idx)
    oos_metrics_obj = compute_metrics(oos_trades)

    return FoldResult(
        fold_index=fold_index,
        n_train_bars=len(train_idx),
        n_test_bars=len(test_idx),
        n_trials=n_trials,
        best_is_sharpe=float(study.best_value),
        best_params=best_dict,
        oos_metrics={
            "trade_count": oos_metrics_obj.trade_count,
            "win_rate": oos_metrics_obj.win_rate,
            "total_pnl_dollars": oos_metrics_obj.total_pnl_dollars,
            "sharpe_annualized": oos_metrics_obj.sharpe_annualized,
            "profit_factor": oos_metrics_obj.profit_factor,
            "max_drawdown_dollars": oos_metrics_obj.max_drawdown_dollars,
            "max_drawdown_pct": oos_metrics_obj.max_drawdown_pct,
            "expectancy_dollars": oos_metrics_obj.expectancy_dollars,
        },
        trial_sharpes=trial_sharpes,
        trial_params_vectors=trial_params_vectors,
    )


# ─────────────────────────────────────────────────────────────────────────
# Top-level sweep driver
# ─────────────────────────────────────────────────────────────────────────


def run_cpcv_sweep(
    bars: pd.DataFrame,
    cpcv_folds: list[tuple[np.ndarray, np.ndarray]],
    *,
    n_trials_per_fold: int = 150,
    joblib_n_jobs: int = -1,
    seed: int = 42,
) -> list[FoldResult]:
    """Run Optuna inside each CPCV fold, joblib-parallelized.

    Parameters
    ----------
    bars:
        PAC-enriched bar DataFrame (structure columns populated).
        Full-history bars — fold restriction happens via
        `entry_eligible_indices`.
    cpcv_folds:
        Output of `cpcv.cpcv_splits()` — list of (train_idx, test_idx).
    n_trials_per_fold:
        Optuna trials per fold. 150 is the `acceptance.yml` production
        default; tests pass 5-10 for speed.
    joblib_n_jobs:
        -1 = all CPU cores. Each fold runs in a separate process.
    seed:
        Base seed; each fold gets seed + fold_index for reproducibility
        while letting folds differ.

    Returns
    -------
    List of FoldResult, one per fold, in fold order.
    """
    if len(cpcv_folds) == 0:
        return []

    _LOG.info(
        "Running CPCV sweep: %d folds x %d trials, n_jobs=%d",
        len(cpcv_folds),
        n_trials_per_fold,
        joblib_n_jobs,
    )

    fold_jobs = [
        delayed(_run_one_fold)(
            fold_idx, bars, train_idx, test_idx, n_trials_per_fold, seed + fold_idx
        )
        for fold_idx, (train_idx, test_idx) in enumerate(cpcv_folds)
    ]
    results = Parallel(n_jobs=joblib_n_jobs, backend="loky", verbose=0)(fold_jobs)
    return list(results)


def build_config_scenario_matrix(
    fold_results: list[FoldResult],
) -> tuple[np.ndarray, list[tuple]]:
    """Build the (N_configs × S_scenarios) matrix PBO needs.

    Every unique best-params config across folds becomes a row; every
    fold is a column. Cell value = that config's OOS Sharpe when that
    fold used it as its winner. Folds where a config wasn't the winner
    get NaN (PBO treats these as scenarios that didn't test the config,
    equivalent to a non-observation).

    This is the "lite" version of PBO input — for the full CPCV matrix
    you'd need to evaluate EVERY config across EVERY fold's test window,
    which is too expensive for v1. The fold-winners-only matrix is
    sufficient for a first signal on whether the best configs transfer.

    Returns
    -------
    matrix : np.ndarray shape (n_unique_configs, n_folds)
    config_keys : list of dict keys (tuple of sorted params) identifying each row
    """
    # Hashable key per config (sorted tuple of best_params items)
    keys: list[tuple] = []
    key_to_row: dict[tuple, int] = {}
    for fr in fold_results:
        # Convert None values to string so tuples hash cleanly
        k = tuple(
            sorted(
                (name, ("__none__" if v is None else v))
                for name, v in fr.best_params.items()
            )
        )
        if k not in key_to_row:
            key_to_row[k] = len(keys)
            keys.append(k)

    n_configs = len(keys)
    n_folds = len(fold_results)
    matrix = np.full((n_configs, n_folds), np.nan, dtype=np.float64)

    for fr in fold_results:
        k = tuple(
            sorted(
                (name, ("__none__" if v is None else v))
                for name, v in fr.best_params.items()
            )
        )
        row = key_to_row[k]
        matrix[row, fr.fold_index] = fr.oos_metrics["sharpe_annualized"]

    return matrix, keys
