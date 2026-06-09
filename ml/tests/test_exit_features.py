import pandas as pd
import pytest

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


def _greek_path(mids, ivs, deltas, gammas, unders, strike, opt):
    return pd.DataFrame({
        "mid": mids, "spread": [0.1] * len(mids),
        "minutes_since_entry": [float(i) for i in range(len(mids))],
        "implied_volatility": ivs, "delta": deltas, "gamma": gammas,
        "underlying_price": unders, "strike": [strike] * len(mids),
        "option_type": [opt] * len(mids),
    })


def test_greek_features_present_and_correct():
    path = _greek_path([1.0, 2.0], [0.40, 0.50], [0.3, 0.4], [0.02, 0.03],
                       [500.0, 510.0], strike=495.0, opt="call")
    f = feat.build_features(path, entry_price=1.0, minutes_to_close=[390, 389])
    assert f["iv_level"].iloc[1] == pytest.approx(0.50)
    assert f["delta"].iloc[1] == pytest.approx(0.4)
    assert f["gamma"].iloc[1] == pytest.approx(0.03)
    assert f["otm_distance_pct"].iloc[1] == pytest.approx((510.0 - 495.0) / 510.0 * 100.0)
    assert f["underlying_ret_from_entry"].iloc[1] == pytest.approx((510.0 - 500.0) / 500.0 * 100.0)


def test_put_otm_distance_sign():
    path = _greek_path([1.0, 1.0], [0.4, 0.4], [-0.3, -0.3], [0.02, 0.02],
                       [490.0, 490.0], strike=495.0, opt="put")
    f = feat.build_features(path, entry_price=1.0, minutes_to_close=[390, 389])
    assert f["otm_distance_pct"].iloc[0] == pytest.approx((495.0 - 490.0) / 490.0 * 100.0)


def test_price_only_path_has_no_greek_columns():
    path = pd.DataFrame({"mid": [1.0, 2.0], "spread": [0.1, 0.1],
                         "minutes_since_entry": [0.0, 1.0]})
    f = feat.build_features(path, entry_price=1.0, minutes_to_close=[390, 389])
    assert "iv_level" not in f.columns and "otm_distance_pct" not in f.columns


def test_greek_features_are_causal():
    short = feat.build_features(_greek_path([1.0, 2.0], [0.4, 0.5], [0.3, 0.4], [0.02, 0.03],
                                            [500.0, 510.0], 495.0, "call"),
                                entry_price=1.0, minutes_to_close=[390, 389])
    long = feat.build_features(_greek_path([1.0, 2.0, 9.0], [0.4, 0.5, 0.9], [0.3, 0.4, 0.8],
                                           [0.02, 0.03, 0.09], [500.0, 510.0, 600.0], 495.0, "call"),
                               entry_price=1.0, minutes_to_close=[390, 389, 388])
    cols = ["iv_level", "iv_change_5m", "delta", "gamma", "otm_distance_pct", "underlying_ret_from_entry"]
    pd.testing.assert_frame_equal(short[cols], long[cols].iloc[:2].reset_index(drop=True))
