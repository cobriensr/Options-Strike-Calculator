"""Tests for ml/src/futures_contract_repair.py (ES/NQ front-month rebuild).

Synthetic frames only: no database, no archive files. The DB and file readers
(fetch_tick_day, read_archive_bars, read_archive_trades) are never called.
"""

from __future__ import annotations

import pandas as pd
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
    assert ES.gap == 25.0
    assert NQ.gap > ES.gap


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


def test_bars_output_schema():
    minutes = fcr.rebuild_from_ticks(series([(7000.0, 7058.0)] * 3), ES)
    bars = fcr.bars_output(minutes, "ES", "ticks")
    assert list(bars.columns) == list(fcr.OUTPUT_COLUMNS)
    assert str(bars.ts.dtype) == "datetime64[us, UTC]"
    for col in ("open", "high", "low", "close"):
        assert bars[col].dtype == "float64"
    assert bars.volume.dtype == "int64"
    assert set(bars.symbol) == {"ES"}
    assert set(bars.source) == {"ticks"}


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
    summary = fcr.per_day_summary(minutes, "ES", "ticks")
    assert summary.day.tolist() == ["2026-05-05", "2026-05-06"]
    assert summary.bars.tolist() == [1, 1]
    assert summary.multi_cluster.tolist() == [1, 0]
    assert summary.prints.tolist() == [6, 4]
    assert summary.source.tolist() == ["ticks", "ticks"]
    assert summary.max_kept_gap.tolist() == [1.0, 1.0]
    assert summary.min_split_gap.iloc[0] == 57.0
    assert pd.isna(summary.min_split_gap.iloc[1])


def test_archive_summary_leaves_cluster_and_print_counts_empty():
    front = front_minutes([("2026-04-08 14:30", 1, 2, 0, 1, 100)])
    summary = fcr.per_day_summary(fcr.archive_minutes(front), "ES", "archive")
    row = summary.iloc[0]
    assert (row.bars, row.front_absent, row.source) == (1, 0, "archive")
    assert pd.isna(row.multi_cluster)
    assert pd.isna(row.prints)


# ── main: the readers are replaced at the module boundary ───────────────────


def gate_table(es_exact: int = 1000, nq_exact: int = 1000) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "root": ["ES", "NQ"],
            "day": ["2026-04-08", "2026-04-08"],
            "minutes": [1000, 1000],
            "exact_ohlc": [es_exact, nq_exact],
            "volume_within_1pct": [1000, 1000],
        }
    )


def must_not_run(*_args, **_kwargs):
    raise AssertionError("must not run after a failed gate")


def run_main(tmp_path, monkeypatch, gate: pd.DataFrame) -> int:
    monkeypatch.setattr(fcr, "resolve_env_file", lambda _: tmp_path / "unused.env")
    monkeypatch.setattr(fcr, "run_ground_truth", lambda _archive: gate)
    out = tmp_path / "out"
    return fcr.main(["--archive", str(tmp_path), "--out-dir", str(out)])


def test_a_failed_gate_writes_the_table_and_no_bars(tmp_path, monkeypatch):
    monkeypatch.setattr(fcr, "run_archive_span", must_not_run)
    monkeypatch.setattr(fcr, "run_tick_span", must_not_run)
    assert run_main(tmp_path, monkeypatch, gate_table(es_exact=998)) == 1
    out = tmp_path / "out"
    assert len(pd.read_csv(out / "ground_truth.csv")) == 2
    assert not (out / "rebuilt_bars.parquet").exists()
    assert not (out / "per_day.csv").exists()


def test_a_passing_run_writes_every_output(tmp_path, monkeypatch):
    def archive_span(_archive, cfg):
        base = 6600.0 if cfg.symbol == "ES" else 24000.0
        return fcr.archive_minutes(
            front_minutes([("2026-04-08 14:30", base, base + 1, base - 1, base, 9)])
        )

    def tick_span(_env, cfg, _workers):
        base = 7000.0 if cfg.symbol == "ES" else 28000.0
        carry = 60.0 if cfg.symbol == "ES" else 280.0
        levels = [(base + i, base + carry + i) for i in range(11)]
        levels[5] = (None, base + carry + 5)
        return fcr.rebuild_from_ticks(series(levels), cfg)

    monkeypatch.setattr(fcr, "run_archive_span", archive_span)
    monkeypatch.setattr(fcr, "run_tick_span", tick_span)
    assert run_main(tmp_path, monkeypatch, gate_table()) == 0

    out = tmp_path / "out"
    bars = pd.read_parquet(out / "rebuilt_bars.parquet")
    assert list(bars.columns) == list(fcr.OUTPUT_COLUMNS)
    assert len(bars) == 2 * (1 + 10)
    assert bars.groupby(["symbol", "source"]).size().to_dict() == {
        ("ES", "archive"): 1,
        ("ES", "ticks"): 10,
        ("NQ", "archive"): 1,
        ("NQ", "ticks"): 10,
    }
    absent = pd.read_csv(out / "front_absent.csv")
    assert absent.symbol.tolist() == ["ES", "NQ"]
    assert set(pd.to_datetime(absent.ts)) == {T0 + pd.Timedelta(minutes=5)}
    per_day = pd.read_csv(out / "per_day.csv")
    assert per_day[["root", "source", "bars", "front_absent"]].values.tolist() == [
        ["ES", "archive", 1, 0],
        ["ES", "ticks", 10, 1],
        ["NQ", "archive", 1, 0],
        ["NQ", "ticks", 10, 1],
    ]
