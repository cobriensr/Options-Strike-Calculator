"""Phase 2 — train per-alert calibrated XGBoost classifiers.

Spec: docs/superpowers/specs/alert-takeit-score-2026-05-16.md

For each alert type:
1. Load the Phase 1 training parquet (already PIT-correct).
2. Prepare features: drop identifiers, one-hot top-15 tickers + OTHER bucket,
   one-hot remaining categorical columns.
3. Walk-forward CV (5 time-ordered folds) → honest OOF AUC + Brier.
4. Final model = XGBoost trained on the first 80% of time-sorted data;
   isotonic regression calibrator fit on the last 20%.
5. Compare OOF AUC to the existing heuristic `score` column's OOF AUC.
6. Emit reliability curve, ROC curve, feature-importance plot, and metrics JSON
   to ml/findings/takeit-v1-{today}/.

CLI:
    ml/.venv/bin/python -m ml.src.takeit.train [--alert-type lottery|silentboom|both]
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from datetime import date as date_type
from pathlib import Path
from typing import Final, Literal

import joblib
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import xgboost as xgb

from .build_training_set import (
    INFERRED_STRUCTURE_LABELS,
    SESSION_PHASES,
)
from .config import (
    BRIER_ALERT_THRESHOLD,
    ISOTONIC_HOLDOUT_FRAC,
    TOP_N_TICKERS,
    WALK_FORWARD_FOLDS,
    WIN_LABEL_THRESHOLD_PCT,
    XGB_PARAMS,
)

# Categorical category-pinning map. Before `get_dummies` we coerce each
# column to `pd.Categorical(..., categories=...)` so an absent label still
# emits its one-hot column. Without this, a training set where (say)
# `inferred_structure='butterfly'` never appears would silently drop
# `inferred_structure_butterfly` from `feature_cols`; the TS scorer
# (which always emits all 5 labels per INFERRED_STRUCTURE_LABELS) would
# then set an un-pinned key the model ignores. Pinning keeps the
# feature contract stable across retrains.
_PINNED_CATEGORIES: Final = {
    "inferred_structure": INFERRED_STRUCTURE_LABELS,
    "session_phase_cat": SESSION_PHASES,
}
from sklearn.calibration import calibration_curve
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import brier_score_loss, roc_auc_score, roc_curve
from sklearn.model_selection import TimeSeriesSplit

AlertType = Literal["lottery", "silentboom"]

DATA_DIR: Final = Path("ml/data/takeit")

# Columns that must not become features (they are identifiers, target, or
# raw values that don't generalize across underlyings).
NON_FEATURE_COLS: Final = {
    "id",
    "date",
    "fire_time",
    "option_chain_id",
    "underlying_symbol",
    "alert_type",
    "expiry",
    "peak_ceiling_pct",
    "win",
    "strike",
    "gex_strike_actual_strike",
    # Phase 4 (meta-detectors) — wave2 columns are POST-FIRE labels.
    # `wave2_status` is determined by a follow-up event 0-60 min AFTER
    # the alert; including it as a feature would leak the future. It's
    # available for a separate meta-classifier (per spec). The detected_at
    # timestamp and the pattern_group_id (hash, not a feature) join the
    # exclude list for the same reason.
    "wave2_status",
    "wave2_detected_at",
    "pattern_group_id",
    # GexBot context (migrations #180 / #181). `gex_captured_at` is a
    # TIMESTAMPTZ and would crash X.astype(float). `gex_zero_gamma` and
    # `gex_spot` are absolute prices that don't generalize across the
    # 16-ticker GexBot universe (SPX~6000, SPY~600, VIX~20) — same reason
    # `gex_strike_actual_strike` is excluded above. The downstream
    # featurizer should derive the normalized signal (e.g.
    # `(gex_zero_gamma - gex_spot) / gex_spot`) when that work lands.
    "gex_captured_at",
    "gex_zero_gamma",
    "gex_spot",
}

CATEGORICAL_COLS: Final = {
    # Phase 2 (multileg): `inferred_structure` is one of
    # {isolated_leg, vertical, strangle, risk_reversal, butterfly} — see
    # api/_lib/takeit-features.ts INFERRED_STRUCTURE_LABELS.
    # Phase 3 (time-of-day): `session_phase_cat` is the 7-bucket categorical
    # label (pre_open, open, opening_30, morning, lunch, afternoon, closing).
    # Both NULL-safe via pd.get_dummies(dummy_na=False) → NULL rows produce
    # an all-zero one-hot block, which XGBoost handles via NaN-default routing.
    "lottery": [
        "option_type",
        "mode",
        "flow_quad",
        "tod",
        "inferred_structure",
        "session_phase_cat",
    ],
    "silentboom": [
        "option_type",
        "score_tier",
        "inferred_structure",
        "session_phase_cat",
    ],
}

MIN_LABELED_SAMPLES: Final = 500  # SilentBoom gate (spec resolved decision #2)


@dataclass(frozen=True)
class FoldMetrics:
    fold: int
    n_train: int
    n_test: int
    auc: float
    brier: float


@dataclass(frozen=True)
class TrainSummary:
    alert_type: AlertType
    n_total: int
    n_oof: int
    oof_auc: float
    oof_auc_no_score: float
    """OOF AUC of a model trained WITHOUT the heuristic `score` feature.
    This is the apples-to-apples comparison: model-features-only vs heuristic."""
    oof_brier: float
    heuristic_oof_auc: float
    lift_vs_heuristic_with_score: float
    """oof_auc minus heuristic_oof_auc — inflated because the model also sees
    the heuristic score as a feature. Useful as the headline production lift."""
    honest_lift: float
    """oof_auc_no_score minus heuristic_oof_auc — marginal value of the new
    Phase 1 features above what the existing heuristic already provides."""
    cal_auc: float
    cal_brier: float
    fold_metrics: list[FoldMetrics]
    feature_count: int
    trained_on_date: str
    brier_ok: bool
    """True iff oof_brier < BRIER_ALERT_THRESHOLD (spec gate, drives the weekly
    Sentry monitor in Phase 5)."""


# ── Feature preparation ──────────────────────────────────────────────────────


def select_top_tickers(df: pd.DataFrame, top_n: int = TOP_N_TICKERS) -> list[str]:
    return df["underlying_symbol"].value_counts().head(top_n).index.tolist()


def prepare_features(
    df: pd.DataFrame,
    alert_type: AlertType,
    top_tickers: list[str] | None = None,
) -> tuple[pd.DataFrame, np.ndarray, list[str], list[str]]:
    """Build the feature matrix.

    Returns (X, y, feature_cols, top_tickers).
    `top_tickers` is recorded so prediction can use the same bucketing.
    """
    if top_tickers is None:
        top_tickers = select_top_tickers(df)

    out = df.copy()
    out["ticker_bucket"] = out["underlying_symbol"].where(
        out["underlying_symbol"].isin(top_tickers), other="OTHER"
    )

    cat_cols = [c for c in CATEGORICAL_COLS[alert_type] if c in out.columns]
    cat_cols.append("ticker_bucket")
    # Pin categories for the columns we own the label set for; this makes
    # `get_dummies` emit the full one-hot block even when a label is absent
    # in the training data, so feature_cols stays stable across retrains.
    for col, categories in _PINNED_CATEGORIES.items():
        if col in out.columns:
            out[col] = pd.Categorical(out[col], categories=list(categories))
    out = pd.get_dummies(out, columns=cat_cols, drop_first=False, dummy_na=False)

    feature_cols = [c for c in out.columns if c not in NON_FEATURE_COLS]

    X = out[feature_cols].copy()
    # XGBoost requires numeric input; cast bool / nullable Int to float and let NaN propagate.
    nullable_int_dtypes = {"Int8", "Int16", "Int32", "Int64"}
    for c in X.columns:
        if X[c].dtype == bool or str(X[c].dtype) in nullable_int_dtypes:
            X[c] = X[c].astype(float)
    X = X.astype(float)

    y = df["win"].astype(int).to_numpy()
    return X, y, feature_cols, top_tickers


# ── Walk-forward CV ──────────────────────────────────────────────────────────


def walk_forward_cv(
    X: pd.DataFrame, y: np.ndarray, n_splits: int = WALK_FORWARD_FOLDS
) -> tuple[np.ndarray, np.ndarray, list[FoldMetrics]]:
    """Time-ordered K-fold (assumes X and y are sorted by fire_time).

    Returns (oof_preds, oof_mask, fold_metrics). oof_preds is 0 where oof_mask
    is False (rows in the very first training-only fold are never scored OOF).
    """
    tscv = TimeSeriesSplit(n_splits=n_splits)
    oof_preds = np.zeros(len(y), dtype=float)
    oof_mask = np.zeros(len(y), dtype=bool)
    fold_metrics: list[FoldMetrics] = []

    for fold_idx, (train_idx, test_idx) in enumerate(tscv.split(X)):
        model = xgb.XGBClassifier(**XGB_PARAMS)
        model.fit(X.iloc[train_idx], y[train_idx])
        preds = model.predict_proba(X.iloc[test_idx])[:, 1]
        oof_preds[test_idx] = preds
        oof_mask[test_idx] = True
        fold_metrics.append(
            FoldMetrics(
                fold=fold_idx,
                n_train=len(train_idx),
                n_test=len(test_idx),
                auc=float(roc_auc_score(y[test_idx], preds)),
                brier=float(brier_score_loss(y[test_idx], preds)),
            )
        )
    return oof_preds, oof_mask, fold_metrics


# ── Final model + calibration ────────────────────────────────────────────────


def train_final_with_calibration(
    X: pd.DataFrame, y: np.ndarray, holdout_frac: float = ISOTONIC_HOLDOUT_FRAC
) -> tuple[xgb.XGBClassifier, IsotonicRegression, dict[str, float]]:
    n = len(y)
    cut = int(n * (1 - holdout_frac))
    X_train, y_train = X.iloc[:cut], y[:cut]
    X_cal, y_cal = X.iloc[cut:], y[cut:]

    model = xgb.XGBClassifier(**XGB_PARAMS)
    model.fit(X_train, y_train)

    raw = model.predict_proba(X_cal)[:, 1]
    iso = IsotonicRegression(out_of_bounds="clip")
    iso.fit(raw, y_cal)
    cal = iso.transform(raw)

    return model, iso, {
        "n_train": cut,
        "n_cal": n - cut,
        "raw_auc": float(roc_auc_score(y_cal, raw)),
        "cal_auc": float(roc_auc_score(y_cal, cal)),
        "cal_brier": float(brier_score_loss(y_cal, cal)),
        "raw_brier": float(brier_score_loss(y_cal, raw)),
    }


# ── Plotting ─────────────────────────────────────────────────────────────────


def plot_reliability(y_true: np.ndarray, y_prob: np.ndarray, out_path: Path, title: str) -> None:
    frac_pos, mean_pred = calibration_curve(y_true, y_prob, n_bins=10, strategy="quantile")
    fig, ax = plt.subplots(figsize=(6, 6))
    ax.plot([0, 1], [0, 1], "k--", linewidth=1, label="perfect")
    ax.plot(mean_pred, frac_pos, "o-", color="#4477aa", label="model")
    ax.set_xlabel("mean predicted probability")
    ax.set_ylabel("fraction positive")
    ax.set_title(title)
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.legend(loc="upper left")
    ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


def plot_roc(y_true: np.ndarray, y_prob: np.ndarray, out_path: Path, title: str) -> None:
    fpr, tpr, _ = roc_curve(y_true, y_prob)
    auc = roc_auc_score(y_true, y_prob)
    fig, ax = plt.subplots(figsize=(6, 6))
    ax.plot(fpr, tpr, color="#4477aa", label=f"AUC={auc:.3f}")
    ax.plot([0, 1], [0, 1], "k--", linewidth=1)
    ax.set_xlabel("FPR")
    ax.set_ylabel("TPR")
    ax.set_title(title)
    ax.legend(loc="lower right")
    ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


def plot_feature_importance(
    model: xgb.XGBClassifier, feature_names: list[str], out_path: Path, top_k: int = 25
) -> None:
    importances = model.feature_importances_
    order = np.argsort(importances)[-top_k:]
    fig, ax = plt.subplots(figsize=(8, 0.4 * top_k + 1.5))
    ax.barh(np.array(feature_names)[order], importances[order], color="#5577cc")
    ax.set_xlabel("gain importance")
    ax.set_title(f"Top {top_k} features by XGBoost gain")
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


# ── Main per-alert pipeline ──────────────────────────────────────────────────


def train_one_alert_type(
    alert_type: AlertType,
    data_dir: Path,
    out_dir: Path,
    findings_dir: Path,
) -> TrainSummary | None:
    parquet_path = data_dir / f"{alert_type}_training.parquet"
    df = pd.read_parquet(parquet_path).sort_values("fire_time").reset_index(drop=True)

    if len(df) < MIN_LABELED_SAMPLES:
        print(
            f"[takeit-train] SKIP {alert_type}: only {len(df)} labeled rows "
            f"(< MIN_LABELED_SAMPLES={MIN_LABELED_SAMPLES})"
        )
        return None

    X, y, feature_cols, top_tickers = prepare_features(df, alert_type)
    print(f"[takeit-train] {alert_type}: shape={X.shape}, win_rate={y.mean():.3f}, features={len(feature_cols)}")

    # Walk-forward CV for honest OOF metrics on the full feature set (including
    # the existing heuristic `score` column).
    oof_preds, oof_mask, fold_metrics = walk_forward_cv(X, y)
    oof_auc = float(roc_auc_score(y[oof_mask], oof_preds[oof_mask]))
    oof_brier = float(brier_score_loss(y[oof_mask], oof_preds[oof_mask]))

    # Heuristic baseline AUC on the same OOF rows.
    heuristic_oof_auc = float(roc_auc_score(y[oof_mask], df.loc[oof_mask, "score"]))

    # Walk-forward CV WITHOUT the `score` column — honest comparison of new
    # Phase 1 features vs the existing heuristic. If `oof_auc_no_score` matches
    # `heuristic_oof_auc` closely, the new features add nothing on their own.
    if "score" in X.columns:
        X_no_score = X.drop(columns=["score"])
        oof_preds_no_score, oof_mask_no_score, _ = walk_forward_cv(X_no_score, y)
        oof_auc_no_score = float(
            roc_auc_score(y[oof_mask_no_score], oof_preds_no_score[oof_mask_no_score])
        )
    else:
        oof_auc_no_score = oof_auc

    # Final calibrated model.
    final_model, calibrator, cal_info = train_final_with_calibration(X, y)

    # Persist model bundle.
    bundle = {
        "model": final_model,
        "calibrator": calibrator,
        "feature_cols": feature_cols,
        "top_tickers": top_tickers,
        "categorical_cols": CATEGORICAL_COLS[alert_type],
        "alert_type": alert_type,
        "trained_on_date": date_type.today().isoformat(),
        "win_label_threshold_pct": WIN_LABEL_THRESHOLD_PCT,
        "xgb_params": XGB_PARAMS,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, out_dir / f"{alert_type}_classifier.joblib")

    # Plots from OOF predictions.
    plot_reliability(
        y[oof_mask], oof_preds[oof_mask],
        findings_dir / f"{alert_type}_reliability_oof.png",
        f"{alert_type} OOF reliability (n={int(oof_mask.sum()):,})",
    )
    plot_roc(
        y[oof_mask], oof_preds[oof_mask],
        findings_dir / f"{alert_type}_roc_oof.png",
        f"{alert_type} OOF ROC",
    )
    plot_feature_importance(
        final_model, feature_cols, findings_dir / f"{alert_type}_feature_importance.png"
    )

    summary = TrainSummary(
        alert_type=alert_type,
        n_total=len(df),
        n_oof=int(oof_mask.sum()),
        oof_auc=oof_auc,
        oof_auc_no_score=oof_auc_no_score,
        oof_brier=oof_brier,
        heuristic_oof_auc=heuristic_oof_auc,
        lift_vs_heuristic_with_score=oof_auc - heuristic_oof_auc,
        honest_lift=oof_auc_no_score - heuristic_oof_auc,
        cal_auc=cal_info["cal_auc"],
        cal_brier=cal_info["cal_brier"],
        fold_metrics=fold_metrics,
        feature_count=len(feature_cols),
        trained_on_date=date_type.today().isoformat(),
        brier_ok=oof_brier < BRIER_ALERT_THRESHOLD,
    )

    # Phase 3a: also emit the JSON bundle the TS scorer + Vercel Blob need.
    # Lives next to the joblib; upload_to_blob.py (Phase 3e) pushes it.
    from .export_model import export_bundle  # lazy: avoid circular import

    json_path = out_dir / f"{alert_type}_classifier.json"
    export_bundle(
        bundle,
        metrics={
            k: v for k, v in asdict(summary).items() if k != "fold_metrics"
        },
        out_path=json_path,
    )

    # Persist metrics JSON.
    with open(findings_dir / f"{alert_type}_metrics.json", "w") as f:
        json.dump(
            {
                **{k: v for k, v in asdict(summary).items() if k != "fold_metrics"},
                "fold_metrics": [asdict(fm) for fm in fold_metrics],
                "cal_info": cal_info,
            },
            f,
            indent=2,
        )

    brier_flag = "ok" if summary.brier_ok else f"OVER {BRIER_ALERT_THRESHOLD}"
    print(
        f"[takeit-train] {alert_type}: oof_auc={oof_auc:.4f} "
        f"(no_score={oof_auc_no_score:.4f}) "
        f"heuristic={heuristic_oof_auc:.4f} "
        f"honest_lift={oof_auc_no_score - heuristic_oof_auc:+.4f} "
        f"oof_brier={oof_brier:.4f} [{brier_flag}]"
    )
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--alert-type",
        choices=["lottery", "silentboom", "both"],
        default="both",
        help="Which alert type to train (default: both).",
    )
    parser.add_argument(
        "--data-dir", type=Path, default=DATA_DIR,
        help="Directory containing Phase 1 training parquets.",
    )
    parser.add_argument(
        "--out-dir", type=Path, default=DATA_DIR,
        help="Directory for the trained model bundles.",
    )
    parser.add_argument(
        "--findings-dir", type=Path, default=None,
        help="Directory for plots + metrics JSON (default: ml/findings/takeit-v1-{today}).",
    )
    args = parser.parse_args()

    if args.findings_dir is None:
        args.findings_dir = Path(f"ml/findings/takeit-v1-{date_type.today().isoformat()}")
    args.findings_dir.mkdir(parents=True, exist_ok=True)

    alert_types: list[AlertType]
    if args.alert_type == "both":
        alert_types = ["lottery", "silentboom"]
    else:
        alert_types = [args.alert_type]  # type: ignore[list-item]

    summaries: dict[str, dict] = {}
    for at in alert_types:
        s = train_one_alert_type(at, args.data_dir, args.out_dir, args.findings_dir)
        if s is not None:
            summaries[at] = {
                **{k: v for k, v in asdict(s).items() if k != "fold_metrics"},
                "fold_metrics": [asdict(fm) for fm in s.fold_metrics],
            }

    with open(args.findings_dir / "summary.json", "w") as f:
        json.dump(summaries, f, indent=2)
    print(f"[takeit-train] done. artifacts in {args.findings_dir}/ and {args.out_dir}/")


if __name__ == "__main__":
    main()
