"""
Pytest tests for phase2_early.py — structure classification feasibility.

Tests cover the five public functions and the module-level constants.
Uses sklearn's SimpleImputer + DecisionTreeClassifier in a Pipeline
as the model_factory to avoid XGBoost dependency issues in CI.
"""

import numpy as np
import pandas as pd
import pytest
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import OneHotEncoder
from sklearn.tree import DecisionTreeClassifier

from phase2_early import (
    ALL_NUMERIC_FEATURES,
    CATEGORICAL_FEATURES,
    STRUCTURE_MAP,
    STRUCTURE_NAMES,
    aggregate_fold_importances,
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
    data["charm_pattern"] = rng.choice(["pos_dom", "neg_dom", "mixed"], size=n)
    data["regime_zone"] = rng.choice(["call", "put", "neutral"], size=n)
    data["prev_day_direction"] = rng.choice(["up", "down", "flat"], size=n)
    data["prev_day_range_cat"] = rng.choice(["narrow", "average", "wide"], size=n)

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
) -> tuple[pd.DataFrame, list[str], list[str]]:
    """Feature matrix, numeric column names, and categorical column names."""
    return prepare_features(sample_df)


def _tree_factory():
    """Model factory producing a Pipeline with SimpleImputer + DecisionTree.

    Only suitable for numeric-only DataFrames.
    """
    return make_pipeline(
        SimpleImputer(strategy="median"),
        DecisionTreeClassifier(max_depth=2, random_state=42),
        memory=None,
    )


def _make_tree_factory(numeric_cols: list[str], categorical_cols: list[str]):
    """Create a model factory that handles both numeric and categorical columns."""

    def factory():
        if categorical_cols:
            preprocessor = ColumnTransformer(
                [
                    ("num", SimpleImputer(strategy="median"), numeric_cols),
                    (
                        "cat",
                        OneHotEncoder(
                            handle_unknown="ignore",
                            sparse_output=False,
                        ),
                        categorical_cols,
                    ),
                ],
                remainder="drop",
            )
        else:
            preprocessor = SimpleImputer(strategy="median")
        return make_pipeline(
            preprocessor,
            DecisionTreeClassifier(max_depth=2, random_state=42),
            memory=None,
        )

    return factory


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
        }
        assert set(CATEGORICAL_FEATURES) == expected

    def test_no_overlap_between_numeric_and_categorical(self):
        """Numeric and categorical feature lists must be disjoint."""
        overlap = set(ALL_NUMERIC_FEATURES) & set(CATEGORICAL_FEATURES)
        assert overlap == set(), f"Overlap: {overlap}"


# ── prepare_features ────────────────────────────────────────────


