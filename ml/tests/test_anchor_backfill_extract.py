"""Tests for ml/src/anchor_backfill_extract.py (anchor-column history backfill).

The selection runs against a small local parquet built with the tape's column
names and types; DuckDB reads local and s3:// paths the same way. Neon and R2
are replaced at the module boundary (fetch_requests, fulltape_connection,
tape_url).
"""

from __future__ import annotations

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

import duckdb
import pytest

import anchor_backfill_extract as ex

DAY = "2026-10-28"
T0 = datetime(2026, 10, 28, 15, 0, 0, tzinfo=UTC)  # a bucket / trigger start
CHAIN = "SPY261030C00785000"
OTHER = "SPY261030P00780000"
# Handed to extract_date; never read, because fetch_requests is replaced below.
ENV_FILE = Path("unused.env.local")


def print_row(
    id_: str,
    when: str,
    *,
    chain: str = CHAIN,
    ticker: str = "SPY",
    price: float = 1.0,
    size: int = 1,
    canceled: bool = False,
    code: str | None = "slan",
    option_type: str = "call",
    strike: float = 785.0,
):
    """One tape row; `when` is e.g. '15:00:01.123456' on DAY (UTC)."""
    return (
        id_,
        ticker,
        chain,
        option_type,
        strike,
        "2026-10-30",
        f"{DAY} {when}+00",
        price,
        size,
        canceled,
        code,
    )


