"""Smoke tests for the day-analog parity check (ml/src/day_analog_parity.py).

Synthetic bars only — no production data, no network. The DuckDB test
writes a two-file parquet archive to tmp_path in the same layout as
ml/data/archive.
"""

from datetime import date

import numpy as np
import pandas as pd
import pytest

import day_analog_parity as P


def _bars(
    start_utc: str, closes: list[float], *, base_open: float = 100.0
) -> pd.DataFrame:
    ts = pd.date_range(start_utc, periods=len(closes), freq="min", tz="UTC")
    opens = [base_open] + list(closes[:-1])
    return pd.DataFrame(
        {
            "ts": ts,
            "open": opens,
            "high": [max(o, c) for o, c in zip(opens, closes)],
            "low": [min(o, c) for o, c in zip(opens, closes)],
            "close": closes,
            "volume": 10,
        }
    )


# ── Vector builders ──────────────────────────────────────────────────────


def test_utc_window_vector_carries_forward_from_the_first_bar():
    # Anchor at 00:00 UTC (open 100), then minutes 1..12 with minute 5 missing.
    closes = [100.0] + [100.0 + m for m in range(1, 13)]
    bars = _bars("2025-05-05 00:00", closes).drop(index=5)
    vec = P.utc_window_vectors(bars)[date(2025, 5, 5)]

    assert vec.shape == (P.VEC_DIM,)
    assert vec[0] == pytest.approx(0.01)  # minute 1: 101 / 100 - 1
    assert vec[4] == pytest.approx(0.04)  # minute 5 missing → carries minute 4
    assert vec[11] == pytest.approx(0.12)  # minute 12
    assert vec[59] == pytest.approx(0.12)  # tail carries the last close


def test_utc_window_rejects_days_with_fewer_than_min_bars():
    bars = _bars("2025-05-05 00:00", [100.0] * (P.MIN_BARS - 1))
    assert P.utc_window_vectors(bars) == {}


@pytest.mark.parametrize(
    ("day", "anchor_utc"),
    [("2025-07-07", "13:30"), ("2025-12-08", "14:30")],  # CDT, CST
)
def test_cash_window_anchors_on_0830_ct_in_both_dst_regimes(day, anchor_utc):
    bars = _bars(f"{day} 13:00", [100.0 + 0.25 * i for i in range(150)])
    anchor = bars.loc[bars["ts"] == pd.Timestamp(f"{day} {anchor_utc}", tz="UTC")]
    vec = P.cash_window_vectors(bars)[date.fromisoformat(day)]

    base = float(anchor["open"].iloc[0])
    assert vec[0] == pytest.approx(float(anchor["close"].iloc[0]) / base - 1)
    assert vec[59] == pytest.approx(
        (float(anchor["close"].iloc[0]) + 59 * 0.25) / base - 1
    )


def test_cash_window_drops_a_day_without_the_0830_bar():
    bars = _bars("2025-07-07 13:31", [100.0] * 90)  # starts one minute late
    assert P.cash_window_vectors(bars) == {}


# ── Metrics ──────────────────────────────────────────────────────────────


def test_vector_parity_counts_days_within_tolerance():
    d1, d2, d3 = date(2025, 5, 5), date(2025, 5, 6), date(2025, 5, 7)
    a = {d1: np.zeros(60), d2: np.zeros(60), d3: np.zeros(60)}
    b = {d1: np.zeros(60), d2: np.full(60, 5e-3)}
    res = P.vector_parity(a, b)

    assert res["days_common"] == 2
    assert res["days_only_a"] == 1
    assert res["share_within_tol"] == pytest.approx(0.5)
    assert res["max"] == pytest.approx(5e-3)


