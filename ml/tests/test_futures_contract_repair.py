"""Tests for ml/src/futures_contract_repair.py (ES/NQ front-month rebuild).

Synthetic frames only: no database, no archive files. The archive readers
(read_archive_bars, read_archive_trades) are never called. The Postgres path
(connect_readonly, fetch_tick_page) runs against a fake `psycopg2.connect`
installed with monkeypatch; ml/conftest.py blocks any real connect.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pandas as pd
import psycopg2
import psycopg2.errors
import pytest

import futures_contract_repair as fcr

ES = fcr.ROOTS["ES"]
NQ = fcr.ROOTS["NQ"]
T0 = pd.Timestamp("2026-05-05 14:30", tz="UTC")


def ticks(rows: list[tuple[float, float, int]], start: pd.Timestamp = T0):
    """Prints as (seconds after `start`, price, size), seq in row order."""
    return pd.DataFrame(
        {
            "ts": [start + pd.Timedelta(seconds=s) for s, _, _ in rows],
            "seq": range(len(rows)),
            "price": [float(p) for _, p, _ in rows],
            "size": [int(z) for _, _, z in rows],
        }
    )


def minute_of(base: float, back: float | None = None, start=T0, size=1):
    """One minute of front prints around `base`, plus back prints if given."""
    rows = [(1, base, size), (20, base + 1.0, size), (40, base - 1.0, size)]
    rows += [(59, base + 0.5, size)]
    if back is not None:
        rows += [(10, back, 1), (30, back + 0.5, 1)]
    return ticks(rows, start)


def series(levels: list[tuple[float, float | None]]):
    """Consecutive minutes from T0; each item is (front, back) or (None, back)."""
    frames = []
    for i, (front, back) in enumerate(levels):
        start = T0 + pd.Timedelta(minutes=i)
        if front is None:
            frames.append(ticks([(5, back, 1), (35, back + 0.25, 2)], start))
        else:
            frames.append(minute_of(front, back, start))
    out = pd.concat(frames, ignore_index=True)
    out["seq"] = range(len(out))
    return out


def test_one_contract_minute_passes_through_unchanged():
    t = ticks([(1, 7000.0, 3), (20, 7001.25, 1), (40, 6999.5, 2), (59, 7000.75, 4)])
    got = fcr.rebuild_from_ticks(t, ES).iloc[0]
    assert (got.open, got.high, got.low, got.close) == (7000, 7001.25, 6999.5, 7000.75)
    assert got.volume == 10
    assert got.clusters == 1
    assert got.prints == 4
    assert not got.front_absent


def test_two_contracts_mixed_keep_the_front_cluster():
    # Back month (+58) prints first and last; the bar must ignore it entirely.
    t = ticks(
        [
            (0, 7058.0, 5),
            (1, 7000.0, 3),
            (20, 7001.25, 1),
            (30, 7059.5, 7),
            (40, 6999.5, 2),
            (59, 7000.75, 4),
            (59.5, 7058.75, 1),
        ]
    )
    got = fcr.rebuild_from_ticks(t, ES).iloc[0]
    assert (got.open, got.high, got.low, got.close) == (7000, 7001.25, 6999.5, 7000.75)
    assert got.volume == 10
    assert got.clusters == 2
    assert got.prints == 7
    # G's margin on both sides: the widest step inside the kept cluster and the
    # step that split it from the next one.
    assert got.kept_gap == 0.75
    assert got.split_gap == 7058.0 - 7001.25


def test_three_contracts_keep_only_the_lowest():
    t = ticks([(1, 7000.0, 1), (2, 7058.0, 1), (3, 7116.0, 1), (4, 7000.5, 1)])
    got = fcr.rebuild_from_ticks(t, ES).iloc[0]
    assert (got.open, got.high, got.low, got.close) == (7000, 7000.5, 7000, 7000.5)
    assert got.clusters == 3
    assert got.split_gap == 57.5  # front to the second contract, not the third


def test_one_print_minute_has_no_gaps():
    got = fcr.rebuild_from_ticks(ticks([(1, 7000.0, 1)]), ES).iloc[0]
    assert pd.isna(got.kept_gap)
    assert pd.isna(got.split_gap)


def test_back_month_only_minute_emits_no_bar_and_is_counted():
    levels = [(7000.0 + i, 7058.0 + i) for i in range(11)]
    levels[5] = (None, 7063.0)  # only the back month printed
    minutes = fcr.rebuild_from_ticks(series(levels), ES)
    absent = minutes[minutes.front_absent]
    assert list(absent.ts) == [T0 + pd.Timedelta(minutes=5)]
    minutes = fcr.mark_partial(minutes, [])
    bars = fcr.bars_output(minutes, "ES", "ticks")
    assert len(bars) == 10
    assert T0 + pd.Timedelta(minutes=5) not in set(bars.ts)
    summary = fcr.per_day_summary(minutes, "ES", "ticks")
    assert summary.iloc[0].front_absent == 1
    assert summary.iloc[0].bars == 10
    assert summary.iloc[0].multi_cluster == 10


def test_a_one_minute_anomaly_does_not_latch():
    # The first minute is back-only. A rule that follows the previous accepted
    # close would start on the back month and stay there; this one must not.
    levels = [(None, 7060.0)] + [(7002.0 + i, 7060.0 + i) for i in range(8)]
    levels += [(7010.0 + i, None) for i in range(4)]
    minutes = fcr.rebuild_from_ticks(series(levels), ES)
    assert list(minutes.front_absent) == [True] + [False] * 12
    kept = minutes[~minutes.front_absent]
    assert (kept.low < 7030).all()
    assert (kept.high < 7030).all()


def test_a_steady_trend_flags_nothing():
    # +4 pts a minute for an hour: 240 pts, far beyond G over the window, but
    # each minute sits at the middle of its neighbours.
    levels = [(7000.0 + 4 * i, None) for i in range(60)]
    minutes = fcr.rebuild_from_ticks(series(levels), ES)
    assert not minutes.front_absent.any()


def test_a_sharp_rally_below_half_a_carry_is_not_front_absent():
    # The shape of NQ 2026-06-10 12:30Z (the 08:30 ET data): the front jumped
    # ~100 pts for one minute, more than G but well under one carry (~280).
    # The front did print, so the minute must keep its bar.
    levels = [(28740.0 + i, 29020.0 + i) for i in range(5)]
    levels += [(28845.0, 29125.0)]
    levels += [(28745.0 + i, 29025.0 + i) for i in range(5)]
    minutes = fcr.rebuild_from_ticks(series(levels), NQ)
    jump = minutes.iloc[5]
    assert jump.level - jump.ref > NQ.gap
    assert not minutes.front_absent.any()
    assert NQ.carry / 2 > jump.level - jump.ref


def test_an_isolated_minute_is_kept_without_a_reference():
    minutes = fcr.rebuild_from_ticks(series([(None, 7060.0)]), ES)
    assert not minutes.front_absent.any()
    assert minutes.ref.isna().all()


def test_neighbours_outside_the_window_are_ignored():
    # Two minutes 90 minutes apart (a halt between them): no reference either way.
    a = minute_of(7000.0)
    b = minute_of(7100.0, start=T0 + pd.Timedelta(minutes=90))
    t = pd.concat([a, b], ignore_index=True)
    t["seq"] = range(len(t))
    minutes = fcr.rebuild_from_ticks(t, ES)
    assert minutes.ref.isna().all()
    assert not minutes.front_absent.any()


def test_the_gap_is_per_root():
    # 50 points apart: two contracts for ES (G 25), one cluster for NQ.
    t = ticks([(1, 20000.0, 1), (2, 20000.25, 1), (3, 20050.0, 1), (4, 20050.25, 1)])
    es = fcr.rebuild_from_ticks(t, ES).iloc[0]
    nq = fcr.rebuild_from_ticks(t, NQ).iloc[0]
    assert (es.clusters, es.high, es.volume) == (2, 20000.25, 2)
    assert (nq.clusters, nq.high, nq.volume) == (1, 20050.25, 4)
    # The middle of each root's flat ground-truth band, on the tick (fix round 1).
    assert ES.gap == 17.0
    assert NQ.gap == 65.0


def test_carry_is_the_tick_span_measurement():
    # Median cluster-1 minus cluster-0 level over every multi-cluster tick minute.
    assert ES.carry == 60.75
    assert NQ.carry == 279.75


def test_a_gap_of_exactly_g_does_not_split():
    t = ticks([(1, 7000.0, 1), (2, 7000.0 + ES.gap, 1)])
    assert fcr.rebuild_from_ticks(t, ES).iloc[0].clusters == 1
    t = ticks([(1, 7000.0, 1), (2, 7000.25 + ES.gap, 1)])
    assert fcr.rebuild_from_ticks(t, ES).iloc[0].clusters == 2


@pytest.mark.parametrize(
    ("raw", "want"),
    [
        (7165.2500000001, 7165.25),
        (7165.1300, 7165.25),
        (7165.1200, 7165.0),
        (29617.7499, 29617.75),
    ],
)
def test_round_to_tick(raw, want):
    assert fcr.round_to_tick(pd.Series([raw]), 0.25).iloc[0] == want


def test_rebuilt_prices_sit_on_the_tick():
    t = ticks([(1, 7000.0000001, 1), (2, 7001.2499999, 1), (3, 6999.75000002, 1)])
    got = fcr.rebuild_from_ticks(t, ES).iloc[0]
    assert (got.open, got.high, got.low, got.close) == (7000, 7001.25, 6999.75, 6999.75)


@pytest.mark.parametrize("shuffle", [0, 1, 2, 3])
def test_time_order_ties_break_by_seq(shuffle):
    # Same timestamp for the first two and the last two prints, with seq order
    # against price order, so neither input order nor price order can pass.
    t = pd.DataFrame(
        {
            "ts": [
                T0,
                T0,
                T0 + pd.Timedelta(seconds=50),
                T0 + pd.Timedelta(seconds=50),
            ],
            "seq": [10, 11, 20, 21],
            "price": [7001.0, 7000.0, 7003.0, 7002.0],
            "size": [1, 1, 1, 1],
        }
    )
    got = fcr.rebuild_from_ticks(t.sample(frac=1, random_state=shuffle), ES).iloc[0]
    assert got.open == 7001.0  # seq 10 before seq 11
    assert got.close == 7002.0  # seq 21 after seq 20


def minute(i: int) -> pd.Timestamp:
    return T0 + pd.Timedelta(minutes=i)


def utc(stamp: str) -> pd.Timestamp:
    return pd.Timestamp(stamp, tz="UTC")


def test_bars_output_schema():
    minutes = fcr.rebuild_from_ticks(series([(7000.0, 7058.0), (7001.0, None)]), ES)
    # The stream started 50 s into minute 0.
    minutes = fcr.mark_partial(
        minutes, [(minute(0), minute(0) + pd.Timedelta(seconds=50))]
    )
    bars = fcr.bars_output(minutes, "ES", "ticks")
    assert list(bars.columns) == list(fcr.OUTPUT_COLUMNS)
    assert str(bars.ts.dtype) == "datetime64[us, UTC]"
    for col in ("open", "high", "low", "close"):
        assert bars[col].dtype == "float64"
    assert bars.volume.dtype == "int64"
    assert bars.n_clusters.dtype == "int64"
    assert bars.n_clusters.tolist() == [2, 1]
    # Phase 2 keeps the row's volume on a minute the stream only partly saw.
    assert bars.partial.dtype == "bool"
    assert bars.partial.tolist() == [True, False]
    assert set(bars.symbol) == {"ES"}
    assert set(bars.source) == {"ticks"}


def test_archive_bars_count_one_cluster_and_are_never_partial():
    front = front_minutes([("2026-04-08 14:30", 1, 2, 0, 1, 100)])
    bars = fcr.bars_output(fcr.archive_minutes(front), "ES", "archive")
    assert bars.n_clusters.tolist() == [1]
    assert bars.n_clusters.dtype == "int64"
    assert bars.partial.tolist() == [False]


def rows_at(*stamps: str) -> pd.DataFrame:
    """A minutes frame with one row per UTC minute (mark_partial reads only ts)."""
    return pd.DataFrame({"ts": pd.to_datetime(list(stamps), utc=True)})


def partial_of(stamps: list[str], gaps) -> dict[str, bool]:
    marked = fcr.mark_partial(rows_at(*stamps), gaps)
    return dict(zip(stamps, marked.partial.tolist(), strict=True))


def every_second(start: str, end: str) -> pd.Series:
    return pd.Series(pd.date_range(utc(start), utc(end), freq="1s"))


def test_the_coverage_edges_of_the_span_are_partial():
    # The stream started 53 s into 01:56 and stopped 30 s into 14:11, as on the
    # real span's first and last minutes.
    span = (utc("2026-06-15 13:50"), utc("2026-06-15 14:12"))
    first, last = utc("2026-06-15 13:50:53"), utc("2026-06-15 14:11:30")
    gaps = fcr.stream_gaps([(first, last, [])], span)
    assert gaps == [(span[0], first), (last, span[1])]
    got = partial_of(
        [
            "2026-06-15 13:50",
            "2026-06-15 13:51",
            "2026-06-15 14:10",
            "2026-06-15 14:11",
        ],
        gaps,
    )
    assert list(got.values()) == [True, False, False, True]


def test_an_interior_drop_out_is_partial():
    # A Tuesday 13:00Z (08:00 CT) restart: 45 s without a tick.
    stamps = pd.concat(
        [
            every_second("2026-05-26 12:59:00", "2026-05-26 13:00:05"),
            every_second("2026-05-26 13:00:50", "2026-05-26 13:01:59"),
        ]
    )
    gaps = fcr.tick_gaps(stamps)
    assert gaps == [(utc("2026-05-26 13:00:05"), utc("2026-05-26 13:00:50"))]
    got = partial_of(["2026-05-26 12:59", "2026-05-26 13:00", "2026-05-26 13:01"], gaps)
    assert list(got.values()) == [False, True, False]


def test_a_fifteen_second_lull_is_not_partial():
    stamps = pd.concat(
        [
            every_second("2026-05-26 13:00:00", "2026-05-26 13:00:20"),
            every_second("2026-05-26 13:00:35", "2026-05-26 13:00:59"),
        ]
    )
    assert fcr.tick_gaps(stamps) == []


def test_a_silence_across_minutes_marks_both_edge_minutes():
    gaps = [(utc("2026-05-26 13:00:50"), utc("2026-05-26 13:02:10"))]
    got = partial_of(["2026-05-26 13:00", "2026-05-26 13:02", "2026-05-26 13:03"], gaps)
    assert list(got.values()) == [True, True, False]


@pytest.mark.parametrize(
    "day", ["2026-05-18", "2026-05-19", "2026-05-20", "2026-05-21"], ids=lambda d: d
)
def test_the_last_minute_before_the_daily_halt_is_not_partial(day):
    # Monday to Thursday. CDT: the 16:00-17:00 CT halt is 21:00-22:00Z.
    gaps = [(utc(f"{day} 20:59:59.9"), utc(f"{day} 22:00:00"))]
    got = partial_of([f"{day} 20:59", f"{day} 22:00"], gaps)
    assert list(got.values()) == [False, False]


TWENTY = pd.Timedelta(seconds=20)
SHADE_UNDER = pd.Timedelta(seconds=19.999)


def test_a_tick_gap_of_exactly_twenty_seconds_counts():
    a = utc("2026-05-26 13:00:00")
    assert fcr.tick_gaps(pd.Series([a, a + TWENTY])) == [(a, a + TWENTY)]
    assert fcr.tick_gaps(pd.Series([a, a + SHADE_UNDER])) == []


def test_a_span_edge_silence_of_exactly_twenty_seconds_counts():
    span = (utc("2026-06-15 13:50"), utc("2026-06-15 14:12"))
    first, last = span[0] + TWENTY, span[1] - SHADE_UNDER
    assert fcr.stream_gaps([(first, last, [])], span) == [(span[0], first)]


def test_an_open_part_of_exactly_twenty_seconds_makes_a_minute_partial():
    # The silence runs into the 21:00Z halt: 20 s of it is open market.
    exact = [(utc("2026-05-20 20:59:40"), utc("2026-05-20 22:00:00"))]
    assert partial_of(["2026-05-20 20:59"], exact) == {"2026-05-20 20:59": True}
    short = [(utc("2026-05-20 20:59:40.001"), utc("2026-05-20 22:00:00"))]
    assert partial_of(["2026-05-20 20:59"], short) == {"2026-05-20 20:59": False}


def test_an_outage_into_the_halt_counts_only_its_open_part():
    gaps = [(utc("2026-05-20 20:59:20"), utc("2026-05-20 22:00:00.2"))]
    got = partial_of(["2026-05-20 20:59", "2026-05-20 22:00"], gaps)
    assert list(got.values()) == [True, False]


def test_the_weekend_and_memorial_day_are_closed():
    weekend = [(utc("2026-05-15 20:59:59.3"), utc("2026-05-17 22:00:00"))]
    assert list(
        partial_of(["2026-05-15 20:59", "2026-05-17 22:00"], weekend).values()
    ) == [False, False]
    # 2026-05-25: halted from 12:00 CT (17:00Z) to the usual 17:00 CT reopen.
    holiday = [(utc("2026-05-25 16:59:59.5"), utc("2026-05-25 22:00:00"))]
    assert list(
        partial_of(["2026-05-25 16:59", "2026-05-25 22:00"], holiday).values()
    ) == [False, False]


def test_closures_follow_exchange_time():
    got = fcr.closures_between(utc("2026-05-25 12:00"), utc("2026-05-26 12:00"))
    # Memorial Day's early halt and the daily halt merge into one closure.
    assert got == [(utc("2026-05-25 17:00"), utc("2026-05-25 22:00"))]
    assert fcr.open_pieces(utc("2026-05-20 20:59:20"), utc("2026-05-20 22:00:30")) == [
        (utc("2026-05-20 20:59:20"), utc("2026-05-20 21:00")),
        (utc("2026-05-20 22:00"), utc("2026-05-20 22:00:30")),
    ]


def test_tickless_windows_include_the_span_start_and_the_halt():
    span = (utc("2026-04-20 01:56"), utc("2026-04-21 00:00"))
    gaps = [
        (span[0], utc("2026-04-20 02:37:10")),  # NQ's first tick
        (utc("2026-04-20 20:59:59.9"), utc("2026-04-20 22:00:00.1")),
    ]
    got = fcr.tickless_windows(gaps, span, "NQ")
    assert got.values.tolist() == [
        ["NQ", span[0], utc("2026-04-20 02:36"), 41, 41],
        ["NQ", utc("2026-04-20 21:00"), utc("2026-04-20 21:59"), 60, 0],
    ]


# ── The time-order pass ─────────────────────────────────────────────────────


def path(start: pd.Timestamp, points: list[tuple[float, float]], size: int = 1):
    """Prints at (seconds after start, price), seq in row order."""
    return ticks([(s, p, size) for s, p in points], start)


def merged_minute():
    """ES 04-21 20:09 in miniature: the front climbs 7094 -> 7140 in the minute
    while ESU6 prints one carry (62) above it, close enough to merge at G 17."""

    def front_at(i: int) -> float:  # 184 ticks (46 points) over 119 steps
        return 7094.0 + round(i * 184 / 119) * 0.25

    seed = path(minute(0), [(s, 7093.75) for s in range(0, 60, 5)])
    front = [(i * 0.5, front_at(i)) for i in range(120)]
    # ESU6 one carry above the front of that moment; the first, at 0.25 s, is
    # 7156: 16 above the front's 7140 top, so the clusters merge.
    back = [(s + 0.25, front_at(2 * s) + 62.0) for s in range(0, 60, 5)]
    body = path(minute(1), sorted(front + back))
    after = path(minute(2), [(s, 7140.0) for s in range(0, 60, 5)])
    t = pd.concat([seed, body, after], ignore_index=True)
    t["seq"] = range(len(t))
    return t, front, back


def test_the_walk_drops_back_prints_merged_into_the_front_cluster():
    t, front, back = merged_minute()
    unwalked, _ = fcr.build_minutes(t, ES)
    assert unwalked.iloc[1].clusters == 1  # the gap rule can't split them
    assert unwalked.iloc[1].high > 7150
    got = fcr.rebuild_from_ticks(t, ES).iloc[1]
    assert got.high == max(p for _, p in front) == 7140.0
    assert (got.open, got.low) == (7094.0, 7094.0)
    assert got.volume == len(front)
    assert got.dropped == len(back)
    assert got.clusters == 2  # the walk found the hidden second contract
    assert not (got.wick or got.step)


def test_the_walk_fixes_a_close_set_by_a_back_print():
    # The front sweeps 7294 -> 7340 -> 7295; the minute's last print is ESU6 at
    # 7357, within G of the sweep top. The next minute's front confirms it.
    sweep = [(s, 7294.0 + s * 2.3) for s in range(0, 21)]
    sweep += [(20 + s, 7340.0 - s * 1.25) for s in range(1, 37)]
    seed = path(minute(0), [(s, 7294.0) for s in range(0, 60, 5)])
    body = path(minute(1), [(s, round(p * 4) / 4) for s, p in sweep] + [(59.9, 7357.0)])
    after = path(minute(2), [(0.5, 7295.0), (30, 7296.0)])
    t = pd.concat([seed, body, after], ignore_index=True)
    t["seq"] = range(len(t))
    got = fcr.rebuild_from_ticks(t, ES).iloc[1]
    assert got.close == 7295.0
    assert got.high == 7340.0
    assert got.dropped == 1


def test_walk_front_needs_a_confirming_print_to_drop():
    prints = path(minute(1), [(1, 7300.0), (58, 7300.25), (59.9, 7361.0)])
    nothing_after = prints.iloc[:0]
    after = path(minute(2), [(1.0, 7300.5)])
    assert fcr.walk_front(prints, nothing_after, 7300.0, ES).tolist() == [
        True,
        True,
        True,
    ]
    assert fcr.walk_front(prints, after, 7300.0, ES).tolist() == [True, True, False]


def test_a_genuine_jump_in_the_front_is_kept():
    # +35 at 20 s, held for 20 s (no print comes back), then a drift down.
    points = [(s, 7300.0) for s in range(0, 20)]
    points += [(20 + s, 7335.0 + (s % 5)) for s in range(20)]
    points += [(40 + s, 7334.0 - s) for s in range(19)]
    seed = path(minute(0), [(s, 7300.0) for s in range(0, 60, 5)])
    t = pd.concat([seed, path(minute(1), points)], ignore_index=True)
    t["seq"] = range(len(t))
    got = fcr.rebuild_from_ticks(t, ES).iloc[1]
    assert got.dropped == 0
    assert (got.high, got.volume) == (7339.0, len(points))


def latch_case(first_high: float) -> pd.DataFrame:
    """Minute 0 is a non-walked bar closing at a back-month-ish 7030; minute 1
    opens on back prints, then trades the front at 7000; minute 2 is clean."""
    rows = pd.DataFrame(
        {
            "ts": [minute(0), minute(1), minute(2)],
            "open": [7000.0, 7058.0, 7000.0],
            "high": [first_high, 7059.0, 7001.0],
            "low": [7000.0, 7000.0, 7000.0],
            "close": [7030.0, 7002.0, 7001.0],
            "volume": [10, 6, 2],
            "clusters": [1, 1, 1],
            "front_absent": [False, False, False],
        }
    )
    body = path(
        minute(1),
        [
            (1, 7058.0),
            (2, 7000.0),
            (3, 7001.0),
            (10, 7059.0),
            (11, 7000.0),
            (59, 7002.0),
        ],
    )
    walk_prints = body.assign(minute=minute(1))
    return fcr.time_order_pass(rows, walk_prints, ES)


def test_a_bar_that_failed_the_post_check_never_seeds_the_walk():
    # Minute 0 fails (high 7062 is 32 above its close). Seeded from its 7030
    # close, the walk would take minute 1's first print, ESU6 at 7058.
    got = latch_case(first_high=7062.0)
    assert got.iloc[0].wick and not got.iloc[0].passed
    assert (got.iloc[1].open, got.iloc[1].high) == (7000.0, 7002.0)
    assert got.iloc[1].dropped == 2


def test_a_wrong_seed_cannot_outlive_its_minute():
    # The same minute 0 without the wick passes, so it seeds the walk and minute
    # 1 opens on the back print. The first front print pulls the level down:
    # the later back print is dropped and minute 2 is clean.
    got = latch_case(first_high=7030.0)
    assert got.iloc[0].passed
    assert got.iloc[1].open == 7058.0
    assert got.iloc[1].close == 7002.0
    assert got.iloc[1].dropped == 1
    assert (got.iloc[2].open, got.iloc[2].high) == (7000.0, 7001.0)


# Which minutes the walk visits (F-B): each trigger has a case only it catches.


def flat_minute(start: pd.Timestamp) -> pd.DataFrame:
    return ticks([(1, 7000.0, 1), (30, 7000.0, 1), (59, 7000.0, 1)], start)


def jump_minute(start: pd.Timestamp) -> pd.DataFrame:
    """Kept range 11, under CARRY_HALF. The first print (7040, 7 lots) is over
    CARRY_HALF above a 7000 close before it, and the next one (7029) is not:
    the walk drops 7040. The level, 7029.25, is within CARRY_HALF of 7000, so the
    minute is not front_absent."""
    return ticks(
        [(1, 7040.0, 7), (2, 7029.0, 1), (30, 7029.5, 2), (50, 7029.0, 1)], start
    )


def test_a_wide_merged_minute_after_a_gap_is_walked_on_its_range_alone():
    # merged_minute() with its body moved four minutes on: no contiguous
    # predecessor, and not the frame's first minute, so only the range calls for
    # the walk.
    t, front, back = merged_minute()
    t = t.assign(ts=t.ts.where(t.ts < minute(1), t.ts + pd.Timedelta(minutes=4)))
    got = fcr.rebuild_from_ticks(t, ES).iloc[1]
    assert got.ts == minute(5)
    assert got.high == max(p for _, p in front) == 7140.0
    assert got.dropped == len(back)


def test_a_narrow_minute_over_the_previous_low_is_walked():
    # Range 11 is not wide; only 7040 against the previous minute's low of 7000
    # (7000 + CARRY_HALF = 7030.375) calls for the walk.
    t = pd.concat([flat_minute(minute(0)), jump_minute(minute(1))], ignore_index=True)
    t["seq"] = range(len(t))
    got = fcr.rebuild_from_ticks(t, ES).iloc[1]
    assert (got.dropped, got.open, got.high, got.volume) == (1, 7029.0, 7029.5, 4)
    assert not (got.wick or got.step)


def test_the_first_minute_of_a_page_is_walked_without_seeing_the_page_before(
    monkeypatch,
):
    # Pages are UTC days read apart, so the walk can't compare this 00:00Z
    # minute with the 23:59 one on the other page.
    pages = {
        utc("2026-05-05"): flat_minute(utc("2026-05-05 23:59")),
        utc("2026-05-06"): jump_minute(utc("2026-05-06 00:00")),
    }
    empty = ticks([])
    monkeypatch.setattr(
        fcr, "fetch_tick_page", lambda _env, _cfg, lo, _hi: pages.get(lo, empty)
    )
    minutes, _ = fcr.run_tick_span(None, ES, 1, frozenset())
    got = minutes[minutes.ts == utc("2026-05-06 00:00")].iloc[0]
    assert (got.dropped, got.open, got.high, got.volume) == (1, 7029.0, 7029.5, 4)


def test_a_stale_close_from_before_an_outage_does_not_seed_the_walk():
    # Minute 0 closes at 7000, then four minutes without ticks. Minute 5 is wide
    # (31 points) and opens on a genuine 7032 print of 100 lots, 2 s before a
    # 7010. Seeded from the stale 7000 close, the walk would call 7032 (over
    # 7000 + CARRY_HALF) a back-month print that 7010 confirms and drop it.
    after = ticks(
        [(1, 7032.0, 100), (3, 7010.0, 1), (20, 7015.0, 1), (30, 7020.0, 1)]
        + [(50, 7041.0, 1)],
        minute(5),
    )
    t = pd.concat([flat_minute(minute(0)), after], ignore_index=True)
    t["seq"] = range(len(t))
    minutes = fcr.rebuild_from_ticks(t, ES)
    assert not minutes.front_absent.any()
    got = minutes.iloc[1]
    assert (got.dropped, got.open, got.high, got.volume) == (0, 7032.0, 7041.0, 104)


def walk_keeps(points: list[tuple[float, float]], seed: float = 7000.0):
    """walk_front over prints at (seconds into the minute, price); no look-ahead."""
    prints = path(minute(1), points)
    return fcr.walk_front(prints, prints.iloc[:0], seed, ES).tolist()


@pytest.mark.parametrize(
    ("points", "want"),
    [
        # Exactly CARRY_HALF (30.375) above the level is still the front.
        ([(1, 7030.375), (3, 7000.5)], [True, True]),
        ([(1, 7030.625), (3, 7000.5)], [False, True]),
        # The confirming print may sit exactly CARRY_HALF above the level too.
        ([(1, 7031.0), (3, 7030.375)], [False, True]),
        ([(1, 7031.0), (3, 7030.625)], [True, True]),
        # ...and exactly WALK_CONFIRM_SECONDS after the jump, not a shade later.
        ([(1, 7040.0), (6, 7000.5)], [False, True]),
        ([(1, 7040.0), (6.001, 7000.5)], [True, True]),
    ],
)
def test_walk_front_boundaries_are_exact(points, want):
    assert walk_keeps(points) == want


def archive_bars(rows: list[tuple[str, str, float, int]]):
    """OHLCV rows as (UTC minute, raw symbol, price, volume)."""
    return pd.DataFrame(
        {
            "ts": pd.to_datetime([r[0] for r in rows], utc=True),
            "symbol": [r[1] for r in rows],
            "open": [r[2] for r in rows],
            "high": [r[2] + 1 for r in rows],
            "low": [r[2] - 1 for r in rows],
            "close": [r[2] + 0.5 for r in rows],
            "volume": [r[3] for r in rows],
        }
    )


def test_archive_front_is_each_days_volume_leader():
    bars = archive_bars(
        [
            ("2026-04-06 14:30", "ESM6", 6600.0, 900),
            ("2026-04-06 14:30", "ESU6", 6655.0, 5),
            ("2026-04-06 14:31", "ESM6", 6601.0, 800),
            ("2026-04-06 14:32", "ESU6", 6656.0, 2),
            ("2026-04-07 14:30", "ESM6", 6610.0, 700),
            ("2026-04-07 14:30", "ESM6 C6475", 50.0, 9000),
            ("2026-04-07 14:30", "ESM6-ESU6", 55.0, 9000),
        ]
    )
    leaders = fcr.pick_front_by_day(bars, ES)
    assert leaders == {"2026-04-06": "ESM6", "2026-04-07": "ESM6"}
    front = fcr.archive_front_bars(bars, ES)
    assert len(front) == 3
    assert front.open.tolist() == [6600.0, 6601.0, 6610.0]
    assert front.volume.tolist() == [900, 800, 700]


def test_archive_leader_that_is_not_the_expected_contract_fails_loudly():
    bars = archive_bars(
        [
            ("2026-04-06 14:30", "ESM6", 6600.0, 900),
            ("2026-04-07 14:30", "ESM6", 6610.0, 100),
            ("2026-04-07 14:30", "ESU6", 6665.0, 400),
        ]
    )
    with pytest.raises(fcr.FrontMonthMismatch, match=r"2026-04-07.*ESU6.*ESM6"):
        fcr.pick_front_by_day(bars, ES)


def test_archive_with_no_outright_bars_fails_loudly():
    bars = archive_bars([("2026-04-06 14:30", "ESM6-ESU6", 55.0, 9)])
    with pytest.raises(fcr.FrontMonthMismatch, match="no ES outright"):
        fcr.pick_front_by_day(bars, ES)


def front_minutes(rows: list[tuple[str, float, float, float, float, int]]):
    return pd.DataFrame(
        {
            "ts": pd.to_datetime([r[0] for r in rows], utc=True),
            "open": [r[1] for r in rows],
            "high": [r[2] for r in rows],
            "low": [r[3] for r in rows],
            "close": [r[4] for r in rows],
            "volume": [r[5] for r in rows],
        }
    )


def test_compare_with_archive_counts_matches_misses_and_extras():
    archive = front_minutes(
        [
            ("2026-04-08 14:30", 1, 2, 0, 1, 100),
            ("2026-04-08 14:31", 1, 2, 0, 1, 100),
            ("2026-04-08 14:32", 1, 2, 0, 1, 100),
            ("2026-04-08 14:33", 1, 2, 0, 1, 100),
        ]
    )
    rebuilt = front_minutes(
        [
            ("2026-04-08 14:30", 1, 2, 0, 1, 100),  # exact
            ("2026-04-08 14:31", 1, 2, 0, 1.25, 101),  # close off; volume 1%
            ("2026-04-08 14:32", 1, 2, 0, 1, 98),  # OHLC exact; volume 2% off
            ("2026-04-08 14:34", 1, 2, 0, 1, 100),  # not in the archive
            ("2026-04-08 14:35", 59, 60, 58, 59, 3),  # front_absent: not a bar
        ]
    ).assign(
        front_absent=[False] * 4 + [True],
        clusters=[1, 2, 1, 1, 1],
        kept_gap=[0.25, 1.5, 0.5, None, 9.0],
        split_gap=[None, 55.0, None, None, None],
    )
    gt = fcr.compare_with_archive(rebuilt, archive, "ES")
    row = gt.iloc[0]
    assert (row.root, row.day) == ("ES", "2026-04-08")
    assert row.minutes == 5  # union of both sides' bars
    assert row.exact_ohlc == 2
    assert row.volume_within_1pct == 2
    assert row.rebuilt_only == 1
    assert row.archive_only == 1
    assert row.front_absent == 1
    assert row.multi_cluster == 1
    assert row.max_kept_gap == 1.5  # front_absent minutes don't count
    assert row.min_split_gap == 55.0


def test_gate_needs_both_rates_per_root():
    gt = pd.DataFrame(
        {
            "root": ["ES", "ES", "NQ"],
            "day": ["2026-04-08", "2026-04-09", "2026-04-08"],
            "minutes": [1000, 1000, 1000],
            "exact_ohlc": [1000, 999, 1000],
            "volume_within_1pct": [1000, 1000, 998],
        }
    )
    result = fcr.gate_result(gt)
    assert result["ES"]["passed"]
    assert result["ES"]["exact_rate"] == pytest.approx(0.9995)
    assert not result["NQ"]["passed"]
    assert result["NQ"]["volume_rate"] == pytest.approx(0.998)


def test_gate_fails_a_root_with_no_minutes():
    gt = pd.DataFrame(
        {
            "root": ["ES"],
            "day": ["2026-04-08"],
            "minutes": [0],
            "exact_ohlc": [0],
            "volume_within_1pct": [0],
        }
    )
    assert not fcr.gate_result(gt)["ES"]["passed"]


def test_tick_pages_are_utc_days_cut_to_the_span():
    pages = fcr.tick_pages(
        pd.Timestamp("2026-04-20 01:56", tz="UTC"),
        pd.Timestamp("2026-04-22 14:12", tz="UTC"),
    )
    assert pages == [
        (
            pd.Timestamp("2026-04-20 01:56", tz="UTC"),
            pd.Timestamp("2026-04-21 00:00", tz="UTC"),
        ),
        (
            pd.Timestamp("2026-04-21 00:00", tz="UTC"),
            pd.Timestamp("2026-04-22 00:00", tz="UTC"),
        ),
        (
            pd.Timestamp("2026-04-22 00:00", tz="UTC"),
            pd.Timestamp("2026-04-22 14:12", tz="UTC"),
        ),
    ]


def test_the_tick_span_ends_after_the_last_bad_minute():
    assert fcr.TICK_SPAN[0] == pd.Timestamp("2026-04-20 01:56", tz="UTC")
    # Exclusive end: the 14:11 bar-open minute is the last one in the span.
    assert fcr.TICK_SPAN[1] == pd.Timestamp("2026-06-15 14:12", tz="UTC")
    assert fcr.ARCHIVE_SPAN == (
        pd.Timestamp("2026-04-05 22:00", tz="UTC"),
        pd.Timestamp("2026-04-17 21:00", tz="UTC"),
    )


def test_per_day_summary_splits_by_utc_day():
    late = series([(7000.0, 7058.0)])
    early = minute_of(7001.0, start=pd.Timestamp("2026-05-06 00:00", tz="UTC"))
    t = pd.concat([late.assign(ts=late.ts + pd.Timedelta(hours=9, minutes=29)), early])
    t["seq"] = range(len(t))
    minutes = fcr.rebuild_from_ticks(t, ES)
    # The stream stopped 59 s into 00:00 and stayed down 40 s.
    silence = [(utc("2026-05-06 00:00:59"), utc("2026-05-06 00:01:39"))]
    summary = fcr.per_day_summary(fcr.mark_partial(minutes, silence), "ES", "ticks")
    assert summary.day.tolist() == ["2026-05-05", "2026-05-06"]
    assert summary.bars.tolist() == [1, 1]
    assert summary.multi_cluster.tolist() == [1, 0]
    assert summary.partial.tolist() == [0, 1]
    assert summary.prints.tolist() == [6, 4]
    assert summary.source.tolist() == ["ticks", "ticks"]
    assert summary.max_kept_gap.tolist() == [1.0, 1.0]
    assert summary.min_split_gap.iloc[0] == 57.0
    assert pd.isna(summary.min_split_gap.iloc[1])


def test_archive_summary_has_one_contract_and_no_print_counts():
    front = front_minutes([("2026-04-08 14:30", 1, 2, 0, 1, 100)])
    summary = fcr.per_day_summary(fcr.archive_minutes(front), "ES", "archive")
    row = summary.iloc[0]
    assert (row.bars, row.front_absent, row.source) == (1, 0, "archive")
    assert row.multi_cluster == 0
    assert row.partial == 0
    assert pd.isna(row.prints)


def test_archive_trades_reject_an_unknown_clock():
    with pytest.raises(ValueError, match="clock"):
        fcr.read_archive_trades(
            fcr.Path("unused"), ES, fcr.GROUND_TRUTH_SPAN, clock="ts_out"
        )


# ── main: the readers are replaced at the module boundary ───────────────────


def gate_table(
    es_exact: int = 1000, nq_exact: int = 1000, clock: str = "ts_recv"
) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "root": ["ES", "NQ"],
            "day": ["2026-04-08", "2026-04-08"],
            "clock": clock,
            "minutes": [1000, 1000],
            "exact_ohlc": [es_exact, nq_exact],
            "volume_within_1pct": [1000, 1000],
        }
    )


def both_clocks(recv: pd.DataFrame, event: pd.DataFrame) -> pd.DataFrame:
    return pd.concat([recv, event.assign(clock="ts_event")], ignore_index=True)


def must_not_run(*_args, **_kwargs):
    raise AssertionError("must not run after a failed gate")


def out_of(tmp_path) -> Path:
    return tmp_path / "out"


def staging_of(tmp_path) -> Path:
    return fcr.staging_dir(out_of(tmp_path))


def run_main(tmp_path, monkeypatch, gate: pd.DataFrame, *extra: str) -> int:
    monkeypatch.setattr(fcr, "resolve_env_file", lambda _: tmp_path / "unused.env")
    monkeypatch.setattr(fcr, "run_ground_truth", lambda _archive: gate)
    out = out_of(tmp_path)
    return fcr.main(["--archive", str(tmp_path), "--out-dir", str(out), *extra])


def manifest(folder: Path) -> dict:
    return json.loads((folder / "manifest.json").read_text(encoding="utf-8"))


def previous_output(out: Path) -> None:
    """A validated earlier run's folder: every output file, a day file, and a
    file of someone else's."""
    (out / "ndjson").mkdir(parents=True)
    for name in fcr.OUTPUT_FILES:
        (out / name).write_bytes(f"old {name}".encode())
    (out / "manifest.json").write_text(
        '{"status": "passed", "git": {"head": "old"}}\n', encoding="utf-8"
    )
    (out / "ndjson" / "ES-2026-04-20.ndjson").write_bytes(b"old day file\n")
    (out / "notes.txt").write_text("not ours", encoding="utf-8")