def write_tape(path: Path, rows: list[tuple]) -> str:
    con = duckdb.connect()
    con.execute(
        """CREATE TABLE t (id VARCHAR, underlying_symbol VARCHAR,
           option_chain_id VARCHAR, option_type VARCHAR, strike DOUBLE,
           expiry DATE, executed_at TIMESTAMPTZ, price DOUBLE, size INTEGER,
           canceled BOOLEAN, upstream_condition_detail VARCHAR)"""
    )
    con.executemany("INSERT INTO t VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)
    con.execute(f"COPY t TO '{path.as_posix()}' (FORMAT parquet)")
    con.close()
    return path.as_posix()


def sb_request(chain: str = CHAIN, ticker: str = "SPY", bucket: datetime = T0):
    """One Silent Boom request: window [bucket, bucket + 5 min)."""
    return ex.build_requests([], [(7, ticker, chain, bucket)])


def select(tmp_path: Path, rows: list[tuple], requests=None) -> list[dict]:
    tape = write_tape(tmp_path / "tape.parquet", rows)
    con = duckdb.connect()
    try:
        return ex.select_anchors(
            con, tape, requests if requests is not None else sb_request()
        )
    finally:
        con.close()


# ── Anchor selection ────────────────────────────────────────────────────────


def test_highest_notional_wins(tmp_path):
    rows = [
        print_row("small", "15:00:01.000000", price=1.0, size=1),
        print_row("big", "15:00:02.000000", price=2.0, size=5),
        print_row("mid", "15:00:03.000000", price=3.0, size=2),
    ]
    (record,) = select(tmp_path, rows)
    assert record["anchor"]["wsTradeId"] == "big"


def test_notional_is_an_exact_integer_not_a_float_product(tmp_path):
    # 0.07 x 3 and 0.21 x 1 are both 2100 in 1/10000ths: an exact tie, so the
    # earlier print wins. The DOUBLE product 0.07 * 3 = 0.21000000000000002
    # would put the later 3-lot ahead.
    assert 0.07 * 3 > 0.21
    rows = [
        print_row("early", "15:00:01.000000", price=0.21, size=1),
        print_row("late", "15:00:01.001000", price=0.07, size=3),
    ]
    (record,) = select(tmp_path, rows)
    assert record["anchor"]["wsTradeId"] == "early"


def test_tie_goes_to_the_earlier_millisecond(tmp_path):
    rows = [
        print_row("later", "15:00:02.000000", price=1.0, size=2),
        print_row("earlier", "15:00:01.000000", price=2.0, size=1),
    ]
    (record,) = select(tmp_path, rows)
    assert record["anchor"]["wsTradeId"] == "earlier"


def test_tie_within_a_millisecond_goes_to_the_earlier_microsecond(tmp_path):
    rows = [
        print_row("a-late-us", "15:00:01.000900", price=1.0, size=2),
        print_row("z-early-us", "15:00:01.000100", price=1.0, size=2),
    ]
    (record,) = select(tmp_path, rows)
    assert record["anchor"]["wsTradeId"] == "z-early-us"


def test_tie_in_the_same_microsecond_goes_to_the_lower_id(tmp_path):
    rows = [
        print_row("b", "15:00:01.000100", price=1.0, size=2),
        print_row("a", "15:00:01.000100", price=1.0, size=2),
    ]
    (record,) = select(tmp_path, rows)
    assert record["anchor"]["wsTradeId"] == "a"


def test_canceled_print_is_never_the_anchor(tmp_path):
    rows = [
        print_row("cancelled", "15:00:01.000000", price=9.0, size=9, canceled=True),
        print_row("live", "15:00:02.000000", price=1.0, size=1),
    ]
    (record,) = select(tmp_path, rows)
    assert record["anchor"]["wsTradeId"] == "live"


def test_zero_price_is_no_anchor_but_is_a_sibling(tmp_path):
    rows = [
        print_row(
            "legA", "15:00:01.000000", chain=CHAIN, price=2.0, size=10, code="mlet"
        ),
        print_row(
            "wing", "15:00:01.000400", chain=OTHER, price=0.0, size=10, code="mlet"
        ),
    ]
    (record,) = select(tmp_path, rows)
    assert record["anchor"]["wsTradeId"] == "legA"
    assert {s["wsTradeId"] for s in record["siblings"]} == {"legA", "wing"}

    # Only a zero-priced print on the chain: no anchor at all.
    (none_record,) = select(
        tmp_path, [print_row("zero", "15:00:01.000000", price=0.0, size=10)]
    )
    assert none_record["anchor"] is None
    assert none_record["siblings"] == []


def test_ticker_mismatch_on_the_same_chain_string_gives_no_anchor(tmp_path):
    rows = [print_row("x", "15:00:01.000000", ticker="SPYG")]
    (record,) = select(tmp_path, rows, sb_request(ticker="SPY"))
    assert record["anchor"] is None


def test_other_chain_is_ignored(tmp_path):
    rows = [print_row("x", "15:00:01.000000", chain=OTHER, price=50.0, size=50)]
    (record,) = select(tmp_path, rows)
    assert record["anchor"] is None


# ── Window bounds ───────────────────────────────────────────────────────────


def test_window_start_is_inclusive_end_is_exclusive(tmp_path):
    rows = [
        print_row("before", "14:59:59.999900", price=9.0, size=9),  # trunc .999 < start
        print_row("at-start", "15:00:00.000000", price=1.0, size=1),
        print_row("at-end", "15:05:00.000000", price=9.0, size=9),
    ]
    (record,) = select(tmp_path, rows)
    assert record["anchor"]["wsTradeId"] == "at-start"


def test_bounds_apply_after_millisecond_truncation(tmp_path):
    # end - 1 us truncates to end - 1 ms: inside. end + 500 us truncates to
    # exactly the end millisecond: outside.
    rows = [
        print_row("inside", "15:04:59.999999", price=1.0, size=1),
        print_row("outside", "15:05:00.000500", price=9.0, size=9),
    ]
    (record,) = select(tmp_path, rows)
    assert record["anchor"]["wsTradeId"] == "inside"


def test_sub_millisecond_window_start_rounds_up_to_the_next_millisecond(tmp_path):
    # The live table keeps ms-truncated times, so with start = :00.000500 the
    # stored :00.000 is before start and the first qualifying ms is :00.001.
    bucket = datetime(2026, 10, 28, 15, 0, 0, 500, tzinfo=UTC)
    rows = [
        print_row("trunc-before", "15:00:00.000700", price=9.0, size=9),
        print_row("next-ms", "15:00:00.001000", price=1.0, size=1),
    ]
    (record,) = select(tmp_path, rows, sb_request(bucket=bucket))
    assert record["anchor"]["wsTradeId"] == "next-ms"


def test_lottery_window_is_trigger_plus_minus_30_seconds(tmp_path):
    requests = ex.build_requests([(3, "SPY", CHAIN, T0)], [])
    rows = [
        print_row("lo-out", "14:59:29.999000", price=9.0, size=9),
        print_row("lo-in", "14:59:30.000000", price=1.0, size=1),
        print_row("hi-out", "15:00:30.000000", price=9.0, size=9),
    ]
    (record,) = select(tmp_path, rows, requests)
    assert record["table"] == "lottery_finder_fires"
    assert record["id"] == 3
    assert record["anchor"]["wsTradeId"] == "lo-in"


# ── Siblings ────────────────────────────────────────────────────────────────


def test_siblings_are_same_ticker_same_millisecond_multi_leg_only(tmp_path):
    rows = [
        print_row(
            "anchor", "15:00:01.123456", chain=CHAIN, price=2.0, size=9, code="mlet"
        ),
        print_row(
            "same-ms-other-us",
            "15:00:01.123999",
            chain=OTHER,
            price=1.0,
            size=1,
            code="MLAT",
        ),
        print_row(
            "other-ms", "15:00:01.124000", chain=OTHER, price=1.0, size=1, code="mlet"
        ),
        print_row(
            "single-code",
            "15:00:01.123500",
            chain=OTHER,
            price=1.0,
            size=1,
            code="slan",
        ),
        print_row(
            "no-code", "15:00:01.123600", chain=OTHER, price=1.0, size=1, code=None
        ),
        print_row(
            "cancelled",
            "15:00:01.123700",
            chain=OTHER,
            price=1.0,
            size=1,
            code="mlet",
            canceled=True,
        ),
        print_row(
            "other-ticker",
            "15:00:01.123800",
            ticker="QQQ",
            chain="QQQ261030C00500000",
            code="mlet",
        ),
    ]
    (record,) = select(tmp_path, rows)
    assert record["anchor"]["wsTradeId"] == "anchor"
    # Anchor included; ordered by microsecond.
    assert [s["wsTradeId"] for s in record["siblings"]] == [
        "anchor",
        "same-ms-other-us",
    ]


def test_non_multi_leg_anchor_gets_no_siblings(tmp_path):
    rows = [
        print_row("anchor", "15:00:01.123456", price=2.0, size=9, code="slan"),
        print_row("mlet-same-ms", "15:00:01.123999", chain=OTHER, code="mlet"),
    ]
    (record,) = select(tmp_path, rows)
    assert record["siblings"] == []


def test_two_requests_sharing_a_millisecond_each_get_the_siblings(tmp_path):
    rows = [
        print_row("a1", "15:00:01.000100", chain=CHAIN, price=2.0, size=9, code="mlet"),
        print_row(
            "leg2", "15:00:01.000200", chain=OTHER, price=1.0, size=1, code="mlet"
        ),
    ]
    requests = ex.build_requests([], [(1, "SPY", CHAIN, T0), (2, "SPY", OTHER, T0)])
    records = select(tmp_path, rows, requests)
    # Request 2's anchor is leg2 (also multi-leg), same ms.
    assert [len(r["siblings"]) for r in records] == [2, 2]


def test_every_request_gets_a_line_even_without_an_anchor(tmp_path):
    requests = ex.build_requests([(1, "SPY", CHAIN, T0)], [(2, "SPY", OTHER, T0)])
    rows = [print_row("only", "15:00:01.000000")]
    records = select(tmp_path, rows, requests)
    assert [(r["table"], r["id"], r["anchor"] is None) for r in records] == [
        ("lottery_finder_fires", 1, False),
        ("silent_boom_alerts", 2, True),
    ]


# ── Output shape ────────────────────────────────────────────────────────────


def test_tape_print_fields_types_and_empty_code_to_null(tmp_path):
    rows = [
        print_row(
            "p1",
            "15:00:01.123456",
            price=1.25,
            size=3,
            code="",
            option_type="put",
            strike=780.5,
        )
    ]
    (record,) = select(tmp_path, rows, sb_request())
    anchor = record["anchor"]
    assert set(anchor) == {
        "wsTradeId",
        "optionChain",
        "optionType",
        "strike",
        "expiry",
        "executedAt",
        "price",
        "size",
        "tradeCode",
    }
    assert anchor == {
        "wsTradeId": "p1",
        "optionChain": CHAIN,
        "optionType": "P",
        "strike": 780.5,
        "expiry": "2026-10-30",
        "executedAt": "2026-10-28T15:00:01.123Z",
        "price": 1.25,
        "size": 3,
        "tradeCode": None,
    }
    assert isinstance(anchor["size"], int)
    assert isinstance(anchor["strike"], float)


def test_iso_ms_zero_pads_milliseconds():
    assert ex.iso_ms(1_700_000_000_007) == "2023-11-14T22:13:20.007Z"


def test_ndjson_file_is_atomic_lf_and_one_json_object_per_line(tmp_path):
    out = tmp_path / "out" / "2026-10-28.ndjson"
    records = [
        {"table": "lottery_finder_fires", "id": 1, "anchor": None, "siblings": []}
    ]
    ex.write_ndjson_atomic(out, records)
    raw = out.read_bytes()
    assert b"\r" not in raw
    assert [json.loads(line) for line in raw.decode().splitlines()] == records
    assert not list(out.parent.glob("*.tmp"))


# ── Per-date run (Neon and R2 replaced at the module boundary) ──────────────


@pytest.fixture
def patched(monkeypatch, tmp_path):
    tape = write_tape(
        tmp_path / "tape.parquet",
        [
            print_row("lf-anchor", "15:00:01.500000", code="mlet", price=2.0, size=5),
            print_row(
                "lf-leg2",
                "15:00:01.500200",
                chain=OTHER,
                code="mlet",
                price=1.0,
                size=5,
            ),
        ],
    )
    monkeypatch.setattr(ex, "tape_url", lambda date: tape)
    monkeypatch.setattr(ex, "fulltape_connection", lambda **kwargs: duckdb.connect())
    monkeypatch.setattr(
        ex,
        "fetch_requests",
        lambda date, env_file: (
            [(11, "SPY", CHAIN, T0)],
            [(22, "SPY", "SPY261030C00999000", T0)],
        ),
    )
    return tmp_path / "out"


def test_extract_date_writes_ndjson_and_reports_counts(patched):
    stats = ex.extract_date(DAY, patched, ENV_FILE)
    assert (stats["lf"], stats["sb"], stats["anchors"]) == (1, 1, 1)
    assert (stats["multi_leg"], stats["siblings"]) == (1, 2)
    lines = [
        json.loads(x) for x in (patched / f"{DAY}.ndjson").read_text().splitlines()
    ]
    assert [(r["table"], r["id"]) for r in lines] == [
        ("lottery_finder_fires", 11),
        ("silent_boom_alerts", 22),
    ]
    assert lines[1]["anchor"] is None
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2} lf=1 sb=1 .*", ex.format_stats(stats))


