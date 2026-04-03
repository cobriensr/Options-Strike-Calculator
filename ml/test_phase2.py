"""
Pytest tests for phase2_early.py — structure classification feasibility.

Tests cover the five public functions and the module-level constants.
Uses sklearn's SimpleImputer + DecisionTreeClassifier in a Pipeline
as the model_factory to avoid XGBoost dependency issues in CI.
"""

import numpy as np
import pandas as pd
import pytest
from sklearn.impute import SimpleImputer
from sklearn.pipeline import make_pipeline
from sklearn.tree import DecisionTreeClassifier

from phase2_early import (
    ALL_NUMERIC_FEATURES,
    CATEGORICAL_FEATURES,
    STRUCTURE_MAP,
    STRUCTURE_NAMES,
    build_model_configs,
    compute_metrics,
    encode_target,
    prepare_features,
    walk_forward,
)


# ── Fixtures ────────────────────────────────────────────────────


@pytest.fixture()
def numeric_feature_subset() -> list[str]:
    """A small, deterministic subset of ALL_NUMERIC_FEATURES for test DataFrames."""
    return [
        "vix",
        "vix1d",
        "gex_oi_t1",
        "gex_oi_t2",
        "sigma",
    ]


@pytest.fixture()
def sample_df(numeric_feature_subset: list[str]) -> pd.DataFrame:
    """
    30-row DataFrame with numeric + categorical columns
    and a recommended_structure target column.
    """
    rng = np.random.default_rng(42)
    n = 30

    data: dict[str, object] = {}
    for feat in numeric_feature_subset:
        data[feat] = rng.standard_normal(n)

    # Categorical columns
    data["charm_pattern"] = rng.choice(
        ["pos_dom", "neg_dom", "mixed"], size=n
    )
    data["regime_zone"] = rng.choice(["call", "put", "neutral"], size=n)
    data["prev_day_direction"] = rng.choice(["up", "down", "flat"], size=n)
    data["prev_day_range_cat"] = rng.choice(
        ["narrow", "average", "wide"], size=n
    )

    # Target
    structures = list(STRUCTURE_MAP.keys())
    data["recommended_structure"] = rng.choice(structures, size=n)

    df = pd.DataFrame(data)
    df.index = pd.date_range("2025-01-01", periods=n, freq="B", name="date")
    return df


@pytest.fixture()
def encoded_target(sample_df: pd.DataFrame) -> pd.Series:
    """Integer-encoded target series from sample_df."""
    return encode_target(sample_df)


@pytest.fixture()
def prepared_features(
    sample_df: pd.DataFrame,
) -> tuple[pd.DataFrame, list[str]]:
    """Feature matrix and feature names from sample_df."""
    return prepare_features(sample_df)


def _tree_factory():
    """Model factory producing a Pipeline with SimpleImputer + DecisionTree."""
    return make_pipeline(
        SimpleImputer(strategy="median"),
        DecisionTreeClassifier(max_depth=2, random_state=42),
    )


# ── Constants ───────────────────────────────────────────────────


class TestConstants:
    """Verify module-level constants are well-formed."""

    def test_structure_map_has_three_classes(self):
        """STRUCTURE_MAP must contain CCS, PCS, and IC mapped to 0, 1, 2."""
        assert STRUCTURE_MAP == {
            "CALL CREDIT SPREAD": 0,
            "PUT CREDIT SPREAD": 1,
            "IRON CONDOR": 2,
        }

    def test_structure_names_is_inverse_of_map(self):
        """STRUCTURE_NAMES must be the exact inverse of STRUCTURE_MAP."""
        for name, idx in STRUCTURE_MAP.items():
            assert STRUCTURE_NAMES[idx] == name
        assert len(STRUCTURE_NAMES) == len(STRUCTURE_MAP)

    def test_all_numeric_features_is_nonempty_list_of_strings(self):
        """ALL_NUMERIC_FEATURES must be a non-empty list of str."""
        assert isinstance(ALL_NUMERIC_FEATURES, list)
        assert len(ALL_NUMERIC_FEATURES) > 0
        assert all(isinstance(f, str) for f in ALL_NUMERIC_FEATURES)

    def test_categorical_features_has_expected_entries(self):
        """CATEGORICAL_FEATURES must include the five known categoricals."""
        expected = {
            "charm_pattern",
            "regime_zone",
            "prev_day_direction",
            "prev_day_range_cat",
            "dp_net_bias",
        }
        assert set(CATEGORICAL_FEATURES) == expected

    def test_no_overlap_between_numeric_and_categorical(self):
        """Numeric and categorical feature lists must be disjoint."""
        overlap = set(ALL_NUMERIC_FEATURES) & set(CATEGORICAL_FEATURES)
        assert overlap == set(), f"Overlap: {overlap}"