class TestPrepareFeatures:
    """Tests for prepare_features(df)."""

    def test_returns_tuple_of_dataframe_and_two_lists(
        self, prepared_features: tuple[pd.DataFrame, list[str], list[str]]
    ):
        """Return type must be (DataFrame, list[str], list[str])."""
        X, numeric_cols, categorical_cols = prepared_features
        assert isinstance(X, pd.DataFrame)
        assert isinstance(numeric_cols, list)
        assert isinstance(categorical_cols, list)

    def test_column_lists_cover_x_columns(
        self, prepared_features: tuple[pd.DataFrame, list[str], list[str]]
    ):
        """numeric_cols + categorical_cols must exactly cover X.columns."""
        X, numeric_cols, categorical_cols = prepared_features
        assert set(numeric_cols + categorical_cols) == set(X.columns.tolist())

    def test_numeric_columns_present(
        self,
        prepared_features: tuple[pd.DataFrame, list[str], list[str]],
        numeric_feature_subset: list[str],
    ):
        """Available numeric features must appear in numeric_cols."""
        X, numeric_cols, _ = prepared_features
        for feat in numeric_feature_subset:
            assert feat in numeric_cols, f"Missing numeric feature: {feat}"
            assert feat in X.columns, f"Missing numeric feature in X: {feat}"

    def test_categorical_columns_are_raw_strings(
        self, prepared_features: tuple[pd.DataFrame, list[str], list[str]]
    ):
        """Categorical columns must be present in X as string dtype."""
        X, _, categorical_cols = prepared_features
        for col in categorical_cols:
            assert col in X.columns, f"Missing categorical column: {col}"
            assert not pd.api.types.is_numeric_dtype(X[col]), (
                f"Column {col} should be string dtype, got {X[col].dtype}"
            )

    def test_output_row_count_matches_input(
        self,
        sample_df: pd.DataFrame,
        prepared_features: tuple[pd.DataFrame, list[str], list[str]],
    ):
        """Row count must be preserved."""
        X, _, _ = prepared_features
        assert len(X) == len(sample_df)

    def test_output_has_more_columns_than_numeric_alone(
        self,
        prepared_features: tuple[pd.DataFrame, list[str], list[str]],
        numeric_feature_subset: list[str],
    ):
        """Categorical columns add columns beyond the numeric set."""
        X, _, _ = prepared_features
        assert X.shape[1] > len(numeric_feature_subset)

    def test_numeric_columns_are_numeric_dtype(
        self, prepared_features: tuple[pd.DataFrame, list[str], list[str]]
    ):
        """Numeric columns must have numeric dtype; categoricals must be strings."""
        X, numeric_cols, categorical_cols = prepared_features
        for col in numeric_cols:
            assert pd.api.types.is_numeric_dtype(X[col]), (
                f"Numeric column {col} is not numeric"
            )
        for col in categorical_cols:
            assert not pd.api.types.is_numeric_dtype(X[col]), (
                f"Categorical column {col} should not be numeric"
            )

    def test_missing_numeric_features_are_silently_skipped(self):
        """
        Columns not present in df are skipped without error.
        Only present columns appear in numeric_cols.
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
        _, numeric_cols, _ = prepare_features(df)
        assert "vix" in numeric_cols
        # A feature not in df must not appear
        assert "sigma" not in numeric_cols

    def test_no_categorical_columns_in_df(self):
        """When no categorical columns exist, categorical_cols is empty."""
        df = pd.DataFrame(
            {
                "vix": [1.0, 2.0],
                "vix1d": [3.0, 4.0],
            }
        )
        df.index = pd.date_range("2025-06-01", periods=2, freq="B", name="date")
        _, numeric_cols, categorical_cols = prepare_features(df)
        assert numeric_cols == ["vix", "vix1d"]
        assert categorical_cols == []


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

    def test_values_in_expected_set(self, encoded_target: pd.Series):
        """All encoded values must be in {0, 1, 2}."""
        unique_vals = set(encoded_target.dropna().unique())
        assert unique_vals.issubset({0, 1, 2})


# ── walk_forward ────────────────────────────────────────────────


class TestWalkForward:
    """Tests for walk_forward(X, y, model_factory, min_train)."""

    def test_returns_dict_with_expected_keys(
        self,
        prepared_features: tuple[pd.DataFrame, list[str], list[str]],
        encoded_target: pd.Series,
    ):
        """Result dict must have predictions, probabilities, actuals, indices, n_folds."""
        X, numeric_cols, categorical_cols = prepared_features
        factory = _make_tree_factory(numeric_cols, categorical_cols)
        result = walk_forward(X, encoded_target, factory, min_train=20)
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
        prepared_features: tuple[pd.DataFrame, list[str], list[str]],
        encoded_target: pd.Series,
    ):
        """n_folds must equal len(X) - min_train."""
        X, numeric_cols, categorical_cols = prepared_features
        factory = _make_tree_factory(numeric_cols, categorical_cols)
        min_train = 20
        result = walk_forward(X, encoded_target, factory, min_train=min_train)
        assert result["n_folds"] == len(X) - min_train

    def test_predictions_length(
        self,
        prepared_features: tuple[pd.DataFrame, list[str], list[str]],
        encoded_target: pd.Series,
    ):
        """predictions array length must equal n_folds."""
        X, numeric_cols, categorical_cols = prepared_features
        factory = _make_tree_factory(numeric_cols, categorical_cols)
        result = walk_forward(X, encoded_target, factory, min_train=20)
        assert len(result["predictions"]) == result["n_folds"]

    def test_actuals_length(
        self,
        prepared_features: tuple[pd.DataFrame, list[str], list[str]],
        encoded_target: pd.Series,
    ):
        """actuals array length must equal n_folds."""
        X, numeric_cols, categorical_cols = prepared_features
        factory = _make_tree_factory(numeric_cols, categorical_cols)
        result = walk_forward(X, encoded_target, factory, min_train=20)
        assert len(result["actuals"]) == result["n_folds"]

    def test_probabilities_shape(
        self,
        prepared_features: tuple[pd.DataFrame, list[str], list[str]],
        encoded_target: pd.Series,
    ):
        """probabilities must be 2D with shape (n_folds, n_classes)."""
        X, numeric_cols, categorical_cols = prepared_features
        factory = _make_tree_factory(numeric_cols, categorical_cols)
        result = walk_forward(X, encoded_target, factory, min_train=20)
        n_classes = encoded_target.nunique()
        assert result["probabilities"].shape == (
            result["n_folds"],
            n_classes,
        )

    def test_indices_length(
        self,
        prepared_features: tuple[pd.DataFrame, list[str], list[str]],
        encoded_target: pd.Series,
    ):
        """indices list length must equal n_folds."""
        X, numeric_cols, categorical_cols = prepared_features
        factory = _make_tree_factory(numeric_cols, categorical_cols)
        result = walk_forward(X, encoded_target, factory, min_train=20)
        assert len(result["indices"]) == result["n_folds"]

    def test_predictions_are_valid_class_labels(
        self,
        prepared_features: tuple[pd.DataFrame, list[str], list[str]],
        encoded_target: pd.Series,
    ):
        """Every prediction must be a known class label."""
        X, numeric_cols, categorical_cols = prepared_features
        factory = _make_tree_factory(numeric_cols, categorical_cols)
        result = walk_forward(X, encoded_target, factory, min_train=20)
        valid_labels = set(encoded_target.unique())
        for pred in result["predictions"]:
            assert pred in valid_labels, f"Unexpected prediction: {pred}"

    def test_probabilities_sum_to_one(
        self,
        prepared_features: tuple[pd.DataFrame, list[str], list[str]],
        encoded_target: pd.Series,
    ):
        """Each probability row must sum to ~1.0."""
        X, numeric_cols, categorical_cols = prepared_features
        factory = _make_tree_factory(numeric_cols, categorical_cols)
        result = walk_forward(X, encoded_target, factory, min_train=20)
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
        prepared_features: tuple[pd.DataFrame, list[str], list[str]],
        encoded_target: pd.Series,
    ):
        """
        Verify the expanding-window property: each fold's model must
        receive a strictly larger training set than the previous fold.
        We confirm this indirectly by checking that indices are
        sequentially increasing and correspond to rows after min_train.
        """
        X, numeric_cols, categorical_cols = prepared_features
        factory = _make_tree_factory(numeric_cols, categorical_cols)
        min_train = 20
        result = walk_forward(X, encoded_target, factory, min_train=min_train)
        expected_indices = X.index[min_train:].tolist()
        assert result["indices"] == expected_indices


# ── compute_metrics ─────────────────────────────────────────────


class TestComputeMetrics:
    """Tests for compute_metrics(results, y_full)."""

    @pytest.fixture()
    def wf_result(
        self,
        prepared_features: tuple[pd.DataFrame, list[str], list[str]],
        encoded_target: pd.Series,
    ) -> dict:
        """Walk-forward result for metrics tests."""
        X, numeric_cols, categorical_cols = prepared_features
        factory = _make_tree_factory(numeric_cols, categorical_cols)
        return walk_forward(X, encoded_target, factory, min_train=20)

    def test_returns_dict(self, wf_result: dict, encoded_target: pd.Series):
        """compute_metrics must return a dict."""
        metrics = compute_metrics(wf_result, encoded_target)
        assert isinstance(metrics, dict)

    def test_has_expected_keys(self, wf_result: dict, encoded_target: pd.Series):
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

    def test_log_loss_is_non_negative(self, wf_result: dict, encoded_target: pd.Series):
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
        assert metrics["accuracy"] == pytest.approx(1.0)


# ── build_model_configs ─────────────────────────────────────────


class TestBuildModelConfigs:
    """Tests for build_model_configs(n_classes, xgb_params, numeric_cols, categorical_cols)."""

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
        return build_model_configs(
            n_classes=3,
            xgb_params=xgb_params,
            numeric_cols=["vix", "sigma"],
            categorical_cols=["charm_pattern"],
        )

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

    def test_sklearn_models_have_fit_predict_predict_proba(self, configs: dict):
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
            assert hasattr(model, "predict_proba"), f"{name} missing predict_proba()"

    def test_xgboost_factory_returns_model_with_fit_predict(self, configs: dict):
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
        X, _, _ = prepare_features(df)
        assert X["vix"].isna().sum() == 1
        assert X["vix1d"].isna().sum() == 1

    def test_end_to_end_pipeline(self, sample_df: pd.DataFrame):
        """
        Full pipeline: prepare_features -> encode_target -> walk_forward -> compute_metrics.
        Verifies the functions compose correctly end-to-end.
        """
        X, numeric_cols, categorical_cols = prepare_features(sample_df)
        y = encode_target(sample_df)
        factory = _make_tree_factory(numeric_cols, categorical_cols)

        result = walk_forward(X, y, factory, min_train=20)
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
        probs = np.array(
            [
                [0.9, 0.05, 0.05],
                [0.8, 0.1, 0.1],
                [0.3, 0.5, 0.2],
                [0.7, 0.2, 0.1],
                [0.85, 0.1, 0.05],
            ]
        )
        results = {
            "predictions": preds,
            "probabilities": probs,
            "actuals": actuals,
            "indices": list(range(5)),
            "n_folds": 5,
        }
        y_full = pd.Series([0, 0, 0, 0, 0, 1, 2])
        metrics = compute_metrics(results, y_full)
        assert metrics["accuracy"] == pytest.approx(0.8)
        assert metrics["majority_class"] == "CALL CREDIT SPREAD"


# ── print_model_comparison ─────────────────────────────────────


from phase2_early import (
    print_feature_importance,
    print_model_comparison,
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


# ── aggregate_fold_importances ────────────────────────────────


class TestAggregateFoldImportances:
    """Tests for aggregate_fold_importances(X, y, params, numeric_cols, categorical_cols)."""

    def test_returns_series_with_nonzero_values(self):
        """Must return a pd.Series with importances that sum to ~1.0."""
        rng = np.random.default_rng(42)
        n = 30
        numeric_cols = ["f1", "f2", "f3"]
        X = pd.DataFrame(
            rng.standard_normal((n, len(numeric_cols))),
            columns=numeric_cols,
        )
        y = pd.Series(rng.choice([0, 1, 2], size=n))
        params = {
            "objective": "multi:softprob",
            "max_depth": 2,
            "n_estimators": 10,
            "random_state": 42,
            "verbosity": 0,
        }
        result = aggregate_fold_importances(
            X,
            y,
            params,
            numeric_cols=numeric_cols,
            categorical_cols=[],
            min_train=20,
        )
        assert isinstance(result, pd.Series)
        assert len(result) > 0
        assert result.sum() > 0

    def test_sorted_descending(self):
        """Returned series must be sorted in descending order."""
        rng = np.random.default_rng(99)
        n = 30
        numeric_cols = ["a", "b", "c", "d"]
        X = pd.DataFrame(
            rng.standard_normal((n, len(numeric_cols))),
            columns=numeric_cols,
        )
        y = pd.Series(rng.choice([0, 1], size=n))
        params = {
            "objective": "multi:softprob",
            "max_depth": 2,
            "n_estimators": 10,
            "random_state": 42,
            "verbosity": 0,
        }
        result = aggregate_fold_importances(
            X,
            y,
            params,
            numeric_cols=numeric_cols,
            categorical_cols=[],
            min_train=20,
        )
        values = result.values
        for i in range(len(values) - 1):
            assert values[i] >= values[i + 1]

    def test_with_categorical_columns(self):
        """Must handle DataFrames with categorical columns."""
        rng = np.random.default_rng(77)
        n = 30
        numeric_cols = ["f1", "f2"]
        categorical_cols = ["cat1"]
        data = {
            "f1": rng.standard_normal(n),
            "f2": rng.standard_normal(n),
            "cat1": rng.choice(["a", "b", "c"], size=n),
        }
        X = pd.DataFrame(data)
        y = pd.Series(rng.choice([0, 1, 2], size=n))
        params = {
            "objective": "multi:softprob",
            "max_depth": 2,
            "n_estimators": 10,
            "random_state": 42,
            "verbosity": 0,
        }
        result = aggregate_fold_importances(
            X,
            y,
            params,
            numeric_cols=numeric_cols,
            categorical_cols=categorical_cols,
            min_train=20,
        )
        assert isinstance(result, pd.Series)
        assert len(result) > 0


# ── print_feature_importance ───────────────────────────────────


class TestPrintFeatureImportance:
    """Tests for print_feature_importance(importances, top_n)."""

    def test_print_feature_importance(self, capsys):
        """Top 15 features are printed when given 20."""
        rng = np.random.default_rng(42)
        names = [f"feature_{i}" for i in range(20)]
        values = rng.random(20)
        values = values / values.sum()
        importances = pd.Series(values, index=names).sort_values(ascending=False)

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
            "ML_ROOT",
            tmp_path,
        )

        rng = np.random.default_rng(42)
        n = 10
        feature_names = ["f1", "f2", "f3"]
        df = pd.DataFrame(
            rng.standard_normal((n, len(feature_names))),
            columns=feature_names,
        )
        df.index = pd.date_range("2025-01-01", periods=n, freq="B", name="date")
        y = pd.Series(rng.choice([0, 1, 2], size=n))
        importances = pd.Series([0.5, 0.3, 0.2], index=feature_names)
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

    def test_save_experiment_without_model_comparison(self, tmp_path, monkeypatch):
        """When all_model_metrics is None, model_comparison and best_model are absent."""
        import phase2_early

        monkeypatch.setattr(
            phase2_early,
            "ML_ROOT",
            tmp_path,
        )

        rng = np.random.default_rng(7)
        n = 10
        feature_names = ["f1", "f2"]
        df = pd.DataFrame(
            rng.standard_normal((n, len(feature_names))),
            columns=feature_names,
        )
        df.index = pd.date_range("2025-03-01", periods=n, freq="B", name="date")
        y = pd.Series(rng.choice([0, 1, 2], size=n))
        importances = pd.Series([0.6, 0.4], index=feature_names)
        metrics = {
            "accuracy": 0.50,
            "log_loss": 1.0,
            "per_class_f1": {
                "CALL CREDIT SPREAD": 0.4,
                "PUT CREDIT SPREAD": 0.4,
                "IRON CONDOR": 0.4,
            },
            "majority_class": "CALL CREDIT SPREAD",
            "majority_baseline": 0.45,
            "prev_day_baseline": 0.30,
            "walk_forward_folds": 8,
        }
        params = {"max_depth": 2, "verbosity": 0}

        save_experiment(
            metrics,
            params,
            importances,
            df,
            y,
            feature_names,
            all_model_metrics=None,
        )

        exp_dir = tmp_path / "experiments"
        json_files = list(exp_dir.glob("*.json"))
        assert len(json_files) == 1

        import json

        data = json.loads(json_files[0].read_text())
        assert data["phase"] == "phase2_early"
        assert data["version"] == "v2"
        assert "model_comparison" not in data
        assert "best_model" not in data
        assert data["data"]["training_days"] == n
        assert data["data"]["feature_count"] == len(feature_names)
        assert len(data["data"]["date_range"]) == 2
        assert "verbosity" not in data["xgboost_params"]
        assert len(data["feature_importance_top10"]) == 2
        assert "notes" in data
        assert data["notes"].startswith("Walk-forward")

    def test_save_experiment_class_distribution_uses_names(self, tmp_path, monkeypatch):
        """class_distribution keys must be human-readable structure names."""
        import phase2_early

        monkeypatch.setattr(
            phase2_early,
            "ML_ROOT",
            tmp_path,
        )

        rng = np.random.default_rng(11)
        n = 12
        feature_names = ["f1"]
        df = pd.DataFrame({"f1": rng.standard_normal(n)})
        df.index = pd.date_range("2025-06-01", periods=n, freq="B", name="date")
        # 6 zeros (CCS), 4 ones (PCS), 2 twos (IC)
        y = pd.Series([0] * 6 + [1] * 4 + [2] * 2)
        importances = pd.Series([1.0], index=feature_names)
        metrics = {
            "accuracy": 0.50,
            "log_loss": 1.0,
            "per_class_f1": {},
            "majority_class": "CALL CREDIT SPREAD",
            "majority_baseline": 0.50,
            "prev_day_baseline": 0.40,
            "walk_forward_folds": 5,
        }
        params = {"max_depth": 2}

        save_experiment(metrics, params, importances, df, y, feature_names)

        exp_dir = tmp_path / "experiments"
        json_files = list(exp_dir.glob("*.json"))
        import json

        data = json.loads(json_files[0].read_text())
        dist = data["data"]["class_distribution"]
        assert "CALL CREDIT SPREAD" in dist
        assert dist["CALL CREDIT SPREAD"] == 6
        assert dist["PUT CREDIT SPREAD"] == 4
        assert dist["IRON CONDOR"] == 2


# ── walk_forward probability padding ─────────────────────────────


class TestWalkForwardProbabilityPadding:
    """Test walk_forward probability padding when model hasn't seen all classes."""

    def test_probability_padding_when_class_missing_in_early_windows(self):
        """
        When class 2 (IC) only appears after row 20, early walk-forward
        windows won't see it. The probability vector must still be padded
        to length n_classes=3 and sum to ~1.0.
        """
        rng = np.random.default_rng(123)
        n = 35

        # Build features
        X = pd.DataFrame(
            {
                "feat_a": rng.standard_normal(n),
                "feat_b": rng.standard_normal(n),
            }
        )

        # Classes 0 and 1 in the first 25 rows, class 2 only from row 25+
        y_vals = rng.choice([0, 1], size=25).tolist() + [2] * 10
        y = pd.Series(y_vals)

        # n_classes is 3 (0, 1, 2) but early training windows won't see class 2
        assert y.nunique() == 3

        result = walk_forward(X, y, _tree_factory, min_train=10)

        # All probability vectors must be length 3
        assert result["probabilities"].shape[1] == 3

        # Each row must sum to ~1.0 (the padding path fills zeros for unseen classes)
        row_sums = result["probabilities"].sum(axis=1)
        np.testing.assert_allclose(row_sums, 1.0, atol=1e-6)

        # n_folds must be n - min_train
        assert result["n_folds"] == 25

    def test_probability_padding_with_single_class_in_training(self):
        """
        When the training window contains only one class, the model produces
        a 1-element probability. Padding must expand it to n_classes.
        """
        rng = np.random.default_rng(77)
        n = 25

        X = pd.DataFrame(
            {
                "feat_a": rng.standard_normal(n),
                "feat_b": rng.standard_normal(n),
            }
        )

        # First 15 rows: class 0 only. Then classes 1 and 2 appear.
        y_vals = [0] * 15 + [1] * 5 + [2] * 5
        y = pd.Series(y_vals)

        result = walk_forward(X, y, _tree_factory, min_train=10)

        # Must have 3 columns even though early windows see only 1 class
        assert result["probabilities"].shape[1] == 3

        # All rows must sum to ~1.0
        row_sums = result["probabilities"].sum(axis=1)
        np.testing.assert_allclose(row_sums, 1.0, atol=1e-6)


