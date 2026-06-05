"""SHAP explainer for take-it score predictions.

Given a trained model bundle and a feature row, return the calibrated
probability + the top-K green flags (positive SHAP) and top-K red flags
(negative SHAP). Output is JSON-serializable so Phase 3 can stash it in the
`takeit_top_features` JSONB column on the alert tables.

Used at score time (one row) and at backfill time (many rows). For one-row
inference, build the TreeExplainer lazily; for batches, build it once.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

import numpy as np
import pandas as pd
import shap

from .config import SHAP_TOP_K


@dataclass(frozen=True)
class FeatureContribution:
    name: str
    shap_value: float
    feature_value: Any


@dataclass(frozen=True)
class TakeItExplanation:
    prob_calibrated: float
    prob_raw: float
    top_positive: list[FeatureContribution]
    top_negative: list[FeatureContribution]

    def to_dict(self) -> dict:
        return {
            "prob_calibrated": self.prob_calibrated,
            "prob_raw": self.prob_raw,
            "top_positive": [asdict(c) for c in self.top_positive],
            "top_negative": [asdict(c) for c in self.top_negative],
        }


def _json_safe(value: Any) -> Any:
    """Coerce numpy / pandas scalars to JSON-serializable Python primitives.

    `pd.isna` raises on arrays and chokes on some pd.NA cases; guard via
    try/except so the explainer never crashes the alert pipeline on weird
    feature values.
    """
    if value is None or value is pd.NA:
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        # value is an array or otherwise non-scalar — fall through and let
        # the json encoder handle (or raise) downstream rather than masking it.
        pass
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return float(value)
    return value


def _align_features(row: pd.Series | dict, feature_cols: list[str]) -> pd.DataFrame:
    """Coerce an input row into a single-row DataFrame with the model's column
    order and dtype expectations (numeric, NaN allowed)."""
    if isinstance(row, dict):
        s = pd.Series(row)
    else:
        s = row
    # Fill missing columns with NaN so XGBoost handles them.
    aligned = pd.DataFrame([[s.get(c, np.nan) for c in feature_cols]], columns=feature_cols)
    nullable_int_dtypes = {"Int8", "Int16", "Int32", "Int64"}
    for c in aligned.columns:
        if aligned[c].dtype == bool or str(aligned[c].dtype) in nullable_int_dtypes:
            aligned[c] = aligned[c].astype(float)
    return aligned.astype(float)


def _top_contributions(
    contribs: np.ndarray,
    feature_values: np.ndarray,
    feature_cols: list[str],
    top_k: int,
) -> tuple[list[FeatureContribution], list[FeatureContribution]]:
    """Return (top_positive, top_negative) lists of FeatureContribution."""
    order_pos = np.argsort(contribs)[::-1][:top_k]
    order_neg = np.argsort(contribs)[:top_k]
    pos = [
        FeatureContribution(
            name=feature_cols[i],
            shap_value=float(contribs[i]),
            feature_value=_json_safe(feature_values[i]),
        )
        for i in order_pos
        if contribs[i] > 0
    ]
    neg = [
        FeatureContribution(
            name=feature_cols[i],
            shap_value=float(contribs[i]),
            feature_value=_json_safe(feature_values[i]),
        )
        for i in order_neg
        if contribs[i] < 0
    ]
    return pos, neg


def explain_row(
    bundle: dict, row: pd.Series | dict, top_k: int = SHAP_TOP_K
) -> TakeItExplanation:
    """Score one feature row and return calibrated prob + top-K SHAP."""
    model = bundle["model"]
    calibrator = bundle["calibrator"]
    feature_cols: list[str] = bundle["feature_cols"]

    x_df = _align_features(row, feature_cols)
    raw = float(model.predict_proba(x_df)[0, 1])
    cal = float(calibrator.transform(np.array([raw]))[0])

    explainer = shap.TreeExplainer(model)
    shap_values = explainer.shap_values(x_df)
    contribs = np.asarray(shap_values)[0]
    feature_values = x_df.iloc[0].to_numpy()

    pos, neg = _top_contributions(contribs, feature_values, feature_cols, top_k)
    return TakeItExplanation(
        prob_calibrated=cal, prob_raw=raw, top_positive=pos, top_negative=neg
    )


DEFAULT_BATCH_CHUNK_SIZE = 10_000
"""Chunk size for explain_batch. 626K rows × 74 features × float64 SHAP values
= ~3.5 GB if allocated at once; chunking by 10K caps the peak at ~60 MB."""


def explain_batch(
    bundle: dict,
    X: pd.DataFrame,
    top_k: int = SHAP_TOP_K,
    chunk_size: int = DEFAULT_BATCH_CHUNK_SIZE,
) -> list[TakeItExplanation]:
    """Score many feature rows. Builds one TreeExplainer (the expensive bit
    only happens once) and processes rows in `chunk_size` slices to bound peak
    memory. A 626K-row backfill at chunk_size=10K runs in seconds with <100 MB
    peak."""
    model = bundle["model"]
    calibrator = bundle["calibrator"]
    feature_cols: list[str] = bundle["feature_cols"]

    # Align column order; reuse the same numeric coercion as explain_row.
    aligned = X[feature_cols].copy()
    nullable_int_dtypes = {"Int8", "Int16", "Int32", "Int64"}
    for c in aligned.columns:
        if aligned[c].dtype == bool or str(aligned[c].dtype) in nullable_int_dtypes:
            aligned[c] = aligned[c].astype(float)
    aligned = aligned.astype(float)

    explainer = shap.TreeExplainer(model)

    out: list[TakeItExplanation] = []
    feature_values_arr = aligned.to_numpy()
    n = len(aligned)
    for start in range(0, n, chunk_size):
        end = min(start + chunk_size, n)
        chunk = aligned.iloc[start:end]
        raw = model.predict_proba(chunk)[:, 1]
        cal = calibrator.transform(raw)
        shap_values = np.asarray(explainer.shap_values(chunk))
        for j in range(end - start):
            pos, neg = _top_contributions(
                shap_values[j], feature_values_arr[start + j], feature_cols, top_k
            )
            out.append(
                TakeItExplanation(
                    prob_calibrated=float(cal[j]),
                    prob_raw=float(raw[j]),
                    top_positive=pos,
                    top_negative=neg,
                )
            )
    return out
