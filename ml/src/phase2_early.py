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
    from sklearn.linear_model import LogisticRegression
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.naive_bayes import GaussianNB
    from sklearn.tree import DecisionTreeClassifier
    from sklearn.pipeline import make_pipeline
    from sklearn.impute import SimpleImputer
    from sklearn.preprocessing import StandardScaler, OneHotEncoder
    from sklearn.compose import ColumnTransformer
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
    ML_ROOT,
    load_data,
    validate_dataframe,
    section,
    subsection,
    verdict,
    takeaway,
    save_section_findings,
    VOLATILITY_FEATURES,
    GEX_FEATURES_T1T2,
    GREEK_FEATURES_CORE,
    DARK_POOL_FEATURES,
    OPTIONS_VOLUME_FEATURES,
    IV_PCR_FEATURES,
    MAX_PAIN_FEATURES,
    OI_CHANGE_FEATURES,
    VOL_SURFACE_FEATURES,
)


# ── Feature Groups ───────────────────────────────────────────

# VOLATILITY_FEATURES and GEX_FEATURES_T1T2 imported from utils.
# Phase2 uses core greeks only (no charm OI).
GREEK_FEATURES = GREEK_FEATURES_CORE

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
    VOLATILITY_FEATURES + GEX_FEATURES_T1T2 + FLOW_FEATURES_T1T2 +
    FLOW_AGGREGATE + GREEK_FEATURES + PER_STRIKE_FEATURES +
    CALCULATOR_FEATURES + CALENDAR_FEATURES + PHASE2_FEATURES +
    DARK_POOL_FEATURES + OPTIONS_VOLUME_FEATURES +
    IV_PCR_FEATURES + MAX_PAIN_FEATURES +
    OI_CHANGE_FEATURES + VOL_SURFACE_FEATURES
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

def prepare_features(df: pd.DataFrame) -> tuple[pd.DataFrame, list[str], list[str]]:
    """
    Build the feature matrix from available columns.

    Returns (X_df, numeric_cols, categorical_cols) where X_df has NaN
    for missing numeric values (XGBoost handles these natively) and
    raw categorical strings.
    """
    # Numeric features
    available = [f for f in ALL_NUMERIC_FEATURES if f in df.columns]
    missing_numeric = [f for f in ALL_NUMERIC_FEATURES if f not in df.columns]
    if missing_numeric:
        print(f"  Note: {len(missing_numeric)} numeric features not in data, skipping")

    X = df[available].copy().astype(float)

    # Keep categorical columns as raw strings (encoding moves into pipeline)
    cat_cols_present = []
    for cat_col in CATEGORICAL_FEATURES:
        if cat_col in df.columns:
            X[cat_col] = df[cat_col].fillna("__missing__").astype(str)
            cat_cols_present.append(cat_col)

    return X, available, cat_cols_present


def encode_target(df: pd.DataFrame) -> pd.Series:
    """Map recommended_structure strings to integer labels."""
    return df["recommended_structure"].map(STRUCTURE_MAP)


# ── Walk-Forward Validation ──────────────────────────────────