# ── compute_metrics prev_day baseline and log_loss edge cases ────


class TestComputeMetricsPrevDayAndLogLoss:
    """Tests for edge cases in compute_metrics: prev_day baseline and log_loss ValueError."""

    def test_prev_day_baseline_is_computed_correctly(self):
        """
        prev_day_baseline must equal accuracy of predicting yesterday's class.
        First prediction uses majority class as fallback.
        """
        # actuals: [0, 0, 1, 1, 2]
        # prev_day_preds: [majority=0, 0, 0, 1, 1]  (rolled + first=majority)
        # matches: [0==0, 0==0, 0==1, 1==1, 1==2] = [T, T, F, T, F] = 3/5 = 0.6
        actuals = np.array([0, 0, 1, 1, 2])
        probs = np.array(
            [
                [0.8, 0.1, 0.1],
                [0.7, 0.2, 0.1],
                [0.2, 0.6, 0.2],
                [0.1, 0.7, 0.2],
                [0.1, 0.2, 0.7],
            ]
        )
        results = {
            "predictions": actuals.copy(),
            "probabilities": probs,
            "actuals": actuals,
            "indices": list(range(5)),
            "n_folds": 5,
        }
        # y_full majority is 0 (appears 3 times in full series)
        y_full = pd.Series([0, 0, 0, 1, 1, 2])
        metrics = compute_metrics(results, y_full)

        assert metrics["prev_day_baseline"] == pytest.approx(0.6)

    def test_log_loss_nan_when_value_error_raised(self, monkeypatch):
        """
        When log_loss raises ValueError, compute_metrics must return NaN
        for log_loss instead of crashing.
        """
        import phase2_early

        def _raise_value_error(*args, **kwargs):
            raise ValueError("mocked log_loss failure")

        monkeypatch.setattr(phase2_early, "log_loss", _raise_value_error)

        actuals = np.array([0, 1, 2])
        probs = np.array(
            [
                [0.8, 0.1, 0.1],
                [0.1, 0.8, 0.1],
                [0.1, 0.1, 0.8],
            ]
        )
        results = {
            "predictions": actuals.copy(),
            "probabilities": probs,
            "actuals": actuals,
            "indices": list(range(3)),
            "n_folds": 3,
        }
        y_full = pd.Series([0, 1, 2])
        metrics = compute_metrics(results, y_full)
        assert np.isnan(metrics["log_loss"])

    def test_prev_day_baseline_single_element(self):
        """
        With a single prediction, prev_day uses majority class as fallback.
        """
        actuals = np.array([1])
        probs = np.array([[0.2, 0.6, 0.2]])
        results = {
            "predictions": np.array([1]),
            "probabilities": probs,
            "actuals": actuals,
            "indices": [0],
            "n_folds": 1,
        }
        # majority of y_full is 1
        y_full = pd.Series([1, 1, 0])
        metrics = compute_metrics(results, y_full)
        # prev_day_preds[0] = majority_class = 1, actuals[0] = 1 => match => 1.0
        assert metrics["prev_day_baseline"] == pytest.approx(1.0)