def test_extract_date_skips_an_existing_output_without_touching_neon(
    monkeypatch, patched
):
    (patched).mkdir(parents=True)
    (patched / f"{DAY}.ndjson").write_text("keep\n")

    def boom(date, env_file):
        raise AssertionError("must not query Neon for a skipped date")

    monkeypatch.setattr(ex, "fetch_requests", boom)
    assert ex.extract_date(DAY, patched, ENV_FILE) == {"date": DAY, "skipped": True}
    assert (patched / f"{DAY}.ndjson").read_text() == "keep\n"


def test_extract_date_force_redoes_an_existing_output(patched):
    patched.mkdir(parents=True)
    (patched / f"{DAY}.ndjson").write_text("stale\n")
    stats = ex.extract_date(DAY, patched, ENV_FILE, force=True)
    assert stats["skipped"] is False
    assert "stale" not in (patched / f"{DAY}.ndjson").read_text()


def test_a_neon_failure_surfaces_and_leaves_no_output(monkeypatch, patched):
    def reject(date, env_file):
        raise RuntimeError("connection lost")

    monkeypatch.setattr(ex, "fetch_requests", reject)
    with pytest.raises(RuntimeError, match="connection lost"):
        ex.extract_date(DAY, patched, ENV_FILE)
    assert not (patched / f"{DAY}.ndjson").exists()


