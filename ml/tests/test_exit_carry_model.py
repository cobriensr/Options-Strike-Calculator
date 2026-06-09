import pandas as pd

import exit_engine.carry_model as cm


def test_eod_row_label_carry_pays_when_next_session_higher():
    # close mid 2.0; next-session forward max 3.0 -> carry pays (1)
    row = cm.build_eod_decision_row(
        fire_id=1, close_mid=2.0, next_session_forward_max=3.0,
        days_of_life_left=2, close_vs_peak_pct=-5.0, late_slope=0.1,
    )
    assert row["y_carry_pays"] == 1
    assert row["close_mid"] == 2.0


def test_eod_row_label_flatten_when_next_session_lower():
    row = cm.build_eod_decision_row(
        fire_id=2, close_mid=2.0, next_session_forward_max=1.5,
        days_of_life_left=1, close_vs_peak_pct=-30.0, late_slope=-0.2,
    )
    assert row["y_carry_pays"] == 0