# ── prepare_features ────────────────────────────────────────────


class TestPrepareFeatures:
    """Tests for prepare_features(df)."""

    def test_returns_tuple_of_dataframe_and_list(
        self, prepared_features: tuple[pd.DataFrame, list[str]]
    ):
        """Return type must be (DataFrame, list[str])."""
        X, feature_names = prepared_features
        assert isinstance(X, pd.DataFrame)
        assert isinstance(feature_names, list)

    def test_feature_names_match_columns(
        self, prepared_features: tuple[pd.DataFrame, list[str]]
    ):
        """feature_names must exactly equal X.columns."""
        X, feature_names = prepared_features
        assert feature_names == X.columns.tolist()

    def test_numeric_columns_present(
        self,
        prepared_features: tuple[pd.DataFrame, list[str]],
        numeric_feature_subset: list[str],
    ):
        """Available numeric features must appear in the output."""
        X, _ = prepared_features
        for feat in numeric_feature_subset:
            assert feat in X.columns, f"Missing numeric feature: {feat}"

    def test_one_hot_columns_created_for_categoricals(
        self, prepared_features: tuple[pd.DataFrame, list[str]]
    ):
        """One-hot encoded columns must exist for each categorical value."""
        X, _ = prepared_features
        # charm_pattern -> prefix "charm" (strips "_pattern")
        charm_cols = [c for c in X.columns if c.startswith("charm_")]
        assert len(charm_cols) > 0, "No one-hot columns for charm_pattern"

        # regime_zone -> prefix "regime" (strips "_zone")
        regime_cols = [c for c in X.columns if c.startswith("regime_")]
        assert len(regime_cols) > 0, "No one-hot columns for regime_zone"

        # prev_day_direction -> prefix "prev_direction"
        prev_dir_cols = [c for c in X.columns if c.startswith("prev_direction")]
        assert (
            len(prev_dir_cols) > 0
        ), "No one-hot columns for prev_day_direction"

        # prev_day_range_cat -> prefix "prev_range_cat"
        prev_range_cols = [
            c for c in X.columns if c.startswith("prev_range_cat")
        ]
        assert (
            len(prev_range_cols) > 0
        ), "No one-hot columns for prev_day_range_cat"

    def test_output_row_count_matches_input(
        self,
        sample_df: pd.DataFrame,
        prepared_features: tuple[pd.DataFrame, list[str]],
    ):
        """Row count must be preserved."""
        X, _ = prepared_features
        assert len(X) == len(sample_df)

    def test_output_has_more_columns_than_numeric_alone(
        self,
        prepared_features: tuple[pd.DataFrame, list[str]],
        numeric_feature_subset: list[str],
    ):
        """One-hot encoding must add columns beyond the numeric set."""
        X, _ = prepared_features
        assert X.shape[1] > len(numeric_feature_subset)

    def test_all_values_numeric(
        self, prepared_features: tuple[pd.DataFrame, list[str]]
    ):
        """Every cell in the output must be numeric (int or float)."""
        X, _ = prepared_features
        for col in X.columns:
            assert pd.api.types.is_numeric_dtype(
                X[col]
            ), f"Column {col} is not numeric"

    def test_missing_numeric_features_are_silently_skipped(self):
        """
        Columns not present in df are skipped without error.
        Only present columns appear in X.
        """
        df = pd.DataFrame(
            {
                "vix": [10.0, 12.0, 11.0],
                "recommended_structure": [
                    "IRON CONDOR",
                    "PUT CREDIT SPREAD",
                    "CALL CREDIT SPREAD",
                ],
            }
        )
        df.index = pd.date_range("2025-01-01", periods=3, freq="B", name="date")
        X, feature_names = prepare_features(df)
        assert "vix" in feature_names
        # A feature not in df must not appear
        assert "sigma" not in feature_names

    def test_no_categorical_columns_in_df(self):
        """When no categorical columns exist, output contains only numeric cols."""
        df = pd.DataFrame(
            {
                "vix": [1.0, 2.0],
                "vix1d": [3.0, 4.0],
            }
        )
        df.index = pd.date_range("2025-06-01", periods=2, freq="B", name="date")
        X, feature_names = prepare_features(df)
        assert feature_names == ["vix", "vix1d"]