def test_nn_query_swap_never_uses_the_query_day_or_later():
    rng = np.random.default_rng(7)
    near, far = rng.normal(size=60), rng.normal(size=60)
    query = near + 1e-3 * rng.normal(size=60)
    corpus = {
        date(2025, 5, 1): near,
        date(2025, 5, 2): far,
        # Identical to the query but dated after it: must never be a neighbour.
        date(2025, 5, 9): query.copy(),
    }
    res = P.nn_overlap_query_swap(
        corpus, {date(2025, 5, 5): query}, {date(2025, 5, 5): near}, k=1
    )
    # Both queries resolve to 05-01 only when 05-09 is excluded.
    assert res["n_queries"] == 1
    assert res["mean"] == pytest.approx(1.0)


def test_nn_query_swap_skips_queries_without_k_earlier_days():
    corpus = {date(2025, 5, 1): np.ones(60)}
    q = {date(2025, 5, 5): np.ones(60)}
    assert P.nn_overlap_query_swap(corpus, q, q, k=2)["n_queries"] == 0


def test_classify_mismatches_uses_the_first_matching_cause():
    per_day = {
        "2025-06-16": 1e-2,
        "2025-06-17": 0.0,
        "2026-04-06": 8e-3,
        "2025-08-01": 2e-4,
    }
    res = P.classify_mismatches(
        per_day,
        {
            "roll_week": {date(2025, 6, 16), date(2025, 6, 17)},
            "live_writer": {date(2026, 4, 6)},
        },
    )
    assert res["over_tol_by_cause"] == {"roll_week": 1, "live_writer": 1, "other": 1}
    assert res["other_days"] == ["2025-08-01"]
    assert res["clean_days"] == 1
    assert res["clean_share_within_tol"] == pytest.approx(0.0)


def test_calendar_front_holds_the_expiring_contract_through_the_third_friday():
    assert P.third_friday(2025, 6) == date(2025, 6, 20)
    assert P.calendar_front(date(2025, 6, 20)) == "ESM5"
    assert P.calendar_front(date(2025, 6, 21)) == "ESU5"
    assert P.calendar_front(date(2025, 12, 22)) == "ESH6"


def test_contamination_flags_and_attributes_a_back_month_minute():
    front = _bars("2025-05-05 14:00", [5000.0 + i for i in range(5)], base_open=5000.0)
    back = _bars("2025-05-05 14:00", [5050.0 + i for i in range(5)], base_open=5050.0)
    outrights = pd.concat(
        [
            front.assign(symbol="ESM5", volume=1000),
            back.assign(symbol="ESU5", volume=10),
        ]
    ).assign(day=date(2025, 5, 5))
    fb = front.copy()
    # The merged writer: minute 2's close came from the back month and
    # GREATEST() kept the back month's high; minute 4's back-month bar
    # won the first write, so its open is the back month's.
    fb.loc[2, "close"] = back.loc[2, "close"]
    fb.loc[2, "high"] = back.loc[2, "high"]
    fb.loc[4, "open"] = back.loc[4, "open"]

    res = P.contamination(fb, outrights)

    assert res.summary["matched_minutes"] == 5
    assert res.summary["bad_close"] == 1
    assert res.summary["bad_close_attributed_to_other_outright"] == 1
    assert res.summary["bad_open_share"] == pytest.approx(0.2)
    assert res.summary["bad_high_share"] == pytest.approx(0.2)
    assert res.summary["bad_low_share"] == pytest.approx(0.0)


def test_proxy_flags_catch_a_merged_open_and_a_reverting_spike():
    bars = _bars(
        "2025-07-07 13:30", [5000.0 + 0.25 * i for i in range(20)], base_open=5000.0
    )
    bars.loc[5, "open"] += 50.0  # back-month bar won the first write
    bars.loc[12, "close"] += 50.0  # back-month close won the last write
    flags = P._proxy_flags(bars)

    assert flags.loc[5, "gap"] and not flags.loc[5, "spike"]
    assert flags.loc[12, "spike"]
    # The bar after the spike opens on the real tape, so its open gaps
    # against the spiked close: the neighbour of a contaminated minute
    # flags too, which only widens the exclusion by one minute.
    assert flags.loc[13, "gap"]
    assert set(flags.index[flags["flagged"]]) == {5, 12, 13}