def test_a_date_with_no_pending_rows_writes_an_empty_file(monkeypatch, patched):
    monkeypatch.setattr(ex, "fetch_requests", lambda date, env_file: ([], []))
    stats = ex.extract_date(DAY, patched, ENV_FILE)
    assert stats["anchors"] == 0
    assert (patched / f"{DAY}.ndjson").read_text() == ""


def test_extract_date_hands_its_env_file_to_the_neon_query(monkeypatch, patched):
    seen: list[tuple] = []

    def fetch(date, env_file):
        seen.append((date, env_file))
        return ([], [])

    monkeypatch.setattr(ex, "fetch_requests", fetch)
    ex.extract_date(DAY, patched, ENV_FILE)
    assert seen == [(DAY, ENV_FILE)]


def test_fetch_requests_connects_through_the_guarded_helper(monkeypatch):
    seen: list[Path] = []

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, sql, params):
            pass

        def fetchall(self):
            return []

    class Connection:
        closed = False

        def cursor(self):
            return Cursor()

        def close(self):
            self.closed = True

    con = Connection()

    def connect(env_file):
        seen.append(env_file)
        return con

    monkeypatch.setattr(ex, "connect_neon", connect)
    assert ex.fetch_requests(DAY, ENV_FILE) == ([], [])
    assert seen == [ENV_FILE]
    assert con.closed