def tree(root: Path) -> dict[str, bytes | None]:
    """Every path under `root` with its bytes (None for a folder)."""
    return {
        p.relative_to(root).as_posix(): p.read_bytes() if p.is_file() else None
        for p in sorted(root.rglob("*"))
    }


def test_the_staging_folder_sits_next_to_the_output_folder():
    out = Path("elsewhere") / "futures-contract-repair"
    assert fcr.staging_dir(out) == Path("elsewhere") / "futures-contract-repair.staging"


def test_a_failed_gate_leaves_only_the_table_and_a_failed_manifest_in_staging(
    tmp_path, monkeypatch, capsys
):
    # A staging folder left by an earlier failed run must not survive to look
    # current: only the output files go, whatever else sits there stays.
    staging = staging_of(tmp_path)
    (staging / "ndjson").mkdir(parents=True)
    for name in (
        "rebuilt_bars.parquet",
        "per_day.csv",
        "front_absent.csv",
        "unsplittable.csv",
    ):
        (staging / name).write_text("stale", encoding="utf-8")
    (staging / "ndjson" / "ES-2026-04-20.ndjson").write_text("stale", encoding="utf-8")
    (staging / "notes.txt").write_text("not ours", encoding="utf-8")
    monkeypatch.setattr(fcr, "run_archive_span", must_not_run)
    monkeypatch.setattr(fcr, "run_tick_span", must_not_run)
    gate = both_clocks(gate_table(es_exact=998), gate_table())
    assert run_main(tmp_path, monkeypatch, gate) == 1
    written = pd.read_csv(staging / "ground_truth.csv")
    assert sorted(written.clock.unique()) == ["ts_event", "ts_recv"]
    assert len(written) == 4
    assert sorted(p.name for p in staging.iterdir()) == [
        "ground_truth.csv",
        "manifest.json",
        "ndjson",
        "notes.txt",
    ]
    assert list((staging / "ndjson").iterdir()) == []
    got = manifest(staging)
    assert (got["status"], got["reason"]) == ("failed", "ground-truth gate")
    assert got["gate"]["ts_recv"]["ES"]["passed"] is False
    assert got["git"]["head"]
    # The run says where the diagnostics are, and a first run makes no output folder.
    assert str(staging) in capsys.readouterr().err
    assert not out_of(tmp_path).exists()


