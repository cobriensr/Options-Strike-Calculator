"""Tests for the imbalance snapshot aggregator."""

from __future__ import annotations

from datetime import time

import pandas as pd
import pytest

from src.imbalance import snapshots


def _row(ts_et: str, **overrides) -> dict:
    ts = pd.Timestamp(ts_et, tz="America/New_York")
    base = {
        "ts_event_et": ts,
        "dataset": "ARCX.PILLAR",
        "symbol": "SPY",
        "auction_type": "C",
        "side": "A",
        "signed_imbalance": -100_000,
        "total_imbalance_qty": 100_000,
        "paired_qty": 500_000,
        "ref_price": 500.00,
        "cont_book_clr_price": 0.0,
    }
    base.update(overrides)
    return base


def _frame(rows: list[dict]) -> pd.DataFrame:
    return pd.DataFrame(rows)


def test_aggregate_picks_first_and_last_by_time() -> None:
    rows = [
        _row("2026-05-12 15:50:00", signed_imbalance=-300_000, paired_qty=100_000),
        _row("2026-05-12 15:55:00", signed_imbalance=-200_000, paired_qty=400_000),
        _row("2026-05-12 15:59:00", signed_imbalance=-50_000, paired_qty=800_000),
    ]
    snap = snapshots._aggregate_one(_frame(rows), "C")
    assert len(snap) == 1
    r = snap.iloc[0]
    assert r["signed_imbalance_first"] == -300_000
    assert r["signed_imbalance_last"] == -50_000
    # Shrinking (contra liquidity arriving): abs trend is negative
    assert r["abs_imbalance_trend"] == 50_000 - 300_000
    # Paired qty grows
    assert r["paired_qty_growth"] == 800_000 - 100_000
    assert r["n_msgs"] == 3


def test_window_filter_excludes_out_of_window() -> None:
    rows = [
        _row("2026-05-12 15:45:00"),  # before window
        _row("2026-05-12 16:00:00"),  # at end-exclusive
        _row("2026-05-12 15:50:00", signed_imbalance=-100),  # inside
        _row("2026-05-12 15:59:59", signed_imbalance=-50),  # inside
    ]
    snap = snapshots._aggregate_one(_frame(rows), "C")
    r = snap.iloc[0]
    assert r["n_msgs"] == 2
    assert r["signed_imbalance_first"] == -100
    assert r["signed_imbalance_last"] == -50


def test_aggregate_returns_empty_when_no_window_rows() -> None:
    rows = [_row("2026-05-12 11:00:00")]
    snap = snapshots._aggregate_one(_frame(rows), "C")
    assert snap.empty


def test_in_window_inclusive_start_exclusive_end() -> None:
    ts = pd.Series(
        pd.to_datetime(
            [
                "2026-05-12 09:00:00",
                "2026-05-12 09:30:00",
                "2026-05-12 09:29:59",
            ]
        ).tz_localize("America/New_York")
    )
    mask = snapshots._in_window(ts, time(9, 0), time(9, 30))
    assert mask.tolist() == [True, False, True]


def test_auction_windows_cover_expected_types() -> None:
    assert set(snapshots.AUCTION_WINDOWS) == {"C", "M", "O"}
    # Close window is the 15:50-16:00 ET MOC publishing window
    start, end = snapshots.AUCTION_WINDOWS["C"]
    assert start == time(15, 50)
    assert end == time(16, 0)


def test_aggregate_o_window_early_opening() -> None:
    # 'O' (early opening, non-NYSE) window is 09:25-09:30 ET.
    rows = [
        _row("2026-05-12 09:24:59", auction_type="O", signed_imbalance=500),  # before
        _row("2026-05-12 09:25:00", auction_type="O", signed_imbalance=600),  # inside
        _row("2026-05-12 09:29:59", auction_type="O", signed_imbalance=450),  # inside
        _row(
            "2026-05-12 09:30:00", auction_type="O", signed_imbalance=999
        ),  # at end (exclusive)
    ]
    snap = snapshots._aggregate_one(_frame(rows), "O")
    assert len(snap) == 1
    r = snap.iloc[0]
    assert r["n_msgs"] == 2
    assert r["signed_imbalance_first"] == 600
    assert r["signed_imbalance_last"] == 450


def test_build_snapshots_concat_and_aggregate(tmp_path) -> None:
    # Create a tiny per-venue parquet and verify build_snapshots aggregates it.
    df = pd.DataFrame(
        [
            _row(
                "2026-05-12 15:50:00",
                symbol="SPY",
                signed_imbalance=-100,
                paired_qty=1000,
            ),
            _row(
                "2026-05-12 15:59:00",
                symbol="SPY",
                signed_imbalance=-30,
                paired_qty=2000,
            ),
            _row(
                "2026-05-12 09:00:00",
                symbol="SPY",
                auction_type="M",
                signed_imbalance=200,
                paired_qty=500,
            ),
            _row(
                "2026-05-12 09:29:00",
                symbol="SPY",
                auction_type="M",
                signed_imbalance=80,
                paired_qty=1500,
            ),
        ]
    )
    p = tmp_path / "venue.parquet"
    df.to_parquet(p, index=False)

    panel = snapshots.build_snapshots([p])
    assert set(panel["auction_type"]) == {"C", "M"}
    close = panel[panel["auction_type"] == "C"].iloc[0]
    assert close["signed_imbalance_first"] == -100
    assert close["signed_imbalance_last"] == -30
    open_ = panel[panel["auction_type"] == "M"].iloc[0]
    assert open_["signed_imbalance_first"] == 200
    assert open_["signed_imbalance_last"] == 80


def test_build_snapshots_missing_file_raises(tmp_path) -> None:
    with pytest.raises(FileNotFoundError):
        snapshots.build_snapshots([tmp_path / "nope.parquet"])