# ── encode_target ───────────────────────────────────────────────


class TestEncodeTarget:
    """Tests for encode_target(df)."""

    def test_maps_ccs_to_zero(self):
        """CALL CREDIT SPREAD must map to 0."""
        df = pd.DataFrame(
            {"recommended_structure": ["CALL CREDIT SPREAD"]},
            index=pd.DatetimeIndex(["2025-01-01"], name="date"),
        )
        result = encode_target(df)
        assert result.iloc[0] == 0

    def test_maps_pcs_to_one(self):
        """PUT CREDIT SPREAD must map to 1."""
        df = pd.DataFrame(
            {"recommended_structure": ["PUT CREDIT SPREAD"]},
            index=pd.DatetimeIndex(["2025-01-01"], name="date"),
        )
        result = encode_target(df)
        assert result.iloc[0] == 1

    def test_maps_ic_to_two(self):
        """IRON CONDOR must map to 2."""
        df = pd.DataFrame(
            {"recommended_structure": ["IRON CONDOR"]},
            index=pd.DatetimeIndex(["2025-01-01"], name="date"),
        )
        result = encode_target(df)
        assert result.iloc[0] == 2

    def test_unknown_structure_maps_to_nan(self):
        """An unrecognised structure string must produce NaN."""
        df = pd.DataFrame(
            {"recommended_structure": ["BUTTERFLY"]},
            index=pd.DatetimeIndex(["2025-01-01"], name="date"),
        )
        result = encode_target(df)
        assert pd.isna(result.iloc[0])

    def test_returns_series(self, sample_df: pd.DataFrame):
        """Return type must be a pandas Series."""
        result = encode_target(sample_df)
        assert isinstance(result, pd.Series)

    def test_length_matches_input(self, sample_df: pd.DataFrame):
        """Output length must match input row count."""
        result = encode_target(sample_df)
        assert len(result) == len(sample_df)

    def test_values_in_expected_set(
        self, encoded_target: pd.Series
    ):
        """All encoded values must be in {0, 1, 2}."""
        unique_vals = set(encoded_target.dropna().unique())
        assert unique_vals.issubset({0, 1, 2})


# ── walk_forward ────────────────────────────────────────────────