def test_a_gate_table_missing_a_root_fails_the_run(tmp_path, monkeypatch):
    # ES alone passes on its own rates; NQ has no rows at all.
    monkeypatch.setattr(fcr, "run_archive_span", must_not_run)
    monkeypatch.setattr(fcr, "run_tick_span", must_not_run)
    only_es = both_clocks(gate_table().iloc[:1], gate_table().iloc[:1])
    assert run_main(tmp_path, monkeypatch, only_es) == 1
    got = manifest(staging_of(tmp_path))
    assert (got["status"], got["reason"]) == ("failed", "ground-truth gate")
    assert set(got["gate"]["ts_recv"]) == {"ES"}


@pytest.mark.parametrize("failure", ["gate", "post-check", "crash"])
def test_a_failed_run_leaves_the_previous_output_byte_identical(
    tmp_path, monkeypatch, failure
):
    out = out_of(tmp_path)
    previous_output(out)
    before = tree(out)
    monkeypatch.setattr(fcr, "run_archive_span", archive_span)
    gate = both_clocks(gate_table(), gate_table())
    if failure == "gate":
        gate = both_clocks(gate_table(es_exact=998), gate_table())
        monkeypatch.setattr(fcr, "run_archive_span", must_not_run)
        monkeypatch.setattr(fcr, "run_tick_span", must_not_run)
    elif failure == "post-check":
        monkeypatch.setattr(fcr, "run_tick_span", spiky_tick_span)
    else:

        def page_fails(*_args):
            raise RuntimeError("ES page 2026-05-05 failed")

        monkeypatch.setattr(fcr, "run_tick_span", page_fails)

    if failure == "crash":
        with pytest.raises(RuntimeError, match="page 2026-05-05 failed"):
            run_main(tmp_path, monkeypatch, gate)
    else:
        assert run_main(tmp_path, monkeypatch, gate) == 1

    assert tree(out) == before
    assert (staging_of(tmp_path) / "ground_truth.csv").is_file()
    if failure != "crash":
        assert manifest(staging_of(tmp_path))["status"] == "failed"


