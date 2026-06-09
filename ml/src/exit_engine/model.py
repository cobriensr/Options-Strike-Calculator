"""XGBoost upside-remaining model + greedy stopping policy."""
from __future__ import annotations

import pandas as pd
import xgboost as xgb

_NON_FEATURE = {
    "y_has_upside", "y_log_upside", "fire_id", "date", "mode",
    "mid", "forward_ratio", "minute", "entry_price",
}


def feature_columns(all_cols: list[str]) -> list[str]:
    return [c for c in all_cols if c not in _NON_FEATURE]


def train_classifier(train_df: pd.DataFrame, feature_cols: list[str]) -> xgb.XGBClassifier:
    model = xgb.XGBClassifier(
        n_estimators=300, max_depth=5, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8, eval_metric="logloss",
        n_jobs=-1, random_state=13,
    )
    model.fit(train_df[feature_cols], train_df["y_has_upside"])
    return model


def greedy_stop_index(
    rows: pd.DataFrame, exit_threshold: float, arm_after_min: float, score_col: str = "p_upside"
) -> int:
    """First row with minutes_since_entry > arm_after_min whose score < threshold,
    else the last index (hold to end)."""
    mse = rows["minutes_since_entry"].to_numpy()
    score = rows[score_col].to_numpy()
    for i in range(len(rows)):
        if mse[i] > arm_after_min and score[i] < exit_threshold:
            return i
    return len(rows) - 1