def walk_forward(
    X: pd.DataFrame,
    y: pd.Series,
    model_factory,
    min_train: int = 20,
) -> dict:
    """
    Expanding-window walk-forward validation.

    Train on days 1..i, predict day i+1.
    model_factory: callable returning a fresh sklearn-compatible model.
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

        model = model_factory()
        model.fit(X_train, y_train)

        pred = model.predict(X_test)[0]
        prob_raw = model.predict_proba(X_test)[0]

        # Pad probability vector if model hasn't seen all classes
        if len(prob_raw) < n_classes:
            prob = np.zeros(n_classes)
            # Get classes from the final estimator in the pipeline
            estimator = model[-1] if hasattr(model, '__getitem__') else model
            model_classes = (
                estimator.classes_ if hasattr(estimator, "classes_")
                else list(range(n_classes))
            )
            for j, cls in enumerate(model_classes):
                prob[int(cls)] = prob_raw[j]
        else:
            prob = prob_raw

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


# ── Model Configs ────────────────────────────────────────────

def build_model_configs(
    n_classes: int,
    xgb_params: dict,
    numeric_cols: list[str],
    categorical_cols: list[str],
) -> dict:
    """
    Define all models for walk-forward comparison.

    sklearn models use ColumnTransformer to handle numeric (impute + scale)
    and categorical (one-hot encode) features in a single pipeline.
    XGBoost handles NaN natively but needs one-hot encoding for categoricals.
    """
    def _sklearn_preprocessor():
        """ColumnTransformer for mixed numeric + categorical features."""
        transformers = [
            ('num', make_pipeline(
                SimpleImputer(strategy='median'),
                StandardScaler(),
            ), numeric_cols),
        ]
        if categorical_cols:
            transformers.append(
                ('cat', OneHotEncoder(
                    handle_unknown='ignore', sparse_output=False,
                ), categorical_cols),
            )
        return ColumnTransformer(transformers, remainder='drop')

    def _impute_only_preprocessor():
        """ColumnTransformer with imputation only (no scaling)."""
        transformers = [
            ('num', SimpleImputer(strategy='median'), numeric_cols),
        ]
        if categorical_cols:
            transformers.append(
                ('cat', OneHotEncoder(
                    handle_unknown='ignore', sparse_output=False,
                ), categorical_cols),
            )
        return ColumnTransformer(transformers, remainder='drop')

    def _xgb_preprocessor():
        """ColumnTransformer for XGBoost (one-hot encode categoricals only)."""
        transformers = [
            ('num', 'passthrough', numeric_cols),
        ]
        if categorical_cols:
            transformers.append(
                ('cat', OneHotEncoder(
                    handle_unknown='ignore', sparse_output=False,
                ), categorical_cols),
            )
        return ColumnTransformer(transformers, remainder='drop')

    return {
        "Logistic Reg (L2)": lambda: make_pipeline(
            _sklearn_preprocessor(),
            LogisticRegression(
                C=1.0, solver="lbfgs",
                max_iter=1000, random_state=42,
                class_weight="balanced",
            ),
        ),
        "Random Forest (15)": lambda: make_pipeline(
            _impute_only_preprocessor(),
            RandomForestClassifier(
                n_estimators=15, max_depth=3, random_state=42,
                class_weight="balanced",
            ),
        ),
        "Naive Bayes": lambda: make_pipeline(
            _impute_only_preprocessor(),
            GaussianNB(),
        ),
        "Decision Tree (d=2)": lambda: make_pipeline(
            _impute_only_preprocessor(),
            DecisionTreeClassifier(
                max_depth=2, random_state=42,
                class_weight="balanced",
            ),
        ),
        "XGBoost": lambda: make_pipeline(
            _xgb_preprocessor(),
            XGBClassifier(
                num_class=n_classes, **xgb_params,
            ),
        ),
    }


def print_model_comparison(
    all_metrics: dict[str, dict],
) -> str:
    """Print comparison table of all models. Returns best model name."""
    subsection("Model Comparison")

    # Header
    print(f"  {'Model':<22s} {'Acc':>7s} {'Lift':>7s} "
          f"{'LogLoss':>8s}  Per-Class F1")
    print(f"  {'─' * 22} {'─' * 7} {'─' * 7} "
          f"{'─' * 8}  {'─' * 30}")

    # Baselines (grab from any model's metrics)
    first = next(iter(all_metrics.values()))
    majority_acc = first["majority_baseline"]
    prev_day_acc = first["prev_day_baseline"]
    prev_lift = prev_day_acc - majority_acc

    print(f"  {'Majority Baseline':<22s} {majority_acc:>6.1%} "
          f"{'—':>7s}  {'—':>8s}  (always predict "
          f"{first['majority_class']})")
    print(f"  {'Previous-Day':<22s} {prev_day_acc:>6.1%} "
          f"{prev_lift:>+6.1%}  {'—':>8s}  "
          f"(repeat yesterday)")

    print(f"  {'─' * 22} {'─' * 7} {'─' * 7} "
          f"{'─' * 8}  {'─' * 30}")

    # Models sorted by accuracy descending
    sorted_models = sorted(
        all_metrics.items(),
        key=lambda x: x[1]["accuracy"],
        reverse=True,
    )
    best_name = sorted_models[0][0]

    for name, m in sorted_models:
        lift = m["accuracy"] - majority_acc
        f1_parts = []
        for struct, val in m["per_class_f1"].items():
            short = {"CALL CREDIT SPREAD": "CCS",
                     "PUT CREDIT SPREAD": "PCS",
                     "IRON CONDOR": "IC"}.get(struct, struct[:3])
            f1_parts.append(f"{short}={val:.2f}")
        f1_str = "  ".join(f1_parts)
        marker = "  <-- best" if name == best_name else ""
        print(f"  {name:<22s} {m['accuracy']:>6.1%} "
              f"{lift:>+6.1%}  {m['log_loss']:>7.4f}  "
              f"{f1_str}{marker}")

    return best_name


# ── Feature Importance ───────────────────────────────────────

def train_final_model(
    X: pd.DataFrame,
    y: pd.Series,
    params: dict,
    numeric_cols: list[str] | None = None,
    categorical_cols: list[str] | None = None,
) -> tuple:
    """Train on all data and return model + feature importances."""
    n_classes = y.nunique()

    if numeric_cols is not None:
        # Build pipeline with preprocessing
        transformers = [('num', 'passthrough', numeric_cols)]
        if categorical_cols:
            transformers.append(
                ('cat', OneHotEncoder(
                    handle_unknown='ignore', sparse_output=False,
                ), categorical_cols),
            )
        ct = ColumnTransformer(transformers, remainder='drop')
        pipe = make_pipeline(
            ct,
            XGBClassifier(num_class=n_classes, **params),
        )
        pipe.fit(X, y)

        try:
            feat_names = ct.get_feature_names_out()
        except Exception:
            feat_names = [
                f"f{j}" for j in range(len(pipe[-1].feature_importances_))
            ]

        importances = pd.Series(
            pipe[-1].feature_importances_,
            index=feat_names,
        ).sort_values(ascending=False)

        return pipe, importances
    else:
        # Legacy: raw numeric-only DataFrame
        model = XGBClassifier(num_class=n_classes, **params)
        model.fit(X, y, verbose=False)
        importances = pd.Series(
            model.feature_importances_,
            index=X.columns,
        ).sort_values(ascending=False)
        return model, importances


def aggregate_fold_importances(
    X: pd.DataFrame,
    y: pd.Series,
    params: dict,
    numeric_cols: list[str],
    categorical_cols: list[str],
    min_train: int = 20,
) -> pd.Series:
    """Aggregate XGBoost feature importances across walk-forward folds."""
    n = len(X)
    n_classes = y.nunique()
    all_importances = []

    def _xgb_preprocessor():
        transformers = [('num', 'passthrough', numeric_cols)]
        if categorical_cols:
            transformers.append(
                ('cat', OneHotEncoder(
                    handle_unknown='ignore', sparse_output=False,
                ), categorical_cols),
            )
        return ColumnTransformer(transformers, remainder='drop')

    for i in range(min_train, n):
        X_train = X.iloc[:i]
        y_train = y.iloc[:i]

        pipe = make_pipeline(
            _xgb_preprocessor(),
            XGBClassifier(num_class=n_classes, **params),
        )
        pipe.fit(X_train, y_train)

        # Get feature names after one-hot encoding
        ct = pipe[0]
        try:
            feat_names = list(ct.get_feature_names_out())
        except Exception:
            feat_names = [
                f"f{j}"
                for j in range(len(pipe[-1].feature_importances_))
            ]

        imp = pd.Series(pipe[-1].feature_importances_, index=feat_names)
        all_importances.append(imp)

    # Average across all folds
    combined = pd.DataFrame(all_importances).fillna(0).mean()
    return combined.sort_values(ascending=False)


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

        _, _ax = plt.subplots(1, 1, figsize=(12, 8))

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
        print("  Saved: ml/plots/phase2_shap.png")
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
    *,
    all_model_metrics: dict[str, dict] | None = None,
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
        "version": "v2",
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
        "xgboost_params": {k: v for k, v in params.items()
                           if k != "verbosity"},
        "metrics": metrics,
        "feature_importance_top10": top10,
        "notes": (
            "Walk-forward comparison of 5 models on 3-class structure "
            "prediction (CCS/PCS/IC). XGBoost with conservative "
            "hyperparams + 4 sklearn baselines (logistic regression, "
            "random forest, naive bayes, decision tree)."
        ),
    }

    # Add comparison results for all models
    if all_model_metrics:
        comparison = {}
        for name, m in all_model_metrics.items():
            comparison[name] = {
                "accuracy": m["accuracy"],
                "log_loss": m["log_loss"],
                "per_class_f1": m["per_class_f1"],
            }
        best_name = max(
            all_model_metrics,
            key=lambda k: all_model_metrics[k]["accuracy"],
        )
        experiment["model_comparison"] = comparison
        experiment["best_model"] = best_name

    exp_dir = ML_ROOT / "experiments"
    exp_dir.mkdir(exist_ok=True)
    date_str = datetime.now().strftime("%Y-%m-%d")
    filename = f"phase2_early_{date_str}_v2.json"
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
    print("\n  Class distribution:")
    for struct, count in dist.items():
        print(f"    {struct:25s}  {count:3d}  ({count/len(df_labeled):.0%})")

    # ── Prepare features ─────────────────────────────────────
    section("FEATURE PREPARATION")
    X, numeric_cols, categorical_cols = prepare_features(df_labeled)
    feature_names = X.columns.tolist()
    y = encode_target(df_labeled)

    # Drop numeric columns that are 100% null (no signal at all)
    null_pct = X[numeric_cols].isnull().mean()
    fully_null = null_pct[null_pct >= 1.0].index.tolist()
    if fully_null:
        print(f"\n  Dropping {len(fully_null)} fully-null columns: "
              f"{fully_null[:10]}{'...' if len(fully_null) > 10 else ''}")
        X = X.drop(columns=fully_null)
        numeric_cols = [c for c in numeric_cols if c not in fully_null]
        feature_names = X.columns.tolist()

    n_features = len(feature_names)
    n_nulls = X[numeric_cols].isnull().sum().sum()
    n_cells = len(X) * len(numeric_cols)
    print(f"\n  Features: {n_features} ({len(numeric_cols)} numeric, "
          f"{len(categorical_cols)} categorical)")
    print(f"  Null cells: {n_nulls}/{n_cells} "
          f"({n_nulls/n_cells:.1%}) -- XGBoost handles natively")
    print(f"  Samples: {len(X)}")

    # ── Walk-forward validation ──────────────────────────────
    section("WALK-FORWARD VALIDATION")

    xgb_params = {
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

    n_classes = y.nunique()
    min_train = 20
    n_predictions = len(X) - min_train

    models = build_model_configs(
        n_classes, xgb_params, numeric_cols, categorical_cols,
    )

    print(f"\n  Min training window: {min_train} days")
    print(f"  Predictions to make: {n_predictions}")
    print(f"  Models: {', '.join(models.keys())}")
    print("  Running walk-forward for all models ...")

    all_results: dict[str, dict] = {}
    all_metrics: dict[str, dict] = {}
    for name, factory in models.items():
        wf = walk_forward(X, y, factory, min_train=min_train)
        all_results[name] = wf
        all_metrics[name] = compute_metrics(wf, y)

    # ── Results ──────────────────────────────────────────────
    section("RESULTS")
    best_model = print_model_comparison(all_metrics)

    # Random baseline for log loss context
    random_ll = -np.log(1.0 / n_classes)
    print(f"\n  Random log loss baseline: {random_ll:.4f} "
          f"(uniform {n_classes}-class)")

    # ── Feature importance (XGBoost) ─────────────────────────
    section("FEATURE IMPORTANCE (XGBoost)")
    print("\n  Aggregating XGBoost importances across walk-forward folds ...")
    importances = aggregate_fold_importances(
        X, y, xgb_params, numeric_cols, categorical_cols,
        min_train=min_train,
    )
    print_feature_importance(importances, top_n=15)

    # SHAP plot (requires a single fitted model on all data)
    if args.shap:
        subsection("SHAP Analysis")
        print("  Training single XGBoost on all data for SHAP ...")
        shap_pipe, _ = train_final_model(
            X, y, xgb_params, numeric_cols, categorical_cols,
        )
        plot_dir = ML_ROOT / "plots"
        # Transform X through the preprocessor for SHAP
        ct = shap_pipe[0]
        X_transformed = pd.DataFrame(
            ct.transform(X),
            columns=list(ct.get_feature_names_out()),
        )
        generate_shap_plot(shap_pipe[-1], X_transformed, plot_dir)

    # ── Save experiment ──────────────────────────────────────
    section("EXPERIMENT TRACKING")
    save_experiment(
        all_metrics["XGBoost"], xgb_params, importances,
        df_labeled, y, feature_names,
        all_model_metrics=all_metrics,
    )

    # ── Verdict ──────────────────────────────────────────────
    section("VERDICT")

    best_metrics = all_metrics[best_model]
    majority_acc = best_metrics["majority_baseline"]
    best_acc = best_metrics["accuracy"]
    lift = best_acc - majority_acc

    xgb_acc = all_metrics["XGBoost"]["accuracy"]
    xgb_lift = xgb_acc - majority_acc

    if best_acc > majority_acc + 0.05:
        tag = verdict(True)
        print(f"\n  {tag}")
        print(f"  PROMISING -- {best_model} shows signal "
              "beyond majority class.")
        print(f"  Best: {best_acc:.1%} vs baseline "
              f"{majority_acc:.1%} ({lift:+.1%} lift)")
        if best_model != "XGBoost":
            print(f"  XGBoost: {xgb_acc:.1%} ({xgb_lift:+.1%} lift)")
            takeaway(
                f"{best_model} outperforms XGBoost -- simpler model\n"
                "            is better with this sample size. Consider\n"
                "            using it as the primary model until n > 60."
            )
        else:
            takeaway(
                "XGBoost leads the pack. Next steps: hyperparameter\n"
                "            tuning, feature selection, and expanding to\n"
                "            include SIT OUT as a 4th class."
            )
    elif best_acc > majority_acc:
        tag = verdict(False, "marginal signal")
        print(f"\n  {tag}")
        print(f"  MARGINAL -- {best_model} shows weak signal.")
        print(f"  Best: {best_acc:.1%} vs baseline "
              f"{majority_acc:.1%} ({lift:+.1%} lift)")
        takeaway(
            "Models slightly beat majority class but the edge is\n"
            "            thin. Wait for more labeled days and revisit."
        )
    else:
        tag = verdict(False)
        print(f"\n  {tag}")
        print("  NOT YET -- no model beats majority class.")
        print(f"  Best: {best_acc:.1%} vs baseline "
              f"{majority_acc:.1%} ({lift:+.1%})")
        takeaway(
            "Not enough signal in current features or not enough\n"
            "            data. Keep labeling days and re-run when you\n"
            "            have 60+ labeled samples."
        )

    # Save findings
    per_model = {}
    for name, m in all_metrics.items():
        per_model[name] = {
            "accuracy": m["accuracy"],
            "log_loss": m["log_loss"],
            "per_class_f1": m["per_class_f1"],
        }
    top_features = [
        {"feature": str(feat), "importance": round(float(imp), 4)}
        for feat, imp in importances.head(15).items()
    ]
    save_section_findings("phase2", {
        "per_model": per_model,
        "best_model": best_model,
        "best_accuracy": best_metrics["accuracy"],
        "majority_baseline": best_metrics["majority_baseline"],
        "walk_forward_folds": best_metrics["walk_forward_folds"],
        "top_features": top_features,
        "n_labeled_days": len(df_labeled),
        "n_features": n_features,
    })

    print()


if __name__ == "__main__":
    main()