def tick_span_of(levels_for, gaps=()):
    """A run_tick_span stand-in built from synthetic minutes."""

    def tick_span(_env, cfg, _workers, allowlisted):
        minutes = fcr.rebuild_from_ticks(series(levels_for(cfg)), cfg, allowlisted)
        return fcr.mark_partial(minutes, list(gaps)), list(gaps)

    return tick_span


def archive_span(_archive, cfg):
    base = 6600.0 if cfg.symbol == "ES" else 24000.0
    return fcr.archive_minutes(
        front_minutes([("2026-04-08 14:30", base, base + 1, base - 1, base, 9)])
    )


def clean_levels(cfg):
    base = 7000.0 if cfg.symbol == "ES" else 28000.0
    carry = 60.0 if cfg.symbol == "ES" else 280.0
    levels = [(base + i, base + carry + i) for i in range(11)]
    levels[5] = (None, base + carry + 5)
    return levels


def test_a_passing_run_writes_every_output(tmp_path, monkeypatch):
    # The stream started 50 s into minute 0.
    late_start = [(minute(0), minute(0) + pd.Timedelta(seconds=50))]
    monkeypatch.setattr(fcr, "run_archive_span", archive_span)
    monkeypatch.setattr(fcr, "run_tick_span", tick_span_of(clean_levels, late_start))
    # The gate scores the ts_recv rows; the ts_event rows are on record only.
    gate = both_clocks(gate_table(), gate_table(es_exact=990, nq_exact=990))
    assert run_main(tmp_path, monkeypatch, gate) == 0

    out = out_of(tmp_path)
    got = manifest(out)
    assert got["status"] == "passed"
    assert got["roots"]["ES"] == {
        "front": "ESM6",
        "gap": 17.0,
        "carry": 60.75,
        "carry_half": 30.375,
    }
    assert got["post_check"] == {"listed": 0, "allowlisted": 0, "unsplittable": 0}
    assert got["ndjson_files"] == 4
    assert pd.read_csv(out / "unsplittable.csv").empty
    bars = pd.read_parquet(out / "rebuilt_bars.parquet")
    assert list(bars.columns) == list(fcr.OUTPUT_COLUMNS)
    assert len(bars) == 2 * (1 + 10)
    assert bars.groupby(["symbol", "source"]).size().to_dict() == {
        ("ES", "archive"): 1,
        ("ES", "ticks"): 10,
        ("NQ", "archive"): 1,
        ("NQ", "ticks"): 10,
    }
    clusters = bars.groupby("source")["n_clusters"].unique().to_dict()
    assert {k: v.tolist() for k, v in clusters.items()} == {
        "archive": [1],
        "ticks": [2],
    }
    partial = bars[bars.partial]
    assert partial[["symbol", "ts"]].values.tolist() == [
        ["ES", minute(0)],
        ["NQ", minute(0)],
    ]
    absent = pd.read_csv(out / "front_absent.csv")
    assert absent.symbol.tolist() == ["ES", "NQ"]
    assert set(pd.to_datetime(absent.ts)) == {T0 + pd.Timedelta(minutes=5)}
    per_day = pd.read_csv(out / "per_day.csv")
    cols = ["root", "source", "bars", "front_absent", "partial"]
    assert per_day[cols].values.tolist() == [
        ["ES", "archive", 1, 0, 0],
        ["ES", "ticks", 10, 1, 1],
        ["NQ", "archive", 1, 0, 0],
        ["NQ", "ticks", 10, 1, 1],
    ]
    files = sorted(p.name for p in (out / "ndjson").iterdir())
    assert files == [
        "ES-2026-04-08.ndjson",
        "ES-2026-05-05.ndjson",
        "NQ-2026-04-08.ndjson",
        "NQ-2026-05-05.ndjson",
    ]
    lines = (out / "ndjson" / "ES-2026-05-05.ndjson").read_bytes().split(b"\n")
    assert lines[-1] == b""  # LF-terminated, one object per line
    assert len(lines) == 11
    # The walk touched nothing, and the file says so rather than being absent.
    walked = pd.read_csv(out / "walked.csv")
    assert list(walked.columns) == WALKED_COLUMNS
    assert walked.empty
    # Every staged file moved out; the staging folder is gone.
    assert not staging_of(tmp_path).exists()