class TestWalkForward:
    """Tests for walk_forward(X, y, model_factory, min_train)."""

    def test_returns_dict_with_expected_keys(
        self,
        prepared_features: tuple[pd.DataFrame, list[str]],
        encoded_target: pd.Series,
    ):
        """Result dict must have predictions, probabilities, actuals, indices, n_folds."""
        X, _ = prepared_features
        result = walk_forward(X, encoded_target, _tree_factory, min_train=20)
        expected_keys = {
            "predictions",
            "probabilities",
            "actuals",
            "indices",
            "n_folds",
        }
        assert set(result.keys()) == expected_keys

    def test_n_folds_equals_n_minus_min_train(
        self,
        prepared_features: tuple[pd.DataFrame, list[str]],
        encoded_target: pd.Series,
    ):
        """n_folds must equal len(X) - min_train."""
        X, _ = prepared_features
        min_train = 20
        result = walk_forward(
            X, encoded_target, _tree_factory, min_train=min_train
        )
        assert result["n_folds"] == len(X) - min_train

    def test_predictions_length(
        self,
        prepared_features: tuple[pd.DataFrame, list[str]],
        encoded_target: pd.Series,
    ):
        """predictions array length must equal n_folds."""
        X, _ = prepared_features
        result = walk_forward(X, encoded_target, _tree_factory, min_train=20)
        assert len(result["predictions"]) == result["n_folds"]

    def test_actuals_length(
        self,
        prepared_features: tuple[pd.DataFrame, list[str]],
        encoded_target: pd.Series,
    ):
        """actuals array length must equal n_folds."""
        X, _ = prepared_features
        result = walk_forward(X, encoded_target, _tree_factory, min_train=20)
        assert len(result["actuals"]) == result["n_folds"]

    def test_probabilities_shape(
        self,
        prepared_features: tuple[pd.DataFrame, list[str]],
        encoded_target: pd.Series,
    ):
        """probabilities must be 2D with shape (n_folds, n_classes)."""
        X, _ = prepared_features
        result = walk_forward(X, encoded_target, _tree_factory, min_train=20)
        n_classes = encoded_target.nunique()
        assert result["probabilities"].shape == (
            result["n_folds"],
            n_classes,
        )

    def test_indices_length(
        self,
        prepared_features: tuple[pd.DataFrame, list[str]],
        encoded_target: pd.Series,
    ):
        """indices list length must equal n_folds."""
        X, _ = prepared_features
        result = walk_forward(X, encoded_target, _tree_factory, min_train=20)
        assert len(result["indices"]) == result["n_folds"]

    def test_predictions_are_valid_class_labels(
        self,
        prepared_features: tuple[pd.DataFrame, list[str]],
        encoded_target: pd.Series,
    ):
        """Every prediction must be a known class label."""
        X, _ = prepared_features
        result = walk_forward(X, encoded_target, _tree_factory, min_train=20)
        valid_labels = set(encoded_target.unique())
        for pred in result["predictions"]:
            assert pred in valid_labels, f"Unexpected prediction: {pred}"

    def test_probabilities_sum_to_one(
        self,
        prepared_features: tuple[pd.DataFrame, list[str]],
        encoded_target: pd.Series,
    ):
        """Each probability row must sum to ~1.0."""
        X, _ = prepared_features
        result = walk_forward(X, encoded_target, _tree_factory, min_train=20)
        row_sums = result["probabilities"].sum(axis=1)
        np.testing.assert_allclose(row_sums, 1.0, atol=1e-6)

    def test_min_train_larger_than_data_yields_zero_folds(self):
        """When min_train >= len(X), walk_forward returns 0 folds."""
        X = pd.DataFrame({"a": [1.0, 2.0, 3.0]})
        y = pd.Series([0, 1, 0])
        result = walk_forward(X, y, _tree_factory, min_train=10)
        assert result["n_folds"] == 0
        assert len(result["predictions"]) == 0

    def test_expanding_window_train_set_grows(
        self,
        prepared_features: tuple[pd.DataFrame, list[str]],
        encoded_target: pd.Series,
    ):
        """
        Verify the expanding-window property: each fold's model must
        receive a strictly larger training set than the previous fold.
        We confirm this indirectly by checking that indices are
        sequentially increasing and correspond to rows after min_train.
        """
        X, _ = prepared_features
        min_train = 20
        result = walk_forward(
            X, encoded_target, _tree_factory, min_train=min_train
        )
        expected_indices = X.index[min_train:].tolist()
        assert result["indices"] == expected_indices


# ── compute_metrics ─────────────────────────────────────────────


