"""
Phase 2 Early: Structure Classification Feasibility

Walk-forward XGBoost experiment to see if T1-T2 features can predict
the recommended structure (CCS / PCS / IC) better than majority class.

Usage:
    python3 ml/phase2_early.py
    python3 ml/phase2_early.py --shap    # Also generate SHAP plots

Requires: pip install psycopg2-binary pandas scikit-learn xgboost
Optional: pip install shap (for SHAP feature importance plots)
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import numpy as np
    import pandas as pd
    from sklearn.metrics import (
        accuracy_score,
        f1_score,
        log_loss,
    )
except ImportError:
    print("Missing dependencies. Run:")
    print("  ml/.venv/bin/pip install psycopg2-binary pandas scikit-learn xgboost")
    sys.exit(1)

try:
    from xgboost import XGBClassifier
except ImportError:
    print("Missing xgboost. Run:")
    print("  ml/.venv/bin/pip install xgboost")
    sys.exit(1)

from utils import (
    load_data,
    validate_dataframe,
    section,
    subsection,
    verdict,
    takeaway,
)


# ── Feature Groups ───────────────────────────────────────────

VOLATILITY_FEATURES = [
    "vix", "vix1d", "vix1d_vix_ratio", "vix_vix9d_ratio",
]

GEX_FEATURES = [
    "gex_oi_t1", "gex_oi_t2",
    "gex_vol_t1", "gex_vol_t2",
    "gex_dir_t1", "gex_dir_t2",
]

FLOW_FEATURES_T1T2 = [
    "mt_ncp_t1", "mt_npp_t1",
    "spx_ncp_t1", "spy_ncp_t1", "qqq_ncp_t1",
    "spy_etf_ncp_t1", "qqq_etf_ncp_t1",
    "zero_dte_ncp_t1",
    "delta_flow_total_t1", "delta_flow_dir_t1",
    # T2 variants
    "mt_ncp_t2", "mt_npp_t2",
    "spx_ncp_t2", "spy_ncp_t2", "qqq_ncp_t2",
    "spy_etf_ncp_t2", "qqq_etf_ncp_t2",
    "zero_dte_ncp_t2",
    "delta_flow_total_t2", "delta_flow_dir_t2",
]

FLOW_AGGREGATE = [
    "flow_agreement_t1", "flow_agreement_t2",
    "etf_tide_divergence_t1",
    "ncp_npp_gap_spx_t1",
]

GREEK_FEATURES = [
    "agg_net_gamma", "dte0_net_charm", "dte0_charm_pct",
    "charm_slope",
]

PER_STRIKE_FEATURES = [
    "gamma_wall_above_dist", "gamma_wall_below_dist",
    "neg_gamma_nearest_dist", "gamma_asymmetry",
    "charm_max_pos_dist", "charm_max_neg_dist",
]

CALCULATOR_FEATURES = [
    "ic_ceiling", "put_spread_ceiling", "call_spread_ceiling",
    "sigma",
]

CALENDAR_FEATURES = [
    "day_of_week", "is_friday", "is_event_day",
]

PHASE2_FEATURES = [
    "prev_day_range_pts", "prev_day_vix_change",
    "realized_vol_5d", "realized_vol_10d",
    "rv_iv_ratio", "vix_term_slope", "vvix_percentile",
    "is_fomc", "is_opex", "days_to_next_event",
]

# Categorical features that need one-hot encoding
CATEGORICAL_FEATURES = [
    "charm_pattern",
    "regime_zone",
    "prev_day_direction",
    "prev_day_range_cat",
]

ALL_NUMERIC_FEATURES = (
    VOLATILITY_FEATURES + GEX_FEATURES + FLOW_FEATURES_T1T2 +
    FLOW_AGGREGATE + GREEK_FEATURES + PER_STRIKE_FEATURES +
    CALCULATOR_FEATURES + CALENDAR_FEATURES + PHASE2_FEATURES
)

# Structure label mapping
STRUCTURE_MAP = {
    "CALL CREDIT SPREAD": 0,
    "PUT CREDIT SPREAD": 1,
    "IRON CONDOR": 2,
}

STRUCTURE_NAMES = {v: k for k, v in STRUCTURE_MAP.items()}


# ── Data Loading ─────────────────────────────────────────────

def load_phase2_data() -> pd.DataFrame:
    """Load training features + outcomes + labels from Neon."""
    return load_data("""
        SELECT f.*, o.settlement, o.day_open, o.day_high, o.day_low,
               o.day_range_pts, o.day_range_pct, o.close_vs_open,
               o.vix_close, o.vix1d_close,
               l.recommended_structure, l.structure_correct,
               l.confidence AS label_confidence,
               l.range_category, l.settlement_direction
        FROM training_features f
        LEFT JOIN outcomes o ON o.date = f.date
        LEFT JOIN day_labels l ON l.date = f.date
        ORDER BY f.date ASC
    """)


# ── Feature Preparation ─────────────────────────────────────

def prepare_features(df: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    """
    Build the feature matrix from available columns.

    Returns (X_df, feature_names) where X_df has NaN for missing values
    (XGBoost handles these natively).
    """
    # Numeric features
    available = [f for f in ALL_NUMERIC_FEATURES if f in df.columns]
    missing_numeric = [f for f in ALL_NUMERIC_FEATURES if f not in df.columns]
    if missing_numeric:
        print(f"  Note: {len(missing_numeric)} numeric features not in data, skipping")

    X = df[available].copy().astype(float)

    # One-hot encode categorical columns
    for cat_col in CATEGORICAL_FEATURES:
        if cat_col in df.columns:
            prefix = (cat_col
                      .replace("_pattern", "")
                      .replace("_zone", "")
                      .replace("prev_day_", "prev_"))
            dummies = pd.get_dummies(df[cat_col], prefix=prefix)
            X = pd.concat([X, dummies], axis=1)

    feature_names = X.columns.tolist()
    return X, feature_names


def encode_target(df: pd.DataFrame) -> pd.Series:
    """Map recommended_structure strings to integer labels."""
    return df["recommended_structure"].map(STRUCTURE_MAP)


# ── Walk-Forward Validation ──────────────────────────────────

def walk_forward(
    X: pd.DataFrame,
    y: pd.Series,
    params: dict,
    min_train: int = 20,
) -> dict:
    """
    Expanding-window walk-forward validation.

    Train on days 1..i, predict day i+1.
    Returns dict with predictions, probabilities, and indices.
    """
    n = len(X)
    n_classes = y.nunique()

    preds = []
    probs = []
    actuals = []
    indices = []

    for i in range(min_train, n):
        X_train = X.iloc[:i]
        y_train = y.iloc[:i]
        X_test = X.iloc[[i]]
        y_test = y.iloc[i]

        model = XGBClassifier(
            num_class=n_classes,
            **params,
        )
        model.fit(X_train, y_train, verbose=False)

        pred = model.predict(X_test)[0]
        prob = model.predict_proba(X_test)[0]

        preds.append(pred)
        probs.append(prob)
        actuals.append(y_test)
        indices.append(X.index[i])

    return {
        "predictions": np.array(preds),
        "probabilities": np.array(probs),
        "actuals": np.array(actuals),
        "indices": indices,
        "n_folds": len(preds),
    }


# ── Metrics ──────────────────────────────────────────────────

def compute_metrics(
    results: dict,
    y_full: pd.Series,
) -> dict:
    """Compute accuracy, log loss, F1, and baselines."""
    preds = results["predictions"]
    probs = results["probabilities"]
    actuals = results["actuals"]
    n_classes = probs.shape[1]

    # Walk-forward accuracy
    acc = accuracy_score(actuals, preds)

    # Log loss
    try:
        ll = log_loss(actuals, probs, labels=list(range(n_classes)))
    except ValueError:
        ll = float("nan")

    # Per-class F1
    f1_per_class = f1_score(actuals, preds, average=None,
                            labels=list(range(n_classes)),
                            zero_division=0)
    f1_dict = {}
    for cls_id in range(n_classes):
        name = STRUCTURE_NAMES.get(cls_id, str(cls_id))
        f1_dict[name] = round(float(f1_per_class[cls_id]), 3)

    # Majority class baseline
    majority_class = int(y_full.mode().iloc[0])
    majority_name = STRUCTURE_NAMES.get(majority_class, str(majority_class))
    majority_acc = (actuals == majority_class).mean()

    # Previous day baseline (predict yesterday's structure)
    prev_day_preds = np.roll(actuals, 1)
    # First prediction has no "yesterday", use majority
    prev_day_preds[0] = majority_class
    prev_day_acc = accuracy_score(actuals, prev_day_preds)

    return {
        "accuracy": round(float(acc), 4),
        "log_loss": round(float(ll), 4),
        "per_class_f1": f1_dict,
        "majority_class": majority_name,
        "majority_baseline": round(float(majority_acc), 4),
        "prev_day_baseline": round(float(prev_day_acc), 4),
        "walk_forward_folds": results["n_folds"],
    }


# ── Feature Importance ───────────────────────────────────────

def train_final_model(
    X: pd.DataFrame,
    y: pd.Series,
    params: dict,
) -> tuple:
    """Train on all data and return model + feature importances."""
    n_classes = y.nunique()

    model = XGBClassifier(
        num_class=n_classes,
        **params,
    )
    model.fit(X, y, verbose=False)

    importances = pd.Series(
        model.feature_importances_,
        index=X.columns,
    ).sort_values(ascending=False)

    return model, importances


def print_feature_importance(importances: pd.Series, top_n: int = 15) -> None:
    """Print top features by XGBoost gain."""
    subsection(f"Top {top_n} Features (XGBoost gain)")
    for i, (feat, imp) in enumerate(importances.head(top_n).items()):
        bar = "#" * int(imp * 100)
        print(f"  {i+1:2d}. {feat:35s}  {imp:.4f}  {bar}")


def generate_shap_plot(
    model,
    X: pd.DataFrame,
    plot_dir: Path,
) -> bool:
    """Generate SHAP beeswarm plot if shap is available."""
    try:
        import shap
    except ImportError:
        print("  shap not installed, skipping SHAP plot")
        print("  Install with: ml/.venv/bin/pip install shap")
        return False

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("  matplotlib not available, skipping SHAP plot")
        return False

    try:
        explainer = shap.TreeExplainer(model)
        shap_values = explainer.shap_values(X)

        plot_dir.mkdir(exist_ok=True)

        fig, ax = plt.subplots(1, 1, figsize=(12, 8))

        # For multi-class, shap_values is a list of arrays
        if isinstance(shap_values, list):
            # Use the class with the most variance in SHAP values
            variances = [np.var(sv) for sv in shap_values]
            best_class = int(np.argmax(variances))
            class_name = STRUCTURE_NAMES.get(best_class, str(best_class))
            shap.summary_plot(
                shap_values[best_class], X,
                show=False, max_display=15,
            )
            plt.title(f"SHAP Feature Importance ({class_name})")
        else:
            shap.summary_plot(shap_values, X, show=False, max_display=15)
            plt.title("SHAP Feature Importance")

        plt.tight_layout()
        out_path = plot_dir / "phase2_shap.png"
        plt.savefig(out_path, dpi=150, bbox_inches="tight")
        plt.close("all")
        print(f"  Saved: ml/plots/phase2_shap.png")
        return True
    except Exception as e:
        print(f"  SHAP plot failed: {e}")
        return False


# ── Experiment Saving ────────────────────────────────────────

def save_experiment(
    metrics: dict,
    params: dict,
    importances: pd.Series,
    df: pd.DataFrame,
    y: pd.Series,
    feature_names: list[str],
) -> None:
    """Save experiment results to ml/experiments/."""
    class_dist = y.value_counts().to_dict()
    class_dist_named = {
        STRUCTURE_NAMES.get(k, str(k)): int(v)
        for k, v in class_dist.items()
    }

    top10 = [
        [str(feat), round(float(imp), 4)]
        for feat, imp in importances.head(10).items()
    ]

    experiment = {
        "phase": "phase2_early",
        "model": "xgboost",
        "version": "v1",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "data": {
            "training_days": int(len(y)),
            "feature_count": len(feature_names),
            "class_distribution": class_dist_named,
            "feature_completeness_threshold": 0.80,
            "date_range": [
                df.index.min().strftime("%Y-%m-%d"),
                df.index.max().strftime("%Y-%m-%d"),
            ],
        },
        "params": {k: v for k, v in params.items()
                   if k != "verbosity"},
        "metrics": metrics,
        "feature_importance_top10": top10,
        "notes": (
            "Early feasibility check: walk-forward XGBoost on 3-class "
            "structure prediction (CCS/PCS/IC). Conservative hyperparams, "
            "no tuning. Baseline comparison against majority class and "
            "previous-day heuristic."
        ),
    }

    exp_dir = Path(__file__).resolve().parent / "experiments"
    exp_dir.mkdir(exist_ok=True)
    date_str = datetime.now().strftime("%Y-%m-%d")
    filename = f"phase2_early_xgboost_{date_str}_v1.json"
    out_path = exp_dir / filename
    out_path.write_text(json.dumps(experiment, indent=2))
    print(f"  Saved experiment: {out_path.name}")


# ── Main ─────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Phase 2 Early: Structure Classification Feasibility",
    )
    parser.add_argument(
        "--shap", action="store_true",
        help="Generate SHAP beeswarm plot (requires shap package)",
    )
    args = parser.parse_args()

    # ── Load data ────────────────────────────────────────────
    section("DATA LOADING")
    print("\n  Loading training features + outcomes + labels ...")
    df = load_phase2_data()
    print(f"  {len(df)} days loaded "
          f"({df.index.min():%Y-%m-%d} to {df.index.max():%Y-%m-%d})")

    validate_dataframe(
        df,
        min_rows=10,
        required_columns=["recommended_structure", "structure_correct"],
        range_checks={"vix": (9, 90)},
    )

    # ── Filter to labeled days ───────────────────────────────
    subsection("Filtering to labeled days")
    has_labels = df["structure_correct"].notna()
    has_completeness = (
        df["feature_completeness"].astype(float) >= 0.80
        if "feature_completeness" in df.columns
        else pd.Series(True, index=df.index)
    )
    mask = has_labels & has_completeness
    df_labeled = df[mask].copy()

    # Only keep rows with known 3-class targets
    valid_structures = df_labeled["recommended_structure"].isin(STRUCTURE_MAP.keys())
    df_labeled = df_labeled[valid_structures]

    print(f"  {has_labels.sum()} days with structure_correct labels")
    print(f"  {mask.sum()} days with feature_completeness >= 0.80")
    print(f"  {len(df_labeled)} days with valid structure labels (3-class)")

    if len(df_labeled) < 25:
        print(f"\n  Only {len(df_labeled)} labeled days -- need at least 25 "
              "for walk-forward with min_train=20.")
        print("  Wait for more labeled data before running this experiment.")
        sys.exit(0)

    # Class distribution
    dist = df_labeled["recommended_structure"].value_counts()
    print(f"\n  Class distribution:")
    for struct, count in dist.items():
        print(f"    {struct:25s}  {count:3d}  ({count/len(df_labeled):.0%})")

    # ── Prepare features ─────────────────────────────────────
    section("FEATURE PREPARATION")
    X, feature_names = prepare_features(df_labeled)
    y = encode_target(df_labeled)

    # Drop columns that are 100% null (no signal at all)
    null_pct = X.isnull().mean()
    fully_null = null_pct[null_pct >= 1.0].index.tolist()
    if fully_null:
        print(f"\n  Dropping {len(fully_null)} fully-null columns: "
              f"{fully_null[:10]}{'...' if len(fully_null) > 10 else ''}")
        X = X.drop(columns=fully_null)
        feature_names = X.columns.tolist()

    n_features = len(feature_names)
    n_nulls = X.isnull().sum().sum()
    n_cells = len(X) * n_features
    print(f"\n  Features: {n_features}")
    print(f"  Null cells: {n_nulls}/{n_cells} "
          f"({n_nulls/n_cells:.1%}) -- XGBoost handles natively")
    print(f"  Samples: {len(X)}")

    # ── Walk-forward validation ──────────────────────────────
    section("WALK-FORWARD VALIDATION")

    params = {
        "objective": "multi:softprob",
        "max_depth": 3,
        "n_estimators": 50,
        "learning_rate": 0.1,
        "min_child_weight": 3,
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "reg_alpha": 1.0,
        "reg_lambda": 2.0,
        "random_state": 42,
        "verbosity": 0,
    }

    min_train = 20
    n_predictions = len(X) - min_train
    print(f"\n  Min training window: {min_train} days")
    print(f"  Predictions to make: {n_predictions}")
    print(f"  Running walk-forward ...")

    wf_results = walk_forward(X, y, params, min_train=min_train)

    # ── Compute metrics ──────────────────────────────────────
    section("RESULTS")
    metrics = compute_metrics(wf_results, y)

    subsection("Accuracy")
    print(f"  Walk-forward accuracy:  {metrics['accuracy']:.1%}  "
          f"({wf_results['n_folds']} predictions)")
    print(f"  Majority baseline:     {metrics['majority_baseline']:.1%}  "
          f"(always predict {metrics['majority_class']})")
    print(f"  Previous-day baseline: {metrics['prev_day_baseline']:.1%}  "
          f"(predict yesterday's structure)")

    lift = metrics["accuracy"] - metrics["majority_baseline"]
    print(f"\n  Lift over majority:    {lift:+.1%}")

    subsection("Log Loss")
    n_classes = y.nunique()
    random_ll = -np.log(1.0 / n_classes)
    print(f"  Model log loss:   {metrics['log_loss']:.4f}")
    print(f"  Random baseline:  {random_ll:.4f}  (uniform {n_classes}-class)")

    subsection("Per-Class F1")
    for struct, f1_val in metrics["per_class_f1"].items():
        print(f"  {struct:25s}  F1 = {f1_val:.3f}")

    # ── Feature importance ───────────────────────────────────
    section("FEATURE IMPORTANCE")
    print("\n  Training final model on all data ...")
    model, importances = train_final_model(X, y, params)
    print_feature_importance(importances, top_n=15)

    # SHAP plot
    if args.shap:
        subsection("SHAP Analysis")
        plot_dir = Path(__file__).resolve().parent / "plots"
        generate_shap_plot(model, X, plot_dir)

    # ── Save experiment ──────────────────────────────────────
    section("EXPERIMENT TRACKING")
    save_experiment(metrics, params, importances, df_labeled, y,
                    feature_names)

    # ── Verdict ──────────────────────────────────────────────
    section("VERDICT")

    majority_name = metrics["majority_class"]
    acc = metrics["accuracy"]
    majority_acc = metrics["majority_baseline"]

    if acc > majority_acc + 0.05:
        print(f"\n  {verdict(True)}")
        print(f"  PROMISING -- model shows signal beyond majority class.")
        print(f"  Accuracy {acc:.1%} vs baseline {majority_acc:.1%} "
              f"(+{lift:.1%} lift)")
        takeaway(
            "The model finds exploitable patterns in T1-T2 features.\n"
            "            Next steps: hyperparameter tuning, feature selection,\n"
            "            and expanding to include SIT OUT as a 4th class."
        )
    elif acc > majority_acc:
        print(f"\n  {verdict(False, 'marginal signal')}")
        print(f"  MARGINAL -- weak signal, may need more data or "
              f"better features.")
        print(f"  Accuracy {acc:.1%} vs baseline {majority_acc:.1%} "
              f"(+{lift:.1%} lift)")
        takeaway(
            "Model slightly beats majority class but the edge is thin.\n"
            "            Wait for more labeled days and revisit with\n"
            "            feature engineering or a different model."
        )
    else:
        print(f"\n  {verdict(False)}")
        print(f"  NOT YET -- model doesn't beat "
              f"always-predict-{majority_name}.")
        print(f"  Accuracy {acc:.1%} vs baseline {majority_acc:.1%} "
              f"({lift:+.1%})")
        takeaway(
            "Not enough signal in current features or not enough data.\n"
            "            Keep labeling days and re-run when you have 60+\n"
            "            labeled samples."
        )

    print()


if __name__ == "__main__":
    main()