def passing_run(tmp_path, monkeypatch, *extra: str) -> int:
    monkeypatch.setattr(fcr, "run_archive_span", archive_span)
    monkeypatch.setattr(fcr, "run_tick_span", tick_span_of(clean_levels))
    gate = both_clocks(gate_table(), gate_table())
    return run_main(tmp_path, monkeypatch, gate, *extra)


def test_a_passing_run_replaces_the_previous_output(tmp_path, monkeypatch):
    out = out_of(tmp_path)
    previous_output(out)
    staging = staging_of(tmp_path)
    staging.mkdir()
    (staging / "notes.txt").write_text("not ours", encoding="utf-8")
    assert passing_run(tmp_path, monkeypatch) == 0
    # The manifest is the new run's, not the seeded one ("old" has no ndjson_files).
    got = manifest(out)
    assert got["status"] == "passed"
    assert got["git"]["head"] != "old"
    assert got["ndjson_files"] == 4
    assert len(pd.read_parquet(out / "rebuilt_bars.parquet")) == 22
    # The old day file is gone, not mixed in with the new ones.
    assert sorted(p.name for p in (out / "ndjson").iterdir()) == [
        "ES-2026-04-08.ndjson",
        "ES-2026-05-05.ndjson",
        "NQ-2026-04-08.ndjson",
        "NQ-2026-05-05.ndjson",
    ]
    # Only the run's own files are replaced, here and in the staging folder.
    assert (out / "notes.txt").read_text(encoding="utf-8") == "not ours"
    assert [p.name for p in staging.iterdir()] == ["notes.txt"]


