import pandas as pd

import exit_engine.sampling as sm


def test_stratified_fire_sample_is_proportional_and_capped():
    meta = pd.DataFrame({
        "fire_id": range(100),
        "date": (["2026-01-02"] * 50) + (["2026-01-03"] * 50),
        "mode": (["A_intraday_0DTE"] * 25 + ["B_multi_day_DTE1_3"] * 25) * 2,
    })
    ids = sm.stratified_fire_sample(meta, target=40, seed=1)
    assert len(ids) == 40
    assert set(ids).issubset(set(meta["fire_id"]))
    sub = meta[meta["fire_id"].isin(ids)]
    counts = sub.groupby(["date", "mode"]).size()
    assert counts.min() >= 8 and counts.max() <= 12


def test_target_ge_population_returns_all():
    meta = pd.DataFrame({"fire_id": range(10), "date": ["d"] * 10, "mode": ["A_intraday_0DTE"] * 10})
    assert sorted(sm.stratified_fire_sample(meta, target=50, seed=1)) == list(range(10))