def test_extract_date_hands_its_worker_share_to_the_duckdb_connection(
    monkeypatch, patched
):
    seen: dict = {}

    def connect(**kwargs):
        seen.update(kwargs)
        return duckdb.connect()

    monkeypatch.setattr(ex, "fulltape_connection", connect)
    ex.extract_date(DAY, patched, ENV_FILE, threads=3, memory_limit="900MiB")
    assert seen == {"threads": 3, "memory_limit": "900MiB"}


def test_main_splits_the_machine_across_the_workers(monkeypatch, patched, capsys):
    monkeypatch.setattr(ex, "resolve_env_file", lambda p: Path(__file__))
    monkeypatch.setattr(ex, "load_env_local", lambda p: None)
    monkeypatch.setattr(ex, "list_landed_dates", lambda: [DAY])
    monkeypatch.setattr(ex, "ProcessPoolExecutor", ThreadPoolExecutor)
    monkeypatch.setattr(ex.os, "cpu_count", lambda: 16)
    monkeypatch.setattr(ex, "total_ram_bytes", lambda: 64 * 2**30)
    seen: list[tuple] = []

    def record(date, out_dir, env_file, force, threads, memory_limit):
        seen.append((date, env_file, threads, memory_limit))
        return {"date": date, "skipped": True}

    monkeypatch.setattr(ex, "extract_date", record)
    assert ex.main(["--dates", DAY, "--workers", "4", "--out", str(patched)]) == 0
    # 16 cores / 4 workers; 64 GiB * 0.6 / 4 = 9830.4 MiB, rounded down. Every
    # worker gets the env file main resolved, for the database-mismatch guard.
    assert seen == [(DAY, Path(__file__), 4, "9830MiB")]
    assert "per worker: threads=4 memory_limit=9830MiB" in capsys.readouterr().out


def test_main_exits_nonzero_and_names_the_failed_date(monkeypatch, patched, capsys):
    monkeypatch.setattr(ex, "resolve_env_file", lambda p: Path(__file__))
    monkeypatch.setattr(ex, "load_env_local", lambda p: None)
    monkeypatch.setattr(ex, "list_landed_dates", lambda: ["2026-10-27", DAY])
    monkeypatch.setattr(ex, "ProcessPoolExecutor", ThreadPoolExecutor)

    def fetch(date, env_file):
        if date == "2026-10-27":
            raise RuntimeError("neon down")
        return ([], [])

    monkeypatch.setattr(ex, "fetch_requests", fetch)
    code = ex.main(["--dates", "2026-10-27", DAY, "--out", str(patched)])
    err = capsys.readouterr().err
    assert code == 1
    assert "2026-10-27 FAILED" in err and "neon down" in err
    assert (patched / f"{DAY}.ndjson").exists()


# ── Per-worker DuckDB resources ─────────────────────────────────────────────

GIB = 2**30