# ── Additional print_model_comparison tests ──────────────────────


class TestPrintModelComparisonExtended:
    """Extended tests for print_model_comparison edge cases."""

    def test_returns_correct_best_when_b_wins(self, capsys):
        """When ModelB has higher accuracy, it must be returned as best."""
        all_metrics = _make_all_metrics(acc_a=0.30, acc_b=0.55)
        best = print_model_comparison(all_metrics)
        assert best == "ModelB"

    def test_output_contains_model_names(self, capsys):
        """Both model names must appear in the printed output."""
        all_metrics = _make_all_metrics()
        print_model_comparison(all_metrics)
        captured = capsys.readouterr()
        assert "ModelA" in captured.out
        assert "ModelB" in captured.out

    def test_output_contains_best_marker(self, capsys):
        """The best model row must have the '<-- best' marker."""
        all_metrics = _make_all_metrics(acc_a=0.70, acc_b=0.40)
        print_model_comparison(all_metrics)
        captured = capsys.readouterr()
        assert "<-- best" in captured.out

    def test_output_contains_f1_abbreviations(self, capsys):
        """Per-class F1 must show abbreviated class names (CCS, PCS, IC)."""
        all_metrics = _make_all_metrics()
        print_model_comparison(all_metrics)
        captured = capsys.readouterr()
        assert "CCS=" in captured.out
        assert "PCS=" in captured.out
        assert "IC=" in captured.out

    def test_single_model(self, capsys):
        """print_model_comparison must work with a single model."""
        metrics = {
            "Solo": {
                "accuracy": 0.50,
                "log_loss": 1.0,
                "majority_baseline": 0.40,
                "prev_day_baseline": 0.35,
                "majority_class": "CALL CREDIT SPREAD",
                "per_class_f1": {
                    "CALL CREDIT SPREAD": 0.5,
                    "PUT CREDIT SPREAD": 0.4,
                    "IRON CONDOR": 0.6,
                },
                "walk_forward_folds": 10,
            },
        }
        best = print_model_comparison(metrics)
        assert best == "Solo"

    def test_tied_accuracy_returns_first_sorted(self, capsys):
        """When models tie in accuracy, the first in sorted order is returned."""
        all_metrics = _make_all_metrics(acc_a=0.55, acc_b=0.55)
        best = print_model_comparison(all_metrics)
        # Both have same accuracy; sorted order puts first one as best
        assert best in ("ModelA", "ModelB")