def test_the_landed_manifest_times_the_run_through_the_promote(tmp_path, monkeypatch):
    staged = {}
    promote = fcr.promote_staged

    def slow_promote(staging, out_dir):
        staged["run_seconds"] = manifest(staging)["run_seconds"]
        promote(staging, out_dir)
        time.sleep(0.5)

    monkeypatch.setattr(fcr, "promote_staged", slow_promote)
    assert passing_run(tmp_path, monkeypatch) == 0
    # Both figures are rounded to 0.1 s, so allow for that.
    assert manifest(out_of(tmp_path))["run_seconds"] >= staged["run_seconds"] + 0.3


def test_ground_truth_only_never_replaces_the_output(tmp_path, monkeypatch, capsys):
    out = out_of(tmp_path)
    previous_output(out)
    before = tree(out)
    monkeypatch.setattr(fcr, "run_archive_span", must_not_run)
    monkeypatch.setattr(fcr, "run_tick_span", must_not_run)
    gate = both_clocks(gate_table(), gate_table())
    assert run_main(tmp_path, monkeypatch, gate, "--ground-truth-only") == 0
    assert tree(out) == before
    staging = staging_of(tmp_path)
    assert sorted(p.name for p in staging.iterdir()) == [
        "ground_truth.csv",
        "manifest.json",
    ]
    assert manifest(staging)["status"] == "gate-only"
    assert str(staging) in capsys.readouterr().out


def test_a_clean_that_fails_partway_never_leaves_a_passed_manifest(
    tmp_path, monkeypatch
):
    previous_output(tmp_path)
    unlink = Path.unlink

    def locked(self, missing_ok=False):
        if self.name == "rebuilt_bars.parquet":
            raise PermissionError("in use by another process")
        unlink(self, missing_ok=missing_ok)

    monkeypatch.setattr(Path, "unlink", locked)
    with pytest.raises(PermissionError):
        fcr.clean_outputs(tmp_path)
    assert not (tmp_path / "manifest.json").exists()


def test_a_replace_that_cannot_finish_points_at_the_staged_output(
    tmp_path, monkeypatch
):
    out = out_of(tmp_path)
    previous_output(out)
    replace = fcr.os.replace

    def locked(src, dst):
        if Path(dst) == out / "per_day.csv":
            raise PermissionError("in use by another process")
        replace(src, dst)

    monkeypatch.setattr(fcr.os, "replace", locked)
    with pytest.raises(RuntimeError, match=r"out\.staging"):
        passing_run(tmp_path, monkeypatch)
    # The folder is half-replaced, so it must not read as passed; the new
    # output is complete next to it.
    assert not (out / "manifest.json").exists()
    staging = staging_of(tmp_path)
    assert manifest(staging)["status"] == "passed"
    assert (staging / "per_day.csv").is_file()


WALKED_COLUMNS = [
    "symbol",
    "ts",
    "dropped_prints",
    "volume_before",
    "volume_after",
    "high_before",
    "high_after",
]


def fast_front_spike() -> pd.DataFrame:
    """The task-1 re-review's synthetic ES case (F-A): flat at 7000, a genuine
    front spike of 1,000 lots to 7036 at 20 s, 21 s, a retrace to 7020 at 23 s,
    then 7010 and 7005. The true bar is high 7036, volume 1,050."""
    rows = [(s, 7000.0, 4) for s in range(0, 20, 2)]
    rows += [(20, 7035.0, 500), (21, 7036.0, 500)]
    rows += [(23, 7020.0, 5), (25, 7010.0, 3), (30, 7005.0, 2)]
    return ticks(rows)


def test_the_walk_erases_a_fast_front_spike_and_walked_rows_report_it():
    minutes = fcr.rebuild_from_ticks(fast_front_spike(), ES)
    bar = minutes.iloc[0]
    # The 5 s confirmation reads the retrace as a back-month print coming back.
    assert (bar.high, bar.volume, bar.dropped) == (7020.0, 50, 2)
    assert (bar.high_before, bar.volume_before) == (7036.0, 1050)
    # The post-check can't see it: that is why walked.csv exists.
    assert not (bar.wick or bar.step) and bar.passed
    rows = fcr.walked_rows(minutes, "ES")
    assert list(rows.columns) == WALKED_COLUMNS
    assert rows.values.tolist() == [["ES", T0, 2, 1050, 50, 7036.0, 7020.0]]


def test_walked_csv_lists_the_spike_the_post_check_passes(tmp_path, monkeypatch):
    def tick_span(_env, cfg, _workers, allowlisted):
        t = fast_front_spike() if cfg.symbol == "ES" else minute_of(28000.0)
        minutes = fcr.rebuild_from_ticks(t, cfg, allowlisted)
        return fcr.mark_partial(minutes, []), []

    monkeypatch.setattr(fcr, "run_archive_span", archive_span)
    monkeypatch.setattr(fcr, "run_tick_span", tick_span)
    gate = both_clocks(gate_table(), gate_table())
    assert run_main(tmp_path, monkeypatch, gate) == 0
    out = out_of(tmp_path)
    assert manifest(out)["post_check"]["listed"] == 0
    walked = pd.read_csv(out / "walked.csv")
    assert walked.values.tolist() == [
        ["ES", "2026-05-05 14:30:00+00:00", 2, 1050, 50, 7036.0, 7020.0]
    ]


