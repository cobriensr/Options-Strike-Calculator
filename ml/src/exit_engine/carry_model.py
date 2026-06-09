"""Mode-B end-of-day carry/flatten model. One decision per multi-day fire,
made at the close: hold overnight vs flatten now."""
from __future__ import annotations

import pandas as pd
import xgboost as xgb

EOD_FEATURES = ["days_of_life_left", "close_vs_peak_pct", "late_slope", "close_mid"]


def build_eod_decision_row(
    fire_id: int, close_mid: float, next_session_forward_max: float,
    days_of_life_left: float, close_vs_peak_pct: float, late_slope: float,
) -> dict:
    """One EOD row. Label = carrying captured a higher mark than flattening."""
    return {
        "fire_id": fire_id,
        "close_mid": close_mid,
        "days_of_life_left": days_of_life_left,
        "close_vs_peak_pct": close_vs_peak_pct,
        "late_slope": late_slope,
        "y_carry_pays": int(next_session_forward_max > close_mid),
    }


def train_carry_model(eod_df: pd.DataFrame) -> xgb.XGBClassifier:
    model = xgb.XGBClassifier(
        n_estimators=200, max_depth=4, learning_rate=0.05,
        eval_metric="logloss", n_jobs=-1, random_state=13,
    )
    model.fit(eod_df[EOD_FEATURES], eod_df["y_carry_pays"])
    return model
