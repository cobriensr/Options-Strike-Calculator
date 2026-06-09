import pandas as pd

import exit_engine.backtest as bt


def _fire_rows(fire_id, mids, mode="A_intraday_0DTE", entry_price=1.0):
    return pd.DataFrame({
        "fire_id": fire_id, "mode": mode, "entry_price": entry_price,
        "mid": mids, "spread_pct": [10.0] * len(mids),
    })


def test_realized_return_at_exit_index_is_cost_netted():
    rows = _fire_rows(1, [1.0, 2.0, 1.5])
    # exit at index1 (mid 2.0 -> +100%), entry spread 10% -> slippage 2*0.5*10=10pp; comm 0.65/(1*100)*100=0.65
    r = bt.realized_return_for_exit(rows, exit_idx=1)
    assert abs(r - (100.0 - 0.65 - 10.0)) < 1e-9


def test_aggregate_equal_weight_mean():
    decisions = pd.DataFrame({"fire_id": [1, 2], "realized_pct": [100.0, -50.0]})
    assert bt.equal_weight_mean(decisions) == 25.0


def test_leakage_stratification_flags_uniform_lift():
    df = pd.DataFrame({
        "mode": ["A", "A", "B", "B"],
        "lift": [10.0, 10.0, 10.0, 10.0],  # identical across buckets -> suspicious
    })
    strat = bt.stratify_lift(df, by="mode")
    assert strat["uniform_flag"] is True