@pytest.mark.parametrize(
    ("workers", "cpus", "ram_gib", "expected"),
    [
        # 16 cores / 4; 64 GiB * 0.6 / 4 = 9830.4 MiB, rounded down.
        (4, 16, 64, (4, "9830MiB")),
        # One worker keeps all the cores and 60% of RAM (19660.8 MiB).
        (1, 8, 32, (8, "19660MiB")),
        # More workers than cores: one thread each, never zero.
        (6, 4, 64, (1, "6553MiB")),
        (2, 1, 16, (1, "4915MiB")),
        # Uneven split rounds the threads down: 10 // 4.
        (4, 10, 64, (2, "9830MiB")),
        # A nonsense worker count is treated as one worker.
        (0, 8, 16, (8, "9830MiB")),
        # A small machine still gets a usable floor.
        (8, 8, 2, (1, "512MiB")),
    ],
)
def test_worker_resources_split_cores_and_sixty_percent_of_ram(
    monkeypatch, workers, cpus, ram_gib, expected
):
    monkeypatch.setattr(ex.os, "cpu_count", lambda: cpus)
    monkeypatch.setattr(ex, "total_ram_bytes", lambda: ram_gib * GIB)
    assert ex.worker_resources(workers) == expected


def test_all_workers_together_stay_within_the_machine(monkeypatch):
    monkeypatch.setattr(ex.os, "cpu_count", lambda: 16)
    monkeypatch.setattr(ex, "total_ram_bytes", lambda: 64 * GIB)
    for workers in range(1, 17):
        threads, limit = ex.worker_resources(workers)
        assert threads * workers <= 16
        assert ex.parse_size(limit) * workers <= 0.6 * 64 * GIB


def test_worker_resources_treat_an_unknown_core_count_as_one(monkeypatch):
    monkeypatch.setattr(ex.os, "cpu_count", lambda: None)
    monkeypatch.setattr(ex, "total_ram_bytes", lambda: 64 * GIB)
    assert ex.worker_resources(4) == (1, "9830MiB")


def test_worker_resources_default_to_this_machine():
    threads, limit = ex.worker_resources(2)
    assert threads >= 1
    assert ex.parse_size(limit) >= 512 * 2**20


def test_parse_size_reads_duckdbs_memory_limit_format():
    assert ex.parse_size("512MiB") == 512 * 2**20
    assert ex.parse_size("24.9 GiB") == int(24.9 * 2**30)
    assert ex.parse_size("2GB") == 2_000_000_000
    assert ex.parse_size("1 tib") == 2**40
    for bad in ("", "lots", "10", "10 parsecs"):
        with pytest.raises(ValueError, match="cannot parse size"):
            ex.parse_size(bad)


def test_total_ram_is_read_back_from_duckdbs_default_limit():
    # DuckDB defaults to 80% of RAM, so any real machine reports well over 1 GiB.
    assert ex.total_ram_bytes() > GIB


# ── Neon connection ─────────────────────────────────────────────────────────


class FakeNeonConnection:
    def __init__(self) -> None:
        self.session: dict | None = None

    def set_session(self, **kwargs) -> None:
        self.session = kwargs


# Two distinct fake URLs. The marker words must never reach an error message.
URL_A = "postgresql://owner:hunter2-AAA@ep-a.neon.invalid/db"
URL_B = "postgresql://owner:hunter2-BBB@ep-b.neon.invalid/db"
URL_MARKERS = ("hunter2", "ep-a", "ep-b", "neon.invalid", "postgresql://")


@pytest.fixture
def env_files(monkeypatch, tmp_path):
    """(repo-root .env, --env-file), neither written yet.

    utils.load_env reads <ML_ROOT>/../.env; ML_ROOT is pointed at tmp_path/ml so
    that file is tmp_path/.env and the real checkout's one is never read.
    """
    import utils

    monkeypatch.setattr(utils, "ML_ROOT", tmp_path / "ml")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    return tmp_path / ".env", tmp_path / "env.local"


@pytest.fixture
def get_connection_spy(monkeypatch):
    """Replaces utils.get_connection; .calls counts the connects attempted."""
    import utils

    class Spy:
        con = FakeNeonConnection()
        calls = 0

        def __call__(self):
            self.calls += 1
            return self.con

    spy = Spy()
    monkeypatch.setattr(utils, "get_connection", spy)
    return spy


def test_connect_neon_reuses_the_retrying_helper_and_is_read_only(
    env_files, get_connection_spy
):
    dotenv, env_file = env_files
    dotenv.write_text(f"DATABASE_URL={URL_A}\n")
    env_file.write_text(f'DATABASE_URL="{URL_A}"\n')  # as `vercel env pull` writes it
    assert ex.connect_neon(env_file) is get_connection_spy.con
    assert get_connection_spy.calls == 1
    assert get_connection_spy.con.session == {"readonly": True, "autocommit": True}


