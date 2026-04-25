"""Train + evaluate the PAC event classifier — Phase 2.

Loads the per-year parquets produced by `build_pac_classifier_dataset.py`,
runs walk-forward cross-validation (no leakage), trains both labels:

    Model A : binary {target_hit=1, stop_hit=0} via XGBClassifier
    Model B : signed forward return regression via XGBRegressor

…and reports the gates we agreed on at scoping (see
`docs/superpowers/specs/pac-event-classifier-2026-04-24.md`):

    EDGE BAR :  Model A AUC > 0.55  AND  Expected R/trade > 0.10

Walk-forward windows (no future leakage, expanding train):

    W1: train=2022          test=2023
    W2: train=2022+2023     test=2024

For Model A, rows where `label_a` is NaN (timeout) are excluded from
training/eval — those events have no resolved binary outcome. We
report the timeout rate per window separately so the evaluation is
honest about coverage. The *Expected R/trade* metric, by contrast,
uses ALL test rows (including timeouts, whose `realized_R` is the
signed drift fraction at horizon) — because in production the
classifier predicts on every event regardless of how it would
eventually resolve.

Output: a single JSON at `--out` with both models' per-window metrics
+ the aggregated verdict (`pass` / `fail` per gate). Saved feature
importances are gain-based (xgboost default) so Phase 3 SHAP work
has a baseline to compare against.

Invocation:

    ml/.venv/bin/python ml/scripts/train_pac_classifier.py \\
        --data-dir ml/data/pac_classifier \\
        --timeframe 5m \\
        --symbol NQ \\
        --out ml/experiments/pac_classifier/run_5m_NQ.json
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score
from xgboost import XGBClassifier, XGBRegressor

_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT / "ml" / "src"))


# Categorical columns get ordinal-encoded so xgboost can use them as
# numeric splits without one-hot blow-up. Order matters only for
# reproducibility, not semantics — xgboost picks any threshold.
_CATEGORICAL_COLS = ("signal_type", "signal_direction", "session_bucket")

# Columns that are NOT features (labels, identifiers, etc).
_NON_FEATURE_COLS = (
    "bar_idx",
    "ts_event",
    "entry_price",
    "label_a",
    "exit_reason",
    "bars_to_exit",
    "realized_R",
    "forward_return_dollars",
)

# Edge bar gates from the original Phase 1 plan doc.
EDGE_AUC_THRESHOLD = 0.55
EDGE_EXPECTED_R_THRESHOLD = 0.10

# Probability cutoff for the "take the trade" gate when computing
# Expected R/trade. 0.5 is the natural decision boundary; we also
# emit a 0.55 sweep for stricter selection.
DEFAULT_PROB_THRESHOLDS = (0.5, 0.55, 0.6)


@dataclass
class WindowResult:
    """Per-walk-forward-window metrics."""

    name: str
    train_years: list[int]
    test_year: int
    n_train: int
    n_test: int
    n_train_resolved: int
    n_test_resolved: int
    timeout_rate_test: float

    # Model A — binary classification
    auc_a: float | None = None
    expected_r_at_threshold: dict[str, float] = field(default_factory=dict)
    take_rate_at_threshold: dict[str, float] = field(default_factory=dict)
    feature_importance_a: dict[str, float] = field(default_factory=dict)

    # Model B — regression
    r2_b: float | None = None
    spearman_b: float | None = None
    feature_importance_b: dict[str, float] = field(default_factory=dict)


@dataclass
class RunResult:
    """Top-level result blob written to `--out`."""

    schema_version: int
    timeframe: str
    symbol: str
    data_dir: str
    feature_columns: list[str]
    windows: list[WindowResult]
    verdict: dict[str, Any]


def _encode_categoricals(df: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, list[str]]]:
    """Ordinal-encode the few low-cardinality string columns. Returns
    the encoded dataframe plus the {col: categories[]} mapping so the
    encoding is reproducible across train + test sets."""
    encoded = df.copy()
    categories: dict[str, list[str]] = {}
    for col in _CATEGORICAL_COLS:
        if col not in encoded.columns:
            continue
        cats = sorted(encoded[col].dropna().unique().tolist())
        categories[col] = cats
        encoded[col] = encoded[col].map({c: i for i, c in enumerate(cats)}).astype("Int64")
    return encoded, categories


def _apply_categoricals(
    df: pd.DataFrame, categories: dict[str, list[str]]
) -> pd.DataFrame:
    """Apply a previously-fit categorical mapping. Unseen categories
    become NaN (xgboost handles natively)."""
    out = df.copy()
    for col, cats in categories.items():
        if col not in out.columns:
            continue
        mapping = {c: i for i, c in enumerate(cats)}
        out[col] = out[col].map(mapping).astype("Int64")
    return out


def _select_features(df: pd.DataFrame) -> list[str]:
    """Pick feature columns: everything except labels + identifiers."""
    return [c for c in df.columns if c not in _NON_FEATURE_COLS]


def _train_model_a(
    X_train: pd.DataFrame,
    y_train: pd.Series,
    seed: int,
) -> XGBClassifier:
    """Fit Model A — binary target/stop classifier. Modest depth + early
    stopping disabled (we don't have a separate val set inside the
    train fold yet — Phase 3 will introduce it). Class imbalance from
    the dataset's natural target/stop ratio is handled by
    `scale_pos_weight=1.0` (no rebalancing) — we want the natural
    base-rate to inform the prior."""
    model = XGBClassifier(
        n_estimators=300,
        max_depth=4,
        learning_rate=0.05,
        min_child_weight=5,
        subsample=0.8,
        colsample_bytree=0.8,
        random_state=seed,
        n_jobs=-1,
        eval_metric="auc",
        # `enable_categorical=False` — we ordinal-encode upstream.
    )
    model.fit(X_train, y_train)
    return model


def _train_model_b(
    X_train: pd.DataFrame,
    y_train: pd.Series,
    seed: int,
) -> XGBRegressor:
    """Fit Model B — signed forward-return regressor. Same hyperparameters
    as Model A; the regression target is the dollar-denominated forward
    return at horizon."""
    model = XGBRegressor(
        n_estimators=300,
        max_depth=4,
        learning_rate=0.05,
        min_child_weight=5,
        subsample=0.8,
        colsample_bytree=0.8,
        random_state=seed,
        n_jobs=-1,
        eval_metric="rmse",
    )
    model.fit(X_train, y_train)
    return model


def _expected_r_at_threshold(
    proba: np.ndarray,
    realized_r: np.ndarray,
    threshold: float,
) -> tuple[float, float]:
    """Mean realized_R over events the model would have taken (P >= threshold).
    Returns (expected_r, take_rate). NaN if no trades cleared."""
    take_mask = proba >= threshold
    n_take = int(take_mask.sum())
    n_total = len(proba)
    take_rate = n_take / n_total if n_total > 0 else 0.0
    if n_take == 0:
        return float("nan"), take_rate
    finite = np.isfinite(realized_r[take_mask])
    if not finite.any():
        return float("nan"), take_rate
    expected_r = float(np.mean(realized_r[take_mask][finite]))
    return expected_r, take_rate


def _spearman(x: np.ndarray, y: np.ndarray) -> float:
    """Spearman rank correlation. Returns NaN on degenerate input."""
    if len(x) < 2:
        return float("nan")
    rx = pd.Series(x).rank().to_numpy()
    ry = pd.Series(y).rank().to_numpy()
    if np.std(rx) == 0 or np.std(ry) == 0:
        return float("nan")
    return float(np.corrcoef(rx, ry)[0, 1])


def _r2(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    """R² without sklearn import (avoids extra dep churn). Standard
    1 - SS_res / SS_tot. NaN when SS_tot is 0."""
    ss_tot = float(np.sum((y_true - np.mean(y_true)) ** 2))
    if ss_tot == 0:
        return float("nan")
    ss_res = float(np.sum((y_true - y_pred) ** 2))
    return 1.0 - ss_res / ss_tot


def evaluate_window(
    name: str,
    train_df: pd.DataFrame,
    test_df: pd.DataFrame,
    *,
    seed: int = 42,
    prob_thresholds: tuple[float, ...] = DEFAULT_PROB_THRESHOLDS,
) -> WindowResult:
    """Train both models on `train_df`, evaluate on `test_df`. Both
    inputs already encoded (categoricals → int)."""
    feature_cols = _select_features(train_df)

    # Resolved subset for Model A (label_a not NaN)
    train_resolved = train_df[train_df["label_a"].notna()]
    test_resolved = test_df[test_df["label_a"].notna()]

    res = WindowResult(
        name=name,
        train_years=sorted(train_df["__year"].unique().tolist()),
        test_year=int(test_df["__year"].iloc[0]),
        n_train=len(train_df),
        n_test=len(test_df),
        n_train_resolved=len(train_resolved),
        n_test_resolved=len(test_resolved),
        timeout_rate_test=(
            float(test_df["label_a"].isna().mean()) if len(test_df) > 0 else float("nan")
        ),
    )

    # ----- Model A: binary classification -----
    if len(train_resolved) >= 50 and len(test_resolved) >= 20:
        Xa_tr = train_resolved[feature_cols]
        ya_tr = train_resolved["label_a"].astype(int)
        Xa_te = test_resolved[feature_cols]
        ya_te = test_resolved["label_a"].astype(int)

        model_a = _train_model_a(Xa_tr, ya_tr, seed)
        proba_te = model_a.predict_proba(Xa_te)[:, 1]
        try:
            res.auc_a = float(roc_auc_score(ya_te, proba_te))
        except ValueError:
            res.auc_a = None  # only one class in y_true

        # Expected R/trade computed across ALL test events (including
        # timeouts) — re-score full test set, including the rows we
        # excluded from AUC. This matches how a live model behaves.
        Xa_full = test_df[feature_cols]
        proba_full = model_a.predict_proba(Xa_full)[:, 1]
        realized_r_full = test_df["realized_R"].to_numpy(dtype=np.float64)
        for thr in prob_thresholds:
            er, tr = _expected_r_at_threshold(proba_full, realized_r_full, thr)
            res.expected_r_at_threshold[f"p{thr:.2f}"] = er
            res.take_rate_at_threshold[f"p{thr:.2f}"] = tr

        res.feature_importance_a = dict(
            sorted(
                {
                    feat: float(score)
                    for feat, score in zip(feature_cols, model_a.feature_importances_)
                }.items(),
                key=lambda kv: kv[1],
                reverse=True,
            )
        )

    # ----- Model B: regression -----
    if len(train_df) >= 50 and len(test_df) >= 20:
        Xb_tr = train_df[feature_cols]
        yb_tr = train_df["forward_return_dollars"].astype(float)
        Xb_te = test_df[feature_cols]
        yb_te = test_df["forward_return_dollars"].astype(float)

        # Drop rows where the regression target is NaN (horizon beyond frame)
        train_mask = yb_tr.notna()
        test_mask = yb_te.notna()
        if train_mask.sum() >= 50 and test_mask.sum() >= 20:
            model_b = _train_model_b(Xb_tr[train_mask], yb_tr[train_mask], seed)
            pred = model_b.predict(Xb_te[test_mask])
            y_true = yb_te[test_mask].to_numpy()
            res.r2_b = _r2(y_true, pred)
            res.spearman_b = _spearman(y_true, pred)
            res.feature_importance_b = dict(
                sorted(
                    {
                        feat: float(score)
                        for feat, score in zip(feature_cols, model_b.feature_importances_)
                    }.items(),
                    key=lambda kv: kv[1],
                    reverse=True,
                )
            )

    return res


def _verdict(windows: list[WindowResult]) -> dict[str, Any]:
    """Apply the edge-bar gates across windows. We require BOTH AUC and
    Expected R/trade to clear the bar in EVERY window for a `pass`. Any
    failure → `fail` with a per-window breakdown."""
    per_window: list[dict[str, Any]] = []
    all_pass = True
    for w in windows:
        # Use the natural 0.5 threshold for the gate evaluation; the
        # higher thresholds (0.55, 0.60) are diagnostic.
        er = w.expected_r_at_threshold.get("p0.50", float("nan"))
        auc_pass = (
            w.auc_a is not None and w.auc_a > EDGE_AUC_THRESHOLD
        )
        er_pass = np.isfinite(er) and er > EDGE_EXPECTED_R_THRESHOLD
        passed = auc_pass and er_pass
        if not passed:
            all_pass = False
        per_window.append(
            {
                "window": w.name,
                "auc_a": w.auc_a,
                "auc_pass": auc_pass,
                "expected_r_p0.50": er,
                "expected_r_pass": er_pass,
                "passed": passed,
            }
        )
    return {
        "edge_auc_threshold": EDGE_AUC_THRESHOLD,
        "edge_expected_r_threshold": EDGE_EXPECTED_R_THRESHOLD,
        "all_windows_pass": all_pass,
        "per_window": per_window,
    }


def run_walk_forward(
    df_by_year: dict[int, pd.DataFrame],
    *,
    seed: int = 42,
) -> tuple[list[WindowResult], list[str]]:
    """Run the 2-window walk-forward eval. Returns (windows, feature_cols).

    Windows:
        W1: train=2022,         test=2023
        W2: train=2022+2023,    test=2024
    """
    years = sorted(df_by_year.keys())
    if len(years) < 2:
        raise ValueError(f"need >=2 years, got {years}")

    # Tag each year for window-boundary tracking, fit categoricals
    # ONCE on the union (so unseen categories don't appear at test time).
    tagged: list[pd.DataFrame] = []
    for year in years:
        df = df_by_year[year].copy()
        df["__year"] = year
        tagged.append(df)
    full = pd.concat(tagged, ignore_index=True)
    encoded, categories = _encode_categoricals(full)

    encoded_by_year = {y: encoded[encoded["__year"] == y].reset_index(drop=True) for y in years}

    feature_cols = _select_features(
        encoded_by_year[years[0]].drop(columns=["__year"], errors="ignore")
    )

    windows: list[WindowResult] = []
    # Build expanding-train walk-forward
    for i in range(1, len(years)):
        train_years = years[:i]
        test_year = years[i]
        train_df = pd.concat(
            [encoded_by_year[y] for y in train_years], ignore_index=True
        )
        test_df = encoded_by_year[test_year]
        name = f"W{i}: train={','.join(map(str, train_years))} test={test_year}"
        print(f"[train] {name}: {len(train_df):,} train rows, {len(test_df):,} test rows", flush=True)
        win = evaluate_window(name, train_df, test_df, seed=seed)
        windows.append(win)

    # Note categories are stable across windows because we fit them on
    # the union once. Encoded_by_year carries the same column dtypes.
    _ = categories  # retained for interpretability — not currently surfaced
    return windows, feature_cols


def load_dataset_by_year(
    data_dir: Path,
    timeframe: str,
    symbol: str,
    years: list[int],
) -> dict[int, pd.DataFrame]:
    """Load each year's parquet from `<data_dir>/<timeframe>_<symbol>_<year>.parquet`.
    Skips missing years with a stderr warning rather than failing — partial
    runs (e.g. 2 of 3 years) should still produce a window 1 result."""
    out: dict[int, pd.DataFrame] = {}
    for year in years:
        path = data_dir / f"{timeframe}_{symbol}_{year}.parquet"
        if not path.exists():
            print(f"[train]   WARN: missing {path.name}, skipping year", file=sys.stderr)
            continue
        out[year] = pd.read_parquet(path)
        print(f"[train]   loaded {path.name}: {len(out[year]):,} events", flush=True)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Train + eval the PAC event classifier.")
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path("ml/data/pac_classifier"),
        help="Directory containing per-year parquets",
    )
    parser.add_argument("--timeframe", default="5m", choices=("1m", "5m"))
    parser.add_argument("--symbol", default="NQ")
    parser.add_argument(
        "--years",
        default="2022,2023,2024",
        help="Comma-separated years to load (default: 2022,2023,2024)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("ml/experiments/pac_classifier/run.json"),
        help="Path to write the result JSON",
    )
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    years = [int(y.strip()) for y in args.years.split(",") if y.strip()]
    df_by_year = load_dataset_by_year(args.data_dir, args.timeframe, args.symbol, years)
    if len(df_by_year) < 2:
        print(f"[train] ERROR: need >=2 years of data, got {sorted(df_by_year)}", file=sys.stderr)
        return 1

    windows, feature_cols = run_walk_forward(df_by_year, seed=args.seed)
    verdict = _verdict(windows)

    result = RunResult(
        schema_version=1,
        timeframe=args.timeframe,
        symbol=args.symbol,
        data_dir=str(args.data_dir),
        feature_columns=feature_cols,
        windows=windows,
        verdict=verdict,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(asdict(result), indent=2, default=str))
    print(f"[train] wrote {args.out}", flush=True)
    print(
        f"[train] verdict: {'PASS' if verdict['all_windows_pass'] else 'FAIL'} "
        f"(AUC > {EDGE_AUC_THRESHOLD} AND Expected R > {EDGE_EXPECTED_R_THRESHOLD})",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