class TestComputeMetrics:
    """Tests for compute_metrics(results, y_full)."""

    @pytest.fixture()
    def wf_result(
        self,
        prepared_features: tuple[pd.DataFrame, list[str]],
        encoded_target: pd.Series,
    ) -> dict:
        """Walk-forward result for metrics tests."""
        X, _ = prepared_features
        return walk_forward(X, encoded_target, _tree_factory, min_train=20)

    def test_returns_dict(
        self, wf_result: dict, encoded_target: pd.Series
    ):
        """compute_metrics must return a dict."""
        metrics = compute_metrics(wf_result, encoded_target)
        assert isinstance(metrics, dict)

    def test_has_expected_keys(
        self, wf_result: dict, encoded_target: pd.Series
    ):
        """Result dict must contain all expected metric keys."""
        metrics = compute_metrics(wf_result, encoded_target)
        expected_keys = {
            "accuracy",
            "log_loss",
            "per_class_f1",
            "majority_class",
            "majority_baseline",
            "prev_day_baseline",
            "walk_forward_folds",
        }
        assert set(metrics.keys()) == expected_keys

    def test_accuracy_between_zero_and_one(
        self, wf_result: dict, encoded_target: pd.Series
    ):
        """Accuracy must be in [0, 1]."""
        metrics = compute_metrics(wf_result, encoded_target)
        assert 0.0 <= metrics["accuracy"] <= 1.0

    def test_majority_baseline_between_zero_and_one(
        self, wf_result: dict, encoded_target: pd.Series
    ):
        """Majority baseline must be in [0, 1]."""
        metrics = compute_metrics(wf_result, encoded_target)
        assert 0.0 <= metrics["majority_baseline"] <= 1.0

    def test_prev_day_baseline_between_zero_and_one(
        self, wf_result: dict, encoded_target: pd.Series
    ):
        """Previous-day baseline must be in [0, 1]."""
        metrics = compute_metrics(wf_result, encoded_target)
        assert 0.0 <= metrics["prev_day_baseline"] <= 1.0

    def test_log_loss_is_non_negative(
        self, wf_result: dict, encoded_target: pd.Series
    ):
        """Log loss must be >= 0 (or NaN)."""
        metrics = compute_metrics(wf_result, encoded_target)
        ll = metrics["log_loss"]
        assert np.isnan(ll) or ll >= 0.0

    def test_per_class_f1_has_entries_for_each_class(
        self, wf_result: dict, encoded_target: pd.Series
    ):
        """per_class_f1 must have an entry for each class in STRUCTURE_NAMES."""
        metrics = compute_metrics(wf_result, encoded_target)
        n_classes = wf_result["probabilities"].shape[1]
        assert len(metrics["per_class_f1"]) == n_classes

    def test_per_class_f1_values_between_zero_and_one(
        self, wf_result: dict, encoded_target: pd.Series
    ):
        """Each per-class F1 score must be in [0, 1]."""
        metrics = compute_metrics(wf_result, encoded_target)
        for cls_name, f1_val in metrics["per_class_f1"].items():
            assert 0.0 <= f1_val <= 1.0, f"F1 for {cls_name} out of range"

    def test_majority_class_is_a_known_structure(
        self, wf_result: dict, encoded_target: pd.Series
    ):
        """majority_class must be one of the known structure names."""
        metrics = compute_metrics(wf_result, encoded_target)
        assert metrics["majority_class"] in STRUCTURE_MAP

    def test_walk_forward_folds_matches_result(
        self, wf_result: dict, encoded_target: pd.Series
    ):
        """walk_forward_folds must match the n_folds from the walk-forward result."""
        metrics = compute_metrics(wf_result, encoded_target)
        assert metrics["walk_forward_folds"] == wf_result["n_folds"]

    def test_perfect_predictions_yield_accuracy_one(self):
        """When predictions perfectly match actuals, accuracy must be 1.0."""
        actuals = np.array([0, 1, 2, 0, 1])
        probs = np.eye(3)[actuals]  # perfect one-hot probabilities
        results = {
            "predictions": actuals.copy(),
            "probabilities": probs,
            "actuals": actuals,
            "indices": list(range(5)),
            "n_folds": 5,
        }
        y_full = pd.Series([0, 1, 2, 0, 1, 0, 1, 2])
        metrics = compute_metrics(results, y_full)
        assert metrics["accuracy"] == 1.0


