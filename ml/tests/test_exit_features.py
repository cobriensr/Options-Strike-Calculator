import pandas as pd

import exit_engine.features as feat


def _path(mids, entry_price=1.0):
    return pd.DataFrame({
        "mid": mids,
        "spread": [0.1] * len(mids),
        "minutes_since_entry": [float(i) for i in range(len(mids))],
    })


def test_core_features_present_and_causal_values():
    path = _path([1.0, 2.0, 1.5])
    f = feat.build_features(_path([1.0, 2.0, 1.5]), entry_price=1.0, minutes_to_close=[390, 389, 388])
    # return-from-entry at idx1 = +100%, drawdown from running peak at idx2 = (1.5-2.0)/2.0
    assert abs(f["ret_from_entry_pct"].iloc[1] - 100.0) < 1e-9
    assert abs(f["drawdown_from_peak_pct"].iloc[2] - (-25.0)) < 1e-9
    assert f["minutes_since_entry"].iloc[2] == 2.0


def test_appending_future_row_does_not_change_past_features():
    short = feat.build_features(_path([1.0, 2.0]), entry_price=1.0, minutes_to_close=[390, 389])
    long = feat.build_features(_path([1.0, 2.0, 9.0]), entry_price=1.0, minutes_to_close=[390, 389, 388])
    cols = ["ret_from_entry_pct", "drawdown_from_peak_pct", "slope_3m"]
    pd.testing.assert_frame_equal(short[cols], long[cols].iloc[:2].reset_index(drop=True))
