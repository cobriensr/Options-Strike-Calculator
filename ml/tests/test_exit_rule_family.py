import pandas as pd

import exit_engine.rule_family as rf


def test_trail_exit_index_on_giveback():
    # +0,+100,+200,+150 %  -> activate at 30, peak 200, giveback 10pp -> exit at idx3
    rows = pd.DataFrame({
        "mid": [1.0, 2.0, 3.0, 2.5],
        "ret_from_entry_pct": [0.0, 100.0, 200.0, 150.0],
        "minutes_since_entry": [0.0, 1.0, 2.0, 3.0],
    })
    idx = rf.decide_exit_index(rows, activate_pct=30.0, giveback_pct=10.0, hard_stop_min=999)
    assert idx == 3


def test_hard_time_stop_wins_when_earlier():
    rows = pd.DataFrame({
        "mid": [1.0, 1.1, 1.2, 1.3],
        "ret_from_entry_pct": [0.0, 10.0, 20.0, 30.0],
        "minutes_since_entry": [0.0, 1.0, 2.0, 3.0],
    })
    idx = rf.decide_exit_index(rows, activate_pct=50.0, giveback_pct=10.0, hard_stop_min=2)
    assert idx == 2  # last row with minutes_since_entry <= 2