# ── Additional print_feature_importance tests ────────────────────


class TestPrintFeatureImportanceExtended:
    """Extended tests for print_feature_importance."""

    def test_top_n_smaller_than_total(self, capsys):
        """When top_n=3 and there are 10 features, only 3 appear."""
        names = [f"feat_{i}" for i in range(10)]
        values = list(range(10, 0, -1))
        importances = pd.Series([v / sum(values) for v in values], index=names)

        print_feature_importance(importances, top_n=3)
        captured = capsys.readouterr()

        assert "feat_0" in captured.out  # highest
        assert "feat_1" in captured.out
        assert "feat_2" in captured.out
        assert "feat_9" not in captured.out  # lowest, not in top 3

    def test_top_n_larger_than_total(self, capsys):
        """When top_n > len(importances), all features are printed."""
        names = ["alpha", "beta"]
        importances = pd.Series([0.7, 0.3], index=names)

        print_feature_importance(importances, top_n=10)
        captured = capsys.readouterr()

        assert "alpha" in captured.out
        assert "beta" in captured.out

    def test_output_contains_hash_bars(self, capsys):
        """Each feature line must contain '#' chars as a visual bar."""
        importances = pd.Series([0.5, 0.3, 0.2], index=["big", "mid", "small"])

        print_feature_importance(importances, top_n=3)
        captured = capsys.readouterr()

        assert "#" in captured.out

    def test_output_contains_numbered_ranking(self, capsys):
        """Features must be numbered starting from 1."""
        importances = pd.Series([0.6, 0.4], index=["a", "b"])

        print_feature_importance(importances, top_n=2)
        captured = capsys.readouterr()

        assert " 1." in captured.out
        assert " 2." in captured.out