def test_walked_rows_lists_only_the_minutes_that_lost_prints():
    t, _, _ = merged_minute()
    minutes = fcr.rebuild_from_ticks(t, ES)
    rows = fcr.walked_rows(minutes, "ES")
    # Only the merged minute, with the back prints it lost.
    assert rows.ts.tolist() == [minute(1)]
    assert rows.dropped_prints.tolist() == [12]
    assert rows.high_after.iloc[0] < rows.high_before.iloc[0]


def test_ndjson_records_follow_the_phase_2_schema():
    bars = pd.DataFrame(
        {
            "symbol": ["ES", "ES", "NQ"],
            "ts": pd.to_datetime(
                ["2026-04-21 13:31", "2026-04-21 13:30", "2026-04-22 00:00"], utc=True
            ).astype("datetime64[us, UTC]"),
            "open": [7000.25, 7000.0, 28000.0],
            "high": [7001.0, 7000.5, 28001.0],
            "low": [7000.0, 6999.75, 27999.0],
            "close": [7000.75, 7000.25, 28000.5],
            "volume": [12, 3, 1],
            "n_clusters": [2, 1, 1],
            "partial": [False, True, False],
            "source": ["ticks", "ticks", "ticks"],
        }
    )
    files = fcr.ndjson_lines(bars)
    assert sorted(files) == ["ES-2026-04-21.ndjson", "NQ-2026-04-22.ndjson"]
    first = files["ES-2026-04-21.ndjson"][0]
    assert first == (
        '{"symbol":"ES","ts":"2026-04-21T13:30:00Z","open":7000.0,"high":7000.5,'
        '"low":6999.75,"close":7000.25,"volume":3,"source":"ticks","n_clusters":1,'
        '"partial":true}'
    )
    record = json.loads(files["NQ-2026-04-22.ndjson"][0])
    assert list(record) == [
        "symbol",
        "ts",
        "open",
        "high",
        "low",
        "close",
        "volume",
        "source",
        "n_clusters",
        "partial",
    ]


# ── The post-check ──────────────────────────────────────────────────────────


def bars_frame(rows: list[tuple], absent=()):
    """(minute index, open, high, low, close) rows; one cluster, never walked."""
    return pd.DataFrame(
        {
            "ts": [minute(r[0]) for r in rows],
            "open": [r[1] for r in rows],
            "high": [r[2] for r in rows],
            "low": [r[3] for r in rows],
            "close": [r[4] for r in rows],
            "volume": [1] * len(rows),
            "clusters": [1] * len(rows),
            "front_absent": [r[0] in absent for r in rows],
        }
    )


def no_prints():
    return pd.DataFrame({c: [] for c in ("minute", "ts", "seq", "price", "size")})


EMPTY_ALLOWLIST = pd.DataFrame(
    {"symbol": [], "ts": pd.Series([], dtype="datetime64[us, UTC]"), "reason": []}
)


def test_the_post_check_flags_a_wick_and_a_step():
    rows = [
        (0, 7000.0, 7001.0, 6999.0, 7000.5),
        (1, 7000.5, 7031.0, 7000.0, 7000.25),  # high 30.5 above open/close: wick
        (2, 7000.25, 7001.0, 7000.0, 7000.75),
        (3, 7031.25, 7032.0, 7031.0, 7031.5),  # opens 30.5 above the close: step
        (5, 7100.0, 7101.0, 7099.0, 7100.5),  # after a tick-less minute: no step
    ]
    got = fcr.time_order_pass(bars_frame(rows), no_prints(), ES)
    assert got.wick.tolist() == [False, True, False, False, False]
    assert got.step.tolist() == [False, False, False, True, False]
    assert got.passed.tolist() == [True, False, True, False, True]
    # Exactly CARRY_HALF is not over it.
    edge = bars_frame([(0, 7000.0, 7030.375, 7000.0, 7000.0)])
    assert not fcr.time_order_pass(edge, no_prints(), ES).wick.iloc[0]


def test_the_step_limit_is_exactly_half_a_carry():
    flat = (0, 7000.0, 7000.0, 7000.0, 7000.0)
    on_edge = bars_frame([flat, (1, 7030.375, 7030.375, 7030.375, 7030.375)])
    over = bars_frame([flat, (1, 7030.5, 7030.5, 7030.5, 7030.5)])
    assert fcr.time_order_pass(on_edge, no_prints(), ES).step.tolist() == [False, False]
    assert fcr.time_order_pass(over, no_prints(), ES).step.tolist() == [False, True]


def test_the_post_check_never_lists_a_front_absent_minute():
    # time_order_pass leaves wick and step False on an absent minute, so only a
    # hand-built frame reaches the filter: it has to hold on its own.
    rows = [
        (0, 7000.0, 7001.0, 6999.0, 7000.5),
        (1, 7061.0, 7061.25, 7061.0, 7061.25),
        (2, 7000.5, 7001.0, 7000.0, 7000.75),
    ]
    minutes = bars_frame(rows, absent={1}).assign(
        wick=[False, True, False], step=[False, True, True], partial=False
    )
    listed = fcr.post_check_rows(minutes, "ES", EMPTY_ALLOWLIST)
    assert listed[["ts", "rule"]].values.tolist() == [[minute(2), "step"]]


def test_an_allowlisted_minute_passes_and_is_reported_as_such():
    rows = [(0, 7000.0, 7001.0, 6999.0, 7000.5), (1, 7000.5, 7031.0, 7000.0, 7000.25)]
    got = fcr.time_order_pass(bars_frame(rows), no_prints(), ES, frozenset({minute(1)}))
    assert got.wick.iloc[1] and got.passed.iloc[1]
    allowlist = pd.DataFrame(
        {"symbol": ["ES"], "ts": [minute(1)], "reason": ["08:30 ET data, 5 s slices"]}
    ).astype({"ts": "datetime64[us, UTC]"})
    listed = fcr.post_check_rows(got.assign(partial=False), "ES", allowlist)
    assert listed[["rule", "allowlisted", "reason"]].values.tolist() == [
        ["wick", True, "08:30 ET data, 5 s slices"]
    ]


def test_the_step_is_measured_across_front_absent_minutes():
    rows = [
        (0, 7000.0, 7001.0, 6999.0, 7000.5),
        (1, 7061.0, 7061.25, 7061.0, 7061.25),  # back-only, flagged absent
        (2, 7061.0, 7061.25, 7061.0, 7061.25),  # a back-only bar that escaped
    ]
    got = fcr.time_order_pass(bars_frame(rows, absent={1}), no_prints(), ES)
    assert got.step.tolist() == [False, False, True]


def back_run(length: int):
    """12 front minutes at 7000, `length` back-only minutes at 7061 (61 above,
    so a half-back neighbourhood sits just over CARRY_HALF), 12 front minutes."""
    levels = [(7000.0, None)] * 12 + [(None, 7061.0)] * length
    levels += [(7000.0, None)] * 12
    return fcr.rebuild_from_ticks(series(levels), ES)


def test_a_seven_minute_back_only_run_fails_the_post_check():
    minutes = back_run(7)
    run = [minute(12 + i) for i in range(7)]
    # The neighbour median sees front at the run's ends only; the middle five
    # see mostly back-month neighbours and pass as bars.
    assert list(minutes[minutes.front_absent].ts) == [run[0], run[-1]]
    listed = fcr.post_check_rows(minutes.assign(partial=False), "ES", EMPTY_ALLOWLIST)
    # Entering and leaving the run steps one carry: both are listed.
    assert listed[["ts", "rule"]].values.tolist() == [
        [run[1], "step"],
        [minute(19), "step"],
    ]


def test_a_four_minute_back_only_run_is_flagged_whole():
    minutes = back_run(4)
    assert list(minutes[minutes.front_absent].ts) == [minute(12 + i) for i in range(4)]


def test_front_absent_starts_at_exactly_half_a_carry():
    # A lone minute whose level (back + 0.125) sits 30.375 above the front
    # level (7000.25): exactly CARRY_HALF. A quarter lower is not flagged.
    for back, flagged in ((7030.5, True), (7030.25, False)):
        levels = [(7000.0, None)] * 6 + [(None, back)] + [(7000.0, None)] * 6
        minutes = fcr.rebuild_from_ticks(series(levels), ES)
        assert minutes.front_absent.iloc[6] == flagged


def test_the_reference_is_a_median_robust_to_one_wild_neighbour():
    # A back-only minute next to a wild minute 1,000 points up: a mean of the
    # neighbours would sit above the back month and miss it.
    levels = [(7000.0, None)] * 5 + [(None, 7061.0), (8000.0, None)]
    levels += [(7000.0, None)] * 5
    minutes = fcr.rebuild_from_ticks(series(levels), ES)
    assert minutes.front_absent.iloc[5]


def test_a_minutes_level_is_the_median_of_its_kept_prints():
    t = ticks([(1, 7000.0, 1), (2, 7000.25, 1), (3, 7010.0, 1)])
    assert fcr.rebuild_from_ticks(t, ES).iloc[0].level == 7000.25


def test_a_steep_steady_trend_flags_nothing():
    # +7 a minute: 35 over five minutes, more than CARRY_HALF, but each minute
    # sits in the middle of its neighbours (the lowest neighbour would not).
    levels = [(7000.0 + 7 * i, None) for i in range(40)]
    minutes = fcr.rebuild_from_ticks(series(levels), ES)
    assert not minutes.front_absent.any()