# ── build_model_configs ─────────────────────────────────────────


class TestBuildModelConfigs:
    """Tests for build_model_configs(n_classes, xgb_params)."""

    @pytest.fixture()
    def configs(self) -> dict:
        """Model configs built with 3 classes and minimal XGBoost params."""
        xgb_params = {
            "objective": "multi:softprob",
            "max_depth": 3,
            "n_estimators": 10,
            "random_state": 42,
            "verbosity": 0,
        }
        return build_model_configs(n_classes=3, xgb_params=xgb_params)

    def test_returns_five_models(self, configs: dict):
        """build_model_configs must return exactly 5 model entries."""
        assert len(configs) == 5

    def test_each_value_is_callable(self, configs: dict):
        """Each config value must be a callable (lambda / function)."""
        for name, factory in configs.items():
            assert callable(factory), f"{name} is not callable"

    def test_expected_model_names(self, configs: dict):
        """Must contain the five known model names."""
        expected_names = {
            "Logistic Reg (L2)",
            "Random Forest (15)",
            "Naive Bayes",
            "Decision Tree (d=2)",
            "XGBoost",
        }
        assert set(configs.keys()) == expected_names

    def test_sklearn_models_have_fit_predict_predict_proba(
        self, configs: dict
    ):
        """
        Each non-XGBoost factory must produce an object with
        fit, predict, and predict_proba methods.
        """
        sklearn_names = [
            "Logistic Reg (L2)",
            "Random Forest (15)",
            "Naive Bayes",
            "Decision Tree (d=2)",
        ]
        for name in sklearn_names:
            model = configs[name]()
            assert hasattr(model, "fit"), f"{name} missing fit()"
            assert hasattr(model, "predict"), f"{name} missing predict()"
            assert hasattr(
                model, "predict_proba"
            ), f"{name} missing predict_proba()"

    def test_xgboost_factory_returns_model_with_fit_predict(
        self, configs: dict
    ):
        """XGBoost factory must produce a model with fit, predict, predict_proba."""
        model = configs["XGBoost"]()
        assert hasattr(model, "fit")
        assert hasattr(model, "predict")
        assert hasattr(model, "predict_proba")

    def test_factories_return_fresh_instances(self, configs: dict):
        """Two calls to the same factory must produce distinct objects."""
        for name, factory in configs.items():
            m1 = factory()
            m2 = factory()
            assert m1 is not m2, f"{name} factory returned the same object"


# ── Edge Cases / Integration ────────────────────────────────────


