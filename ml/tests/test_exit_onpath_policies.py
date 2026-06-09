import pandas as pd

import exit_engine.onpath_policies as op


def _rows(mids, mse, entry=1.0, spread_pct=10.0):
    ret = [(m - entry) / entry * 100.0 for m in mids]
    return pd.DataFrame({
        "mid": mids, "entry_price": entry, "spread_pct": spread_pct,
        "ret_from_entry_pct": ret, "minutes_since_entry": mse,
    })


def test_onpath_keys_and_trail_hard_eod():
    rows = _rows([1.0, 2.0, 3.0, 2.5], [0.0, 1.0, 2.0, 3.0])
    out = op.onpath_baselines(rows)
    assert set(out) == {"trail30_10", "hard30m", "tier50_holdeod", "eod"}
    # all minutes <= 30 and trail activates at +30 then gives back into idx3 -> all land on last row
    assert out["trail30_10"] == out["eod"]
    assert out["hard30m"] == out["eod"]


def test_onpath_tier50_is_average_of_two_legs():
    rows = _rows([1.0, 1.5, 3.0], [0.0, 1.0, 2.0])
    out = op.onpath_baselines(rows)
    import exit_engine.backtest as bt
    leg1 = bt.realized_return_for_exit(rows, 1)  # first +50% at idx1
    leg2 = bt.realized_return_for_exit(rows, 2)  # hold to last
    assert out["tier50_holdeod"] == (leg1 + leg2) / 2.0
