import pandas as pd

import exit_engine.dataset as ds


def test_assign_walkforward_folds_is_time_ordered():
    dates = pd.Series(pd.to_datetime(
        ["2026-04-13", "2026-04-13", "2026-04-14", "2026-04-15", "2026-04-16"]
    ))
    folds = ds.assign_walkforward_folds(dates, n_train_days=2, test_block_days=1)
    # 4 distinct dates; first 2 (04-13, 04-14) are train-only warmup (fold -1);
    # testing starts on the 3rd distinct date (04-15 -> fold 0, 04-16 -> fold 1).
    assert folds.tolist() == [-1, -1, -1, 0, 1]


def test_select_session_dates_skips_non_trading_days():
    # Fri 2026-05-01, then weekend gap, then Mon/Tue 05-04/05-05
    avail = ["2026-04-30", "2026-05-01", "2026-05-04", "2026-05-05", "2026-05-06"]
    assert ds.select_session_dates("2026-05-01", avail, 1) == ["2026-05-01"]
    assert ds.select_session_dates("2026-05-01", avail, 3) == ["2026-05-01", "2026-05-04", "2026-05-05"]
    assert ds.select_session_dates("2026-05-06", avail, 4) == ["2026-05-06"]


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
