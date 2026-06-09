import numpy as np
import pandas as pd

import exit_engine.model as m


def test_greedy_stop_exits_on_first_armed_low_score():
    rows = pd.DataFrame({
        "minutes_since_entry": [0.0, 1.0, 2.0, 3.0],
        "p_upside": [0.9, 0.8, 0.2, 0.1],
    })
    # arm after minute 0; exit_threshold 0.5 -> first armed row below 0.5 is idx2
    idx = m.greedy_stop_index(rows, exit_threshold=0.5, arm_after_min=0.0, score_col="p_upside")
    assert idx == 2


def test_greedy_stop_holds_to_end_when_always_high():
    rows = pd.DataFrame({
        "minutes_since_entry": [0.0, 1.0, 2.0],
        "p_upside": [0.9, 0.95, 0.92],
    })
    idx = m.greedy_stop_index(rows, exit_threshold=0.5, arm_after_min=0.0, score_col="p_upside")
    assert idx == 2


def test_greedy_stop_from_arrays_matches_dataframe_version():
    mse = np.array([0.0, 1.0, 2.0, 3.0])
    p = np.array([0.9, 0.8, 0.2, 0.1])
    idx_arr = m.greedy_stop_index_arr(mse, p, exit_threshold=0.5, arm_after_min=1.0)
    rows = pd.DataFrame({"minutes_since_entry": mse, "p_upside": p})
    idx_df = m.greedy_stop_index(rows, exit_threshold=0.5, arm_after_min=1.0)
    assert idx_arr == idx_df == 2


def test_greedy_stop_arr_holds_to_end_when_never_armed_low():
    mse = np.array([0.0, 1.0, 2.0])
    p = np.array([0.9, 0.95, 0.92])
    assert m.greedy_stop_index_arr(mse, p, exit_threshold=0.5, arm_after_min=1.0) == 2


def test_feature_columns_excludes_labels_and_identity():
    cols = m.feature_columns(
        ["ret_from_entry_pct", "slope_3m", "y_has_upside", "y_log_upside",
         "fire_id", "date", "mode", "mid", "forward_ratio", "minute", "entry_price",
         "fold", "p_upside"]
    )
    assert "ret_from_entry_pct" in cols and "slope_3m" in cols
    assert not ({"y_has_upside", "y_log_upside", "fire_id", "date", "mode",
                 "mid", "forward_ratio", "minute", "entry_price",
                 "fold", "p_upside"} & set(cols))
