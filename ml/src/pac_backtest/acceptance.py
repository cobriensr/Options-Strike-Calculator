"""Loader + validator for `acceptance.yml`.

This keeps the YAML as the single source of truth for pre-commit
thresholds while letting downstream code work with a typed dataclass
rather than dict-of-dicts.

The sweep orchestrator will call `load_acceptance()` once at start and
pass the returned AcceptanceConfig through to the fold-level evaluator.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

_ACCEPTANCE_PATH = Path(__file__).resolve().parent / "acceptance.yml"


@dataclass(frozen=True)
class Thresholds:
    pbo_max: float
    dsr_min_95ci: float
    oos_vs_is_sharpe_min: float
    min_trades_per_fold: int
    max_drawdown_pct: float
    profit_factor_min: float
    param_stability_max_drop: float


@dataclass(frozen=True)
class SweepConfig:
    cpcv_n_groups: int
    cpcv_k_test_groups: int
    embargo_bars: int
    optuna_trials_per_fold: int
    optuna_sampler: str
    optuna_pruner: str
    joblib_n_jobs: int


@dataclass(frozen=True)
class FillModel:
    spread_cross: bool
    extra_slippage_ticks: float
    commission_per_rt: dict[str, float]


@dataclass(frozen=True)
class BootstrapConfig:
    method: str
    block_length_source: str
    n_resamples: int


@dataclass(frozen=True)
class AcceptanceConfig:
    version: int
    committed_ts: str
    commit_hash_when_locked: str | None
    markets: list[str]  # symbol list, apply_thresholds=True assumed
    require_pass_on_all_markets: bool
    thresholds: Thresholds
    effective_trial_method: str
    effective_trial_correlation_threshold: float
    sweep: SweepConfig
    fill_model: FillModel
    bootstrap: BootstrapConfig
    raw: dict = field(default_factory=dict)  # original dict for audit


def load_acceptance(path: Path | None = None) -> AcceptanceConfig:
    """Read acceptance.yml and return a typed config.

    Raises ValueError if the YAML is missing required sections or has
    out-of-range values. The strictness is intentional — this file is
    the overfitting-defense contract; a malformed version is worse than
    a missing one.
    """
    p = path or _ACCEPTANCE_PATH
    if not p.exists():
        raise FileNotFoundError(f"acceptance.yml not found at {p}")

    with p.open() as f:
        raw = yaml.safe_load(f)

    required_top = {
        "version",
        "committed_ts",
        "markets",
        "cross_market_gate",
        "thresholds",
        "effective_trial_estimation",
        "sweep",
        "fill_model",
        "bootstrap",
    }
    missing = required_top - set(raw.keys())
    if missing:
        raise ValueError(f"acceptance.yml missing required keys: {sorted(missing)}")

    t = raw["thresholds"]
    thresholds = Thresholds(
        pbo_max=float(t["pbo_max"]),
        dsr_min_95ci=float(t["dsr_min_95ci"]),
        oos_vs_is_sharpe_min=float(t["oos_vs_is_sharpe_min"]),
        min_trades_per_fold=int(t["min_trades_per_fold"]),
        max_drawdown_pct=float(t["max_drawdown_pct"]),
        profit_factor_min=float(t["profit_factor_min"]),
        param_stability_max_drop=float(t["param_stability_max_drop"]),
    )

    # Range sanity checks — catch typos that would silently pass bad configs
    if not 0 <= thresholds.pbo_max <= 1:
        raise ValueError(f"pbo_max must be in [0, 1], got {thresholds.pbo_max}")
    if not 0 < thresholds.max_drawdown_pct <= 1:
        raise ValueError(
            f"max_drawdown_pct must be in (0, 1], got {thresholds.max_drawdown_pct}"
        )
    if thresholds.min_trades_per_fold < 1:
        raise ValueError(
            f"min_trades_per_fold must be >= 1, got {thresholds.min_trades_per_fold}"
        )
    if thresholds.profit_factor_min <= 0:
        raise ValueError(
            f"profit_factor_min must be > 0, got {thresholds.profit_factor_min}"
        )

    sweep = SweepConfig(
        cpcv_n_groups=int(raw["sweep"]["cpcv_n_groups"]),
        cpcv_k_test_groups=int(raw["sweep"]["cpcv_k_test_groups"]),
        embargo_bars=int(raw["sweep"]["embargo_bars"]),
        optuna_trials_per_fold=int(raw["sweep"]["optuna_trials_per_fold"]),
        optuna_sampler=str(raw["sweep"]["optuna_sampler"]),
        optuna_pruner=str(raw["sweep"]["optuna_pruner"]),
        joblib_n_jobs=int(raw["sweep"]["joblib_n_jobs"]),
    )

    fill_model = FillModel(
        spread_cross=bool(raw["fill_model"]["spread_cross"]),
        extra_slippage_ticks=float(raw["fill_model"]["extra_slippage_ticks"]),
        commission_per_rt=dict(raw["fill_model"]["commission_per_rt"]),
    )

    bootstrap_cfg = BootstrapConfig(
        method=str(raw["bootstrap"]["method"]),
        block_length_source=str(raw["bootstrap"]["block_length_source"]),
        n_resamples=int(raw["bootstrap"]["n_resamples"]),
    )

    markets = [m["symbol"] for m in raw["markets"] if m.get("apply_thresholds")]

    return AcceptanceConfig(
        version=int(raw["version"]),
        committed_ts=str(raw["committed_ts"]),
        commit_hash_when_locked=raw.get("commit_hash_when_locked"),
        markets=markets,
        require_pass_on_all_markets=bool(
            raw["cross_market_gate"]["require_pass_on_all_markets"]
        ),
        thresholds=thresholds,
        effective_trial_method=str(
            raw["effective_trial_estimation"]["method"]
        ),
        effective_trial_correlation_threshold=float(
            raw["effective_trial_estimation"]["correlation_threshold"]
        ),
        sweep=sweep,
        fill_model=fill_model,
        bootstrap=bootstrap_cfg,
        raw=raw,
    )