class TestEdgeCases:
    """Edge-case and integration scenarios."""

    def test_walk_forward_with_two_classes_only(self):
        """walk_forward must work when the target has only 2 classes."""
        rng = np.random.default_rng(99)
        n = 30
        X = pd.DataFrame(
            {
                "feat_a": rng.standard_normal(n),
                "feat_b": rng.standard_normal(n),
            }
        )
        y = pd.Series(rng.choice([0, 1], size=n))
        result = walk_forward(X, y, _tree_factory, min_train=20)
        assert result["n_folds"] == 10
        assert result["probabilities"].shape[1] == 2

    def test_walk_forward_with_nan_features(self):
        """walk_forward must handle NaN values via the imputer in the pipeline."""
        rng = np.random.default_rng(7)
        n = 30
        data = rng.standard_normal((n, 3))
        # Sprinkle NaNs
        data[0, 0] = np.nan
        data[5, 1] = np.nan
        data[15, 2] = np.nan
        X = pd.DataFrame(data, columns=["a", "b", "c"])
        y = pd.Series(rng.choice([0, 1, 2], size=n))
        result = walk_forward(X, y, _tree_factory, min_train=20)
        assert result["n_folds"] == 10
        # Predictions should all be valid (no NaN)
        assert not np.any(np.isnan(result["predictions"]))

    def test_prepare_features_with_nan_in_numeric(self):
        """prepare_features must preserve NaN values (XGBoost handles them)."""
        df = pd.DataFrame(
            {
                "vix": [10.0, np.nan, 12.0],
                "vix1d": [5.0, 6.0, np.nan],
            }
        )
        df.index = pd.date_range("2025-01-01", periods=3, freq="B", name="date")
        X, _ = prepare_features(df)
        assert X["vix"].isna().sum() == 1
        assert X["vix1d"].isna().sum() == 1

    def test_end_to_end_pipeline(self, sample_df: pd.DataFrame):
        """
        Full pipeline: prepare_features -> encode_target -> walk_forward -> compute_metrics.
        Verifies the functions compose correctly end-to-end.
        """
        X, feature_names = prepare_features(sample_df)
        y = encode_target(sample_df)

        result = walk_forward(X, y, _tree_factory, min_train=20)
        metrics = compute_metrics(result, y)

        # Sanity: all metric keys present and values reasonable
        assert 0.0 <= metrics["accuracy"] <= 1.0
        assert metrics["walk_forward_folds"] == 10
        assert metrics["majority_class"] in STRUCTURE_MAP
        assert len(metrics["per_class_f1"]) == y.nunique()

    def test_compute_metrics_with_single_class_actuals(self):
        """
        compute_metrics must not crash when actuals contain a single class.
        This can happen with small walk-forward windows.
        """
        actuals = np.array([0, 0, 0, 0, 0])
        preds = np.array([0, 0, 1, 0, 0])
        probs = np.array([
            [0.9, 0.05, 0.05],
            [0.8, 0.1, 0.1],
            [0.3, 0.5, 0.2],
            [0.7, 0.2, 0.1],
            [0.85, 0.1, 0.05],
        ])
        results = {
            "predictions": preds,
            "probabilities": probs,
            "actuals": actuals,
            "indices": list(range(5)),
            "n_folds": 5,
        }
        y_full = pd.Series([0, 0, 0, 0, 0, 1, 2])
        metrics = compute_metrics(results, y_full)
        assert metrics["accuracy"] == 0.8
        assert metrics["majority_class"] == "CALL CREDIT SPREAD"


# ── print_model_comparison ─────────────────────────────────────


from phase2_early import (
    print_model_comparison,
    print_feature_importance,
    save_experiment,
    train_final_model,
)


def _make_all_metrics(acc_a: float = 0.60, acc_b: float = 0.45) -> dict:
    """Build a minimal all_metrics dict with two models."""
    return {
        "ModelA": {
            "accuracy": acc_a,
            "log_loss": 0.9,
            "majority_baseline": 0.40,
            "prev_day_baseline": 0.35,
            "majority_class": "IRON CONDOR",
            "per_class_f1": {
                "CALL CREDIT SPREAD": 0.55,
                "PUT CREDIT SPREAD": 0.50,
                "IRON CONDOR": 0.65,
            },
            "walk_forward_folds": 10,
        },
        "ModelB": {
            "accuracy": acc_b,
            "log_loss": 1.1,
            "majority_baseline": 0.40,
            "prev_day_baseline": 0.35,
            "majority_class": "IRON CONDOR",
            "per_class_f1": {
                "CALL CREDIT SPREAD": 0.40,
                "PUT CREDIT SPREAD": 0.38,
                "IRON CONDOR": 0.50,
            },
            "walk_forward_folds": 10,
        },
    }


class TestPrintModelComparison:
    """Tests for print_model_comparison(all_metrics)."""

    def test_print_model_comparison_returns_best(self, capsys):
        """Returns the model name with the highest accuracy."""
        all_metrics = _make_all_metrics(acc_a=0.60, acc_b=0.45)
        best = print_model_comparison(all_metrics)
        assert best == "ModelA"
        captured = capsys.readouterr()
        assert "Model Comparison" in captured.out

    def test_print_model_comparison_prints_baselines(self, capsys):
        """Output must include both baseline rows."""
        all_metrics = _make_all_metrics()
        print_model_comparison(all_metrics)
        captured = capsys.readouterr()
        assert "Majority Baseline" in captured.out
        assert "Previous-Day" in captured.out