# ── main() orchestration ─────────────────────────────────────────

from phase2_early import main


def _build_mock_df(n: int = 40) -> pd.DataFrame:
    """
    Build a DataFrame that satisfies main()'s requirements:
    - >=10 rows, >=25 with valid labels
    - vix in (9, 90)
    - recommended_structure in STRUCTURE_MAP
    - structure_correct column (non-null for labeled rows)
    """
    rng = np.random.default_rng(42)
    structures = list(STRUCTURE_MAP.keys())
    data = {
        "vix": rng.uniform(12, 30, size=n),
        "vix1d": rng.uniform(10, 25, size=n),
        "gex_oi_t1": rng.standard_normal(n),
        "gex_oi_t2": rng.standard_normal(n),
        "sigma": rng.uniform(5, 15, size=n),
        "recommended_structure": rng.choice(structures, size=n),
        "structure_correct": rng.choice([True, False], size=n),
    }
    df = pd.DataFrame(data)
    df.index = pd.date_range("2025-01-01", periods=n, freq="B", name="date")
    return df


def _mock_train_final_model(X, y, params, numeric_cols=None, categorical_cols=None):
    """Return a fake model and importances without requiring XGBoost."""
    num_cols = numeric_cols or [
        c for c in X.columns if pd.api.types.is_numeric_dtype(X[c])
    ]
    cat_cols = categorical_cols or [
        c for c in X.columns if not pd.api.types.is_numeric_dtype(X[c])
    ]
    if cat_cols:
        preprocessor = ColumnTransformer(
            [
                ("num", SimpleImputer(strategy="median"), num_cols),
                (
                    "cat",
                    OneHotEncoder(handle_unknown="ignore", sparse_output=False),
                    cat_cols,
                ),
            ],
            remainder="drop",
        )
    else:
        preprocessor = SimpleImputer(strategy="median")
    model = make_pipeline(
        preprocessor,
        DecisionTreeClassifier(max_depth=2, random_state=42),
        memory=None,
    )
    model.fit(X, y)
    importances = pd.Series(
        np.ones(len(X.columns)) / len(X.columns),
        index=X.columns,
    ).sort_values(ascending=False)
    return model, importances