def test_connect_neon_connects_when_the_environment_matches_the_env_file(
    monkeypatch, env_files, get_connection_spy
):
    # No repo-root .env: main()'s load_env_local put the file's URL in os.environ.
    _, env_file = env_files
    env_file.write_text(f"DATABASE_URL={URL_A}\n")
    monkeypatch.setenv("DATABASE_URL", URL_A)
    assert ex.connect_neon(env_file) is get_connection_spy.con


@pytest.mark.parametrize(
    "case",
    [
        "dotenv_overrides",
        "environment_differs",
        "file_defines_none",
        "environment_none",
    ],
)
def test_connect_neon_refuses_when_the_env_files_disagree_on_the_database(
    case, monkeypatch, env_files, get_connection_spy
):
    dotenv, env_file = env_files
    if case == "dotenv_overrides":
        dotenv.write_text(f"DATABASE_URL={URL_A}\n")
        env_file.write_text(f"DATABASE_URL={URL_B}\n")
    elif case == "environment_differs":
        env_file.write_text(f"DATABASE_URL={URL_B}\n")
        monkeypatch.setenv("DATABASE_URL", URL_A)
    elif case == "file_defines_none":
        dotenv.write_text(f"DATABASE_URL={URL_A}\n")
        env_file.write_text("R2_BUCKET_FULLTAPE=tape\n")
    else:  # the env file names a database, nothing else resolves one
        env_file.write_text(f"DATABASE_URL={URL_B}\n")

    with pytest.raises(RuntimeError) as raised:
        ex.connect_neon(env_file)

    message = str(raised.value)
    assert get_connection_spy.calls == 0  # refused before any connect
    assert "disagree on DATABASE_URL" in message
    assert str(env_file) in message and str(dotenv) in message
    for marker in URL_MARKERS:
        assert marker not in message


def test_connect_neon_raises_instead_of_exiting_when_it_cannot_connect(
    monkeypatch, env_files
):
    import utils

    dotenv, env_file = env_files
    dotenv.write_text(f"DATABASE_URL={URL_A}\n")
    env_file.write_text(f"DATABASE_URL={URL_A}\n")

    def exhausted():
        raise SystemExit(1)

    monkeypatch.setattr(utils, "get_connection", exhausted)
    with pytest.raises(
        RuntimeError, match=r"^could not connect to Neon \(see the output above\)$"
    ):
        ex.connect_neon(env_file)


def test_parse_env_file_strips_quotes_comments_and_blank_lines(tmp_path):
    env_file = tmp_path / "env.local"
    env_file.write_text(
        "# a comment\n"
        "\n"
        "PLAIN=one\n"
        'QUOTED="two"\n'
        "SINGLE='three'\n"
        "TRAILING=four # why\n"
        "NO_EQUALS_LINE\n"
        "PLAIN=ignored\n"
    )
    assert ex.parse_env_file(env_file) == {
        "PLAIN": "one",
        "QUOTED": "two",
        "SINGLE": "three",
        "TRAILING": "four",
    }


def test_load_env_local_fills_gaps_and_never_overwrites(monkeypatch, tmp_path):
    env_file = tmp_path / "env.local"
    env_file.write_text("KEPT=from-file\nFRESH=from-file\nKEPT=again\n")
    environ = {"KEPT": "from-shell"}
    monkeypatch.setattr(os, "environ", environ)  # a scratch copy, nothing leaks
    ex.load_env_local(env_file)
    assert environ == {"KEPT": "from-shell", "FRESH": "from-file"}


def test_the_env_file_override_variable_is_gone(monkeypatch, tmp_path):
    shadow = tmp_path / "shadow.env"
    shadow.write_text("X=1\n")
    monkeypatch.setenv("ANCHOR_BACKFILL_ENV_FILE", str(shadow))
    assert ex.resolve_env_file(None) != shadow