# ── main: post-check failure, allowlist, duplicates ─────────────────────────


def spiky_tick_span(_env, cfg, _workers, allowlisted):
    """Clean minutes, except minute 3: a front round trip of 40 (ES) / 200 (NQ),
    over CARRY_HALF above its open and close."""
    base = 7000.0 if cfg.symbol == "ES" else 28000.0
    spike = 40.0 if cfg.symbol == "ES" else 200.0
    frames = [minute_of(base, start=minute(i)) for i in range(6)]
    # Up and back in tenths of the spike, so the gap rule sees one contract.
    trip = [(1 + i, base + spike * i / 10) for i in range(11)]
    trip += [(12 + i, base + spike * (10 - i) / 10) for i in range(1, 11)]
    frames[3] = path(minute(3), trip)
    t = pd.concat(frames, ignore_index=True)
    t["seq"] = range(len(t))
    minutes = fcr.rebuild_from_ticks(t, cfg, allowlisted)
    return fcr.mark_partial(minutes, []), []


def test_an_unlisted_post_check_minute_fails_the_run(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(fcr, "run_archive_span", archive_span)
    monkeypatch.setattr(fcr, "run_tick_span", spiky_tick_span)
    gate = both_clocks(gate_table(), gate_table())
    assert run_main(tmp_path, monkeypatch, gate) == 1
    staging = staging_of(tmp_path)
    unsplittable = pd.read_csv(staging / "unsplittable.csv")
    assert unsplittable[["symbol", "rule"]].values.tolist() == [
        ["ES", "wick"],
        ["NQ", "wick"],
    ]
    assert (staging / "walked.csv").is_file()  # the walk's list is diagnostics too
    assert not (staging / "rebuilt_bars.parquet").exists()
    assert not (staging / "ndjson").exists()
    got = manifest(staging)
    assert (got["status"], got["reason"]) == ("failed", "post-check")
    assert got["post_check"] == {"listed": 2, "allowlisted": 0, "unsplittable": 2}
    assert str(staging) in capsys.readouterr().err
    assert not out_of(tmp_path).exists()


def test_an_allowlisted_post_check_minute_lets_the_run_pass(tmp_path, monkeypatch):
    allowlist = tmp_path / "allow.csv"
    allowlist.write_text(
        "symbol,ts,reason\n"
        f"ES,{minute(3).isoformat()},front round trip in 5 s slices\n"
        f"NQ,{minute(3).isoformat()},front round trip in 5 s slices\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(fcr, "run_archive_span", archive_span)
    monkeypatch.setattr(fcr, "run_tick_span", spiky_tick_span)
    gate = both_clocks(gate_table(), gate_table())
    assert run_main(tmp_path, monkeypatch, gate, "--allowlist", str(allowlist)) == 0
    out = out_of(tmp_path)
    listed = pd.read_csv(out / "post_check.csv")
    assert listed.allowlisted.tolist() == [True, True]
    assert manifest(out)["post_check"] == {
        "listed": 2,
        "allowlisted": 2,
        "unsplittable": 0,
    }


def test_an_allowlist_entry_needs_a_reason(tmp_path):
    path_ = tmp_path / "allow.csv"
    path_.write_text(
        f"symbol,ts,reason\nES,{minute(3).isoformat()},\n", encoding="utf-8"
    )
    with pytest.raises(ValueError, match="reason"):
        fcr.load_allowlist(path_)


def test_duplicate_minutes_stop_the_run(tmp_path, monkeypatch):
    def overlapping_archive(_archive, cfg):
        # The same minute as the first tick bar.
        row = (str(minute(0)), 1.0, 2.0, 0.0, 1.0, 9)
        return fcr.archive_minutes(front_minutes([row]))

    monkeypatch.setattr(fcr, "run_archive_span", overlapping_archive)
    monkeypatch.setattr(fcr, "run_tick_span", tick_span_of(clean_levels))
    with pytest.raises(RuntimeError, match="duplicate"):
        run_main(tmp_path, monkeypatch, both_clocks(gate_table(), gate_table()))


# ── The read-only Postgres path, against a fake psycopg2.connect ────────────


class FakeCursor:
    def __init__(self, con):
        self.con = con

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def execute(self, sql):
        self.con.statements.append(sql)

    def fetchone(self):
        return (self.con.read_only,)

    def mogrify(self, sql, params):
        return (sql % tuple(f"'{p}'" for p in params)).encode()

    def copy_expert(self, sql, buf):
        self.con.statements.append(sql)
        if self.con.copy_error is not None:
            raise self.con.copy_error
        buf.write(self.con.csv)


class FakeConnection:
    def __init__(self, read_only="on", csv="", copy_error=None):
        self.read_only = read_only
        self.csv = csv
        self.copy_error = copy_error
        self.statements: list[str] = []
        self.session = None
        self.closed = False

    def set_session(self, **kwargs):
        self.session = kwargs

    def cursor(self):
        return FakeCursor(self)

    def close(self):
        self.closed = True


@pytest.fixture
def fake_db(tmp_path, monkeypatch):
    """A fake connect: each call takes the next item of `script` (a
    FakeConnection to return, or an exception to raise)."""
    env = tmp_path / ".env.local"
    env.write_text("DATABASE_URL=postgresql://fake/none\n", encoding="utf-8")
    state = {"script": [], "calls": [], "env": env}

    def connect(dsn, options=None):
        state["calls"].append(options)
        item = state["script"].pop(0)
        if isinstance(item, BaseException):
            raise item
        return item

    monkeypatch.setattr(psycopg2, "connect", connect)
    monkeypatch.setattr(fcr.time, "sleep", lambda _s: None)
    return state


# Two ticks at 2026-04-20 13:56:00 and :01 UTC (epoch microseconds).
TICK_CSV = "11,1776693360000000,7000.25,3\n12,1776693361000000,7000.5,1\n"


def fetch(fake_db):
    return fcr.fetch_tick_page(fake_db["env"], ES, utc("2026-04-20"), utc("2026-04-21"))


def test_the_session_is_read_only_with_a_statement_timeout(fake_db):
    con = FakeConnection(csv=TICK_CSV)
    fake_db["script"] = [con]
    got = fetch(fake_db)
    assert got.seq.tolist() == [11, 12]
    assert str(got.ts.iloc[0]) == "2026-04-20 13:56:00+00:00"
    assert fake_db["calls"] == ["-c default_transaction_read_only=on"]
    assert con.session == {"readonly": True, "autocommit": False}
    assert con.statements[:3] == [
        "SET default_transaction_read_only = on",
        "SET LOCAL statement_timeout = 300000",
        "SHOW transaction_read_only",
    ]
    copy = con.statements[3]
    assert copy.startswith("COPY (SELECT id,")
    assert "FROM futures_trade_ticks" in copy
    assert copy.endswith(") TO STDOUT WITH (FORMAT csv)")
    assert len(con.statements) == 4  # only SET, SHOW and one COPY of a SELECT
    assert con.closed


def test_a_transaction_that_is_not_read_only_is_refused(fake_db):
    con = FakeConnection(read_only="off")
    fake_db["script"] = [con]
    with pytest.raises(RuntimeError, match="not read-only"):
        fcr.connect_readonly(fake_db["env"])
    assert con.closed
    assert not any(s.startswith("COPY") for s in con.statements)


def test_a_dropped_connection_is_retried_then_reraised(fake_db):
    fake_db["script"] = [
        psycopg2.OperationalError("down"),
        psycopg2.InterfaceError("gone"),
        FakeConnection(csv=TICK_CSV),
    ]
    assert len(fetch(fake_db)) == 2
    assert len(fake_db["calls"]) == fcr._PAGE_ATTEMPTS == 3
    fake_db["calls"].clear()
    fake_db["script"] = [psycopg2.OperationalError("down") for _ in range(3)]
    with pytest.raises(psycopg2.OperationalError):
        fetch(fake_db)
    assert len(fake_db["calls"]) == 3


def test_a_statement_timeout_is_not_retried(fake_db):
    timeout = psycopg2.errors.QueryCanceled("canceling statement due to timeout")
    con = FakeConnection(copy_error=timeout)
    fake_db["script"] = [con]
    with pytest.raises(psycopg2.errors.QueryCanceled):
        fetch(fake_db)
    assert len(fake_db["calls"]) == 1
    assert con.closed


def test_a_failed_page_is_named(monkeypatch):
    def fail(_env, _cfg, _lo, _hi):
        raise psycopg2.OperationalError("down")

    monkeypatch.setattr(fcr, "fetch_tick_page", fail)
    with pytest.raises(RuntimeError, match="ES page 2026-04-20 failed"):
        fcr.run_tick_span(None, ES, 1, frozenset())


def test_a_tick_span_without_ticks_stops_the_run(monkeypatch):
    empty = pd.DataFrame(
        {
            "ts": pd.Series([], dtype="datetime64[us, UTC]"),
            "seq": pd.Series([], dtype="int64"),
            "price": pd.Series([], dtype="float64"),
            "size": pd.Series([], dtype="int64"),
        }
    )
    monkeypatch.setattr(fcr, "fetch_tick_page", lambda *_args: empty)
    with pytest.raises(RuntimeError, match="no ES ticks"):
        fcr.run_tick_span(None, ES, 2, frozenset())