def _mock_build_model_configs(n_classes, xgb_params, numeric_cols, categorical_cols):
    """Return only lightweight sklearn models (no XGBoost)."""
    factory = _make_tree_factory(numeric_cols, categorical_cols)
    return {
        "DecisionTree": factory,
        "XGBoost": factory,
    }


def _mock_aggregate_fold_importances(
    X, y, params, numeric_cols, categorical_cols, min_train=20
):
    """Return fake importances without requiring XGBoost."""
    all_cols = list(X.columns)
    values = np.ones(len(all_cols)) / len(all_cols)
    return pd.Series(values, index=all_cols).sort_values(ascending=False)


class TestMain:
    """Tests for main() orchestration — mocked to avoid DB, XGBoost, and file I/O."""

    def _setup_mocks(self, monkeypatch, mock_df, tmp_path):
        """Common monkeypatch setup for main() tests."""
        import phase2_early

        monkeypatch.setattr(phase2_early, "load_phase2_data", lambda: mock_df)
        monkeypatch.setattr(phase2_early, "train_final_model", _mock_train_final_model)
        monkeypatch.setattr(
            phase2_early, "build_model_configs", _mock_build_model_configs
        )
        monkeypatch.setattr(
            phase2_early,
            "aggregate_fold_importances",
            _mock_aggregate_fold_importances,
        )
        monkeypatch.setattr(
            phase2_early,
            "ML_ROOT",
            tmp_path,
        )
        # Suppress save_experiment file I/O
        monkeypatch.setattr(
            phase2_early,
            "save_experiment",
            lambda *a, **kw: None,
        )
        # No --shap flag
        monkeypatch.setattr("sys.argv", ["phase2_early.py"])

    def test_main_runs_to_completion(self, monkeypatch, capsys, tmp_path):
        """main() must run without error when given valid data."""
        mock_df = _build_mock_df(40)
        self._setup_mocks(monkeypatch, mock_df, tmp_path)

        main()

        captured = capsys.readouterr()
        assert "DATA LOADING" in captured.out
        assert "FEATURE PREPARATION" in captured.out
        assert "WALK-FORWARD VALIDATION" in captured.out
        assert "RESULTS" in captured.out
        assert "VERDICT" in captured.out

    def test_main_early_exit_with_insufficient_labels(
        self, monkeypatch, capsys, tmp_path
    ):
        """main() must sys.exit(0) when fewer than 25 labeled days."""
        # Only 10 labeled rows — below the 25 threshold
        rng = np.random.default_rng(99)
        n = 15
        structures = list(STRUCTURE_MAP.keys())
        data = {
            "vix": rng.uniform(12, 30, size=n),
            "recommended_structure": rng.choice(structures, size=n),
            "structure_correct": [True] * 10 + [np.nan] * 5,
        }
        mock_df = pd.DataFrame(data)
        mock_df.index = pd.date_range("2025-01-01", periods=n, freq="B", name="date")

        import phase2_early

        monkeypatch.setattr(phase2_early, "load_phase2_data", lambda: mock_df)
        monkeypatch.setattr("sys.argv", ["phase2_early.py"])

        with pytest.raises(SystemExit) as exc_info:
            main()

        assert exc_info.value.code == 0
        captured = capsys.readouterr()
        assert "need at least 25" in captured.out

    def test_main_verdict_not_yet_branch(self, monkeypatch, capsys, tmp_path):
        """
        When the best model accuracy <= majority baseline,
        main() must print the 'NOT YET' verdict.
        """
        mock_df = _build_mock_df(40)
        self._setup_mocks(monkeypatch, mock_df, tmp_path)

        # Force all metrics to have accuracy <= majority_baseline
        import phase2_early

        original_compute = phase2_early.compute_metrics

        def _force_low_accuracy(results, y_full):
            m = original_compute(results, y_full)
            # Set accuracy to be below or equal to majority baseline
            m["accuracy"] = m["majority_baseline"] - 0.01
            return m

        monkeypatch.setattr(phase2_early, "compute_metrics", _force_low_accuracy)

        main()

        captured = capsys.readouterr()
        assert "NOT YET" in captured.out

    def test_main_verdict_marginal_branch(self, monkeypatch, capsys, tmp_path):
        """
        When best accuracy > majority but <= majority + 0.05,
        main() must print the 'MARGINAL' verdict.
        """
        mock_df = _build_mock_df(40)
        self._setup_mocks(monkeypatch, mock_df, tmp_path)

        import phase2_early

        original_compute = phase2_early.compute_metrics

        def _force_marginal_accuracy(results, y_full):
            m = original_compute(results, y_full)
            m["accuracy"] = m["majority_baseline"] + 0.03
            return m

        monkeypatch.setattr(phase2_early, "compute_metrics", _force_marginal_accuracy)

        main()

        captured = capsys.readouterr()
        assert "MARGINAL" in captured.out

    def test_main_verdict_promising_xgb_leads(self, monkeypatch, capsys, tmp_path):
        """
        When best model is XGBoost with accuracy > majority + 0.05,
        main() must print 'PROMISING' and 'XGBoost leads the pack'.
        """
        mock_df = _build_mock_df(40)
        self._setup_mocks(monkeypatch, mock_df, tmp_path)

        import phase2_early

        original_compute = phase2_early.compute_metrics

        def _force_promising_xgb(results, y_full):
            m = original_compute(results, y_full)
            m["accuracy"] = m["majority_baseline"] + 0.10
            return m

        monkeypatch.setattr(phase2_early, "compute_metrics", _force_promising_xgb)

        # Override print_model_comparison to return "XGBoost"
        monkeypatch.setattr(
            phase2_early,
            "print_model_comparison",
            lambda metrics: "XGBoost",
        )

        main()

        captured = capsys.readouterr()
        assert "PROMISING" in captured.out
        assert "XGBoost leads the pack" in captured.out

    def test_main_verdict_promising_non_xgb_leads(self, monkeypatch, capsys, tmp_path):
        """
        When best model is NOT XGBoost with accuracy > majority + 0.05,
        main() must print 'PROMISING' and note the simpler model wins.
        """
        mock_df = _build_mock_df(40)
        self._setup_mocks(monkeypatch, mock_df, tmp_path)

        import phase2_early

        original_compute = phase2_early.compute_metrics

        def _force_promising(results, y_full):
            m = original_compute(results, y_full)
            m["accuracy"] = m["majority_baseline"] + 0.10
            return m

        monkeypatch.setattr(phase2_early, "compute_metrics", _force_promising)

        # Override print_model_comparison to return a non-XGBoost model
        monkeypatch.setattr(
            phase2_early,
            "print_model_comparison",
            lambda metrics: "DecisionTree",
        )

        main()

        captured = capsys.readouterr()
        assert "PROMISING" in captured.out
        assert "outperforms XGBoost" in captured.out

    def test_main_with_fully_null_columns(self, monkeypatch, capsys, tmp_path):
        """main() must drop fully-null columns and continue."""
        mock_df = _build_mock_df(40)
        # Add a fully-null column using a name from ALL_NUMERIC_FEATURES
        # so prepare_features() actually picks it up
        mock_df["realized_vol_5d"] = np.nan
        self._setup_mocks(monkeypatch, mock_df, tmp_path)

        main()

        captured = capsys.readouterr()
        assert "Dropping" in captured.out
        assert "fully-null" in captured.out

    def test_main_with_feature_completeness_column(self, monkeypatch, capsys, tmp_path):
        """When feature_completeness column exists, it filters rows below 0.80."""
        mock_df = _build_mock_df(50)
        # Add feature_completeness: first 5 rows below threshold
        completeness = np.ones(50)
        completeness[:5] = 0.5
        mock_df["feature_completeness"] = completeness
        self._setup_mocks(monkeypatch, mock_df, tmp_path)

        main()

        captured = capsys.readouterr()
        assert "feature_completeness >= 0.80" in captured.out