# ── train_final_model ──────────────────────────────────────────


class TestTrainFinalModel:
    """Tests for train_final_model(X, y, params)."""

    def test_train_final_model_returns_importances(self):
        """Returns (model, pd.Series) with importances summing to ~1.0."""
        rng = np.random.default_rng(42)
        n = 30
        feature_names = ["f1", "f2", "f3", "f4", "f5"]
        X = pd.DataFrame(
            rng.standard_normal((n, len(feature_names))),
            columns=feature_names,
        )
        y = pd.Series(rng.choice([0, 1, 2], size=n))
        params = {
            "objective": "multi:softprob",
            "max_depth": 2,
            "n_estimators": 10,
            "random_state": 42,
            "verbosity": 0,
        }
        model, importances = train_final_model(X, y, params)

        assert hasattr(model, "predict")
        assert isinstance(importances, pd.Series)
        assert importances.sum() == pytest.approx(1.0, abs=0.01)
        assert set(importances.index) == set(feature_names)


# ── print_feature_importance ───────────────────────────────────


class TestPrintFeatureImportance:
    """Tests for print_feature_importance(importances, top_n)."""

    def test_print_feature_importance(self, capsys):
        """Top 15 features are printed when given 20."""
        rng = np.random.default_rng(42)
        names = [f"feature_{i}" for i in range(20)]
        values = rng.random(20)
        values = values / values.sum()
        importances = pd.Series(values, index=names).sort_values(
            ascending=False
        )

        print_feature_importance(importances, top_n=15)
        captured = capsys.readouterr()

        # All top 15 features should appear in the output
        for feat in importances.head(15).index:
            assert feat in captured.out

        # The 16th-20th features should NOT appear
        for feat in importances.tail(5).index:
            if feat not in importances.head(15).index:
                assert feat not in captured.out


# ── save_experiment ────────────────────────────────────────────


class TestSaveExperiment:
    """Tests for save_experiment(...)."""

    def test_save_experiment_creates_json(self, tmp_path, monkeypatch):
        """Verify JSON file is created with expected keys."""
        import phase2_early

        monkeypatch.setattr(
            phase2_early,
            "__file__",
            str(tmp_path / "phase2_early.py"),
        )

        rng = np.random.default_rng(42)
        n = 10
        feature_names = ["f1", "f2", "f3"]
        df = pd.DataFrame(
            rng.standard_normal((n, len(feature_names))),
            columns=feature_names,
        )
        df.index = pd.date_range(
            "2025-01-01", periods=n, freq="B", name="date"
        )
        y = pd.Series(rng.choice([0, 1, 2], size=n))
        importances = pd.Series(
            [0.5, 0.3, 0.2], index=feature_names
        )
        metrics = {
            "accuracy": 0.55,
            "log_loss": 0.9,
            "per_class_f1": {
                "CALL CREDIT SPREAD": 0.5,
                "PUT CREDIT SPREAD": 0.5,
                "IRON CONDOR": 0.5,
            },
            "majority_class": "IRON CONDOR",
            "majority_baseline": 0.40,
            "prev_day_baseline": 0.35,
            "walk_forward_folds": 10,
        }
        params = {
            "objective": "multi:softprob",
            "max_depth": 3,
            "n_estimators": 50,
            "verbosity": 0,
        }
        all_model_metrics = _make_all_metrics()

        save_experiment(
            metrics,
            params,
            importances,
            df,
            y,
            feature_names,
            all_model_metrics=all_model_metrics,
        )

        exp_dir = tmp_path / "experiments"
        assert exp_dir.exists()
        json_files = list(exp_dir.glob("*.json"))
        assert len(json_files) == 1

        import json

        data = json.loads(json_files[0].read_text())
        assert data["phase"] == "phase2_early"
        assert data["model"] == "xgboost"
        assert "metrics" in data
        assert "feature_importance_top10" in data
        assert "data" in data
        assert "model_comparison" in data
        assert "best_model" in data
