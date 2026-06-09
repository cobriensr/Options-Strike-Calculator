import pandas as pd

import exit_engine.dataset as ds


def test_assign_walkforward_folds_is_time_ordered():
    dates = pd.Series(pd.to_datetime(
        ["2026-04-13", "2026-04-13", "2026-04-14", "2026-04-15", "2026-04-16"]
    ))
    folds = ds.assign_walkforward_folds(dates, n_train_days=2, test_block_days=1)
    # first 2 distinct dates are train-only (fold -1 = never tested)
    assert folds.tolist() == [-1, -1, 0, 1, 2]


def test_build_fire_rows_tags_identity_columns():
    path = pd.DataFrame({
        "mid": [1.0, 2.0],
        "spread": [0.1, 0.1],
        "minutes_since_entry": [0.0, 1.0],
        "minute": pd.to_datetime(["2026-04-13T14:30Z", "2026-04-13T14:31Z"]),
    })
    rows = ds.build_fire_rows(
        path, fire_id=7, date="2026-04-13", mode="A_intraday_0DTE",
        entry_price=1.0, minutes_to_close=[390, 389], theta=0.15,
    )
    assert set(["fire_id", "date", "mode", "entry_price", "mid",
                "ret_from_entry_pct", "y_has_upside", "y_log_upside"]).issubset(rows.columns)
    assert (rows["fire_id"] == 7).all()
    assert len(rows) == 2