@pytest.fixture
def fallback_env_files(monkeypatch, tmp_path):
    """(this checkout's .env.local, the main checkout's), both written.

    REPO_ROOT points at tmp_path/checkout and `git rev-parse --git-common-dir`
    answers tmp_path/main/.git, so the real repo's production .env.local is
    never a candidate.
    """
    from types import SimpleNamespace

    checkout, main = tmp_path / "checkout", tmp_path / "main"
    (main / ".git").mkdir(parents=True)
    checkout.mkdir()
    own, shared = checkout / ".env.local", main / ".env.local"
    own.write_text("DATABASE_URL=checkout\n")
    shared.write_text("DATABASE_URL=main\n")
    monkeypatch.setattr(ex, "REPO_ROOT", checkout)
    monkeypatch.setattr(
        ex.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(stdout=f"{main / '.git'}\n"),
    )
    return own, shared


def test_resolve_env_file_refuses_a_missing_explicit_path_over_the_fallbacks(
    fallback_env_files, tmp_path
):
    missing = tmp_path / "typo.env"
    with pytest.raises(SystemExit) as raised:
        ex.resolve_env_file(str(missing))
    assert raised.value.code == f"--env-file {missing} not found"


def test_resolve_env_file_refuses_an_explicit_directory(fallback_env_files, tmp_path):
    with pytest.raises(SystemExit, match="not found"):
        ex.resolve_env_file(str(tmp_path))


def test_resolve_env_file_returns_an_existing_explicit_path(
    fallback_env_files, tmp_path
):
    explicit = tmp_path / "chosen.env"
    explicit.write_text("DATABASE_URL=chosen\n")
    assert ex.resolve_env_file(str(explicit)) == explicit


def test_resolve_env_file_without_a_path_prefers_this_checkout_then_the_main_one(
    fallback_env_files,
):
    own, shared = fallback_env_files
    assert ex.resolve_env_file(None) == own
    own.unlink()
    assert ex.resolve_env_file(None) == shared
    shared.unlink()
    assert ex.resolve_env_file(None) is None


# ── Dates and keys ──────────────────────────────────────────────────────────


def test_landed_dates_keep_only_exact_day_keys():
    keys = [
        "fulltape/2026-10-28-fulltape.parquet",
        "fulltape/2026-01-02-fulltape.parquet",
        "fulltape/_superseded/2026-10-28-abc123.parquet",
        "fulltape/_unavailable/2026-10-29.json",
        "fulltape/2026-10-29-fulltape.parquet.tmp",
        "gexbot-eod/SPX/2026-10-28.zip",
        "fulltape/2026-10-28-fulltape.parquet",
    ]
    assert ex.landed_dates(keys) == ["2026-01-02", "2026-10-28"]


def test_select_dates_restricts_to_landed_and_rejects_unlanded():
    landed = ["2026-10-26", "2026-10-27", "2026-10-28"]
    assert ex.select_dates(landed, None, "2026-10-27", None) == [
        "2026-10-27",
        "2026-10-28",
    ]
    assert ex.select_dates(landed, None, None, "2026-10-26") == ["2026-10-26"]
    assert ex.select_dates(landed, ["2026-10-28"], None, None) == ["2026-10-28"]
    with pytest.raises(ValueError, match="no landed tape for: 2026-07-01"):
        ex.select_dates(landed, ["2026-07-01"], None, None)
    with pytest.raises(ValueError, match="bad date"):
        ex.select_dates(landed, ["10/28"], None, None)


def test_naive_datetime_is_rejected():
    with pytest.raises(ValueError, match="naive"):
        ex.window_ms(datetime(2026, 10, 28, 15, 0), datetime(2026, 10, 28, 15, 5))


# ── Drift guard ─────────────────────────────────────────────────────────────


def test_multi_leg_codes_match_the_ts_list():
    """MULTI_LEG_TRADE_CODES equals api/_lib/multileg-codes.ts."""
    ts_path = Path(__file__).resolve().parents[2] / "api" / "_lib" / "multileg-codes.ts"
    if not ts_path.is_file():
        pytest.skip(f"{ts_path} not present (partial checkout)")
    src = ts_path.read_text(encoding="utf-8")
    match = re.search(r"MULTI_LEG_TRADE_CODES[^=]*=\s*\[(.*?)\]", src, re.DOTALL)
    assert match, "MULTI_LEG_TRADE_CODES array not found in TS file"
    body = re.sub(r"//[^\n]*", "", match.group(1))
    assert set(re.findall(r"'([a-z]+)'", body)) == set(ex.MULTI_LEG_TRADE_CODES)