def test_cash_window_quality_counts_flagged_days_and_calibration():
    clean = _bars(
        "2025-07-07 13:30", [5000.0 + 0.25 * i for i in range(60)], base_open=5000.0
    )
    dirty = _bars(
        "2025-07-08 13:30", [5000.0 + 0.25 * i for i in range(60)], base_open=5000.0
    )
    dirty.loc[0, "open"] += 50.0  # contaminated anchor
    dirty.loc[0, "high"] += 50.0
    fb = pd.concat([clean, dirty], ignore_index=True)

    quality = P.cash_window_quality(fb, after=date(2025, 7, 1))
    assert quality == [
        {
            "month": "2025-07",
            "days_with_anchor": 2,
            "days_full_60": 2,
            "days_flagged": 1,
            "days_usable": 1,
        }
    ]
    calib = P.proxy_calibration(
        P.cash_window_days(fb),
        truth_bad={date(2025, 7, 8)},
        truth_days={date(2025, 7, 7), date(2025, 7, 8)},
    )
    assert calib == {
        "days": 2,
        "true_positive": 1,
        "false_positive": 0,
        "false_negative": 0,
    }


# ── DuckDB loaders against a synthetic archive ───────────────────────────


@pytest.fixture
def tiny_archive(tmp_path):
    """Two UTC days; on 05-05 the calendar spread out-trades the outright."""
    rows = []
    for day, spread_vol in (("2025-05-05", 10_000), ("2025-05-06", 1)):
        out = _bars(
            f"{day} 00:00", [5000.0 + 0.25 * i for i in range(80)], base_open=5000.0
        )
        spr = _bars(
            f"{day} 00:00", [50.0 + 0.05 * i for i in range(80)], base_open=50.0
        )
        rows.append(out.assign(instrument_id=1, symbol="ESM5", volume=100))
        rows.append(spr.assign(instrument_id=2, symbol="ESM5-ESU5", volume=spread_vol))
        opt = _bars(f"{day} 00:00", [10.0] * 80, base_open=10.0)
        rows.append(
            opt.assign(instrument_id=3, symbol="ES 250620 C6000", volume=99_999)
        )
    bars = pd.concat(rows).rename(columns={"ts": "ts_event"})
    part = tmp_path / "ohlcv_1m" / "year=2025"
    part.mkdir(parents=True)
    bars.to_parquet(part / "part.parquet", index=False)
    pd.DataFrame(
        {"instrument_id": [1, 2, 3], "symbol": ["ESM5", "ESM5-ESU5", "ES 250620 C6000"]}
    ).to_parquet(tmp_path / "symbology.parquet", index=False)
    return tmp_path


def test_sidecar_rule_replicates_the_spread_pick(tiny_archive):
    side = P.load_sidecar_utc_first_hour(tiny_archive, "2025-05-05", "2025-05-06")
    picked = side.groupby("day")["symbol"].first().to_dict()

    assert picked == {date(2025, 5, 5): "ESM5-ESU5", date(2025, 5, 6): "ESM5"}
    # First bar plus the 60 minutes after it.
    assert side.groupby("day").size().tolist() == [61, 61]


def test_outright_loader_excludes_spreads_and_options(tiny_archive):
    bars = P.load_outright_bars(
        tiny_archive, "2025-05-05", "2025-05-06", front_only=False
    )
    assert set(bars["symbol"]) == {"ESM5"}

    front = P.load_outright_bars(
        tiny_archive, "2025-05-05", "2025-05-06", front_only=True, utc_hours=(0, 0)
    )
    assert set(front["symbol"]) == {"ESM5"}
    assert front["ts"].dt.hour.max() == 0
