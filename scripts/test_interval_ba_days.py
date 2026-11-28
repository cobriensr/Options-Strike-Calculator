"""scripts/_interval_ba_days.py: what the three Interval B/A readers share, and the day-file check.

The check runs over a `DayWorld` (scripts/_ba_test_support.py): day files as local Parquet, an R2
listing of them and of the tapes, and a clock. Three boundaries are patched there and nowhere
else (R3): the R2 client the listing goes through, `day_url` (so DuckDB reads local files), and the
tool's `write_replay_days`, which is the tool's own tested function (test_interval_ba_tape.py).
Nothing reaches R2 or Neon.

Run from the repo root with the ml venv:

    ml/.venv/Scripts/python -m pytest scripts/test_interval_ba_days.py -q
"""

from __future__ import annotations

import argparse
import csv
import re
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import _interval_ba_days as days
import duckdb
import interval_ba_tape as tool
import interval_ba_tape_runs as runs
import pyarrow.parquet as pq
import pytest
from _ba_test_support import DayWorld, day_alert, local_connection, write_day_file
from botocore.exceptions import ClientError

MON, TUE, WED, THU = date(2026, 11, 16), date(2026, 11, 17), date(2026, 11, 18), date(2026, 11, 19)
BACKFILL = "scripts/interval_ba_tape.py export --per-day"


@pytest.fixture
def day_world(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> DayWorld:
    return DayWorld(tmp_path / "days", monkeypatch)


@pytest.fixture
def con():
    db = local_connection()
    yield db
    db.close()


def check(con, first: date | None, last: date | None, *, dry_run: bool = False) -> days.DayFiles:
    return days.ensure_day_files(con, first, last, dry_run=dry_run)


def refused(con, first: date | None, last: date | None, *, dry_run: bool = False) -> str:
    """The message of the exit the check ends in."""
    with pytest.raises(SystemExit) as stopped:
        check(con, first, last, dry_run=dry_run)
    assert isinstance(stopped.value.code, str)
    return stopped.value.code


# --- the source arguments ---------------------------------------------------------------------


def parse(*argv: str) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    days.add_source_arguments(parser)
    args = parser.parse_args(argv)
    days.check_source_arguments(parser, args)
    return args


@pytest.mark.parametrize(
    ("argv", "source", "export_end"),
    [
        ((), "days", None),
        (("--source", "days"), "days", None),
        (("--source", "export"), "export", None),
        (("--source", "table"), "table", None),
        # Only the snapshot's date given: the snapshot, as the flag always meant.
        (("--export-end", "2026-11-25"), "export", "2026-11-25"),
        (("--source", "export", "--export-end", "2026-11-25"), "export", "2026-11-25"),
    ],
)
def test_readers_default_to_the_day_files_and_an_export_end_alone_means_the_snapshot(
    argv, source, export_end
):
    args = parse(*argv)

    assert (args.source, args.export_end) == (source, export_end)


@pytest.mark.parametrize("source", ["days", "table"])
def test_export_end_with_another_source_is_a_usage_error(source):
    with pytest.raises(SystemExit) as stopped:
        parse("--source", source, "--export-end", "2026-11-25")

    assert stopped.value.code == 2


@pytest.mark.parametrize("argv", [("--export-end", "2026-13-45"), ("--source", "files")])
def test_a_bad_source_or_date_is_a_usage_error(argv):
    with pytest.raises(SystemExit) as stopped:
        parse(*argv)

    assert stopped.value.code == 2


def test_dry_run_is_a_flag_that_is_off_by_default():
    assert parse().dry_run is False
    assert parse("--dry-run").dry_run is True


# --- the outcomes CSV: names and ids ----------------------------------------------------------


def test_day_file_outcomes_are_named_days_and_analyze_takes_its_own_source(tmp_path: Path):
    names = [
        "interval-ba-outcomes-20261120-100000.csv",  # the table's
        "interval-ba-outcomes-20261126-101500.csv",
        "interval-ba-outcomes-export-20261126-120000.csv",  # the snapshot's
        "interval-ba-outcomes-export-spy-20261126-121000.csv",
        "interval-ba-outcomes-days-20261126-110000.csv",  # the day files'
        "interval-ba-outcomes-days-20261127-090000.csv",
        "interval-ba-outcomes-days-spy-20261126-111000.csv",
        "interval-ba-outcomes-days-20261128-090000.csv.partial",  # a run that died
        "interval-ba-outcomes-spy-20261126-130000.csv",
        "interval-ba-outcomes-summary-days-20261127-090000.md",
    ]
    for name in names:
        (tmp_path / name).write_text("x", encoding="utf-8")

    def newest(ticker: str, source: str) -> str | None:
        found = days.newest_outcomes_csv(tmp_path, ticker, source)
        return found.name if found else None

    assert newest("SPXW", "days") == "interval-ba-outcomes-days-20261127-090000.csv"
    assert newest("SPY", "days") == "interval-ba-outcomes-days-spy-20261126-111000.csv"
    assert newest("SPXW", "export") == "interval-ba-outcomes-export-20261126-120000.csv"
    assert newest("SPY", "export") == "interval-ba-outcomes-export-spy-20261126-121000.csv"
    assert newest("SPXW", "table") == "interval-ba-outcomes-20261126-101500.csv"
    assert newest("SPY", "table") == "interval-ba-outcomes-spy-20261126-130000.csv"
    assert newest("QQQ", "days") is None
    assert days.outcomes_prefix("SPXW", "days") == "interval-ba-outcomes-days-"
    assert days.outcomes_prefix("SPY", "days") == "interval-ba-outcomes-days-spy-"
    assert days.outcomes_prefix("SPXW", "export") == "interval-ba-outcomes-export-"
    assert days.outcomes_prefix("QQQ", "table") == "interval-ba-outcomes-qqq-"
    assert [days.kind_of(source) for source in days.SOURCES] == ["-days", "-export", ""]


def test_each_source_reads_its_own_kind_of_alert_id():
    assert days.alert_id_reader("table", "t.csv")("12") == 12
    for source in ("days", "export"):
        assert days.alert_id_reader(source, "t.csv")("SPXW261117C06700000@1763410200") == (
            "SPXW261117C06700000@1763410200"
        )


@pytest.mark.parametrize("source", ["days", "export"])
def test_a_table_csv_under_an_export_style_source_names_the_mistake(source):
    read = days.alert_id_reader(source, "interval-ba-outcomes-20261126-100000.csv")

    with pytest.raises(SystemExit) as stopped:
        read("12")

    message = str(stopped.value.code)
    assert message.startswith("interval-ba-outcomes-20261126-100000.csv holds table alert ids")
    assert "'12'" in message
    assert "--source table" in message


def test_an_export_csv_under_the_table_source_names_the_mistake():
    read = days.alert_id_reader("table", "interval-ba-outcomes-days-20261126-100000.csv")

    with pytest.raises(SystemExit) as stopped:
        read("SPXW261117C06700000@1763410200")

    message = str(stopped.value.code)
    assert message.startswith(
        "interval-ba-outcomes-days-20261126-100000.csv holds export alert ids"
    )
    assert "--source export" in message


@pytest.mark.parametrize(
    ("source", "raw", "expected", "claims"),
    [
        # A blank or garbled id is its own fault, and does not say the CSV holds the other kind.
        ("days", "", "has a blank alert_id: expected an export alert id", "table alert ids"),
        ("export", "  ", "has a blank alert_id: expected an export alert id", "table alert ids"),
        ("days", "garbage", "an export alert id (<chain>@<epoch>): 'garbage'", "table alert ids"),
        ("days", "SPXW@abc", "an export alert id (<chain>@<epoch>): 'SPXW@abc'", "table alert ids"),
        ("table", "", "has a blank alert_id: expected a table alert id", "export alert ids"),
        ("table", "12x", "a table alert id (an integer): '12x'", "export alert ids"),
        ("table", "-5", "a table alert id (an integer): '-5'", "export alert ids"),
    ],
)
def test_a_blank_or_garbled_alert_id_is_named_for_what_it_is(source, raw, expected, claims):
    read = days.alert_id_reader(source, "out.csv")

    with pytest.raises(SystemExit) as stopped:
        read(raw)

    message = str(stopped.value.code)
    assert message.startswith("out.csv ")
    assert expected in message
    assert claims not in message


@pytest.mark.parametrize(
    ("source", "name", "other"),
    [
        ("days", "interval-ba-outcomes-export-20261126-110000.csv", "export"),
        ("days", "interval-ba-outcomes-export-spy-20261126-110000.csv", "export"),
        ("export", "interval-ba-outcomes-days-20261126-110000.csv", "days"),
    ],
)
def test_a_days_run_never_reads_a_snapshots_paths_and_the_reverse(source, name, other):
    """The two share an id format, so a join would half work: the CSV's name tells them apart."""
    with pytest.raises(SystemExit) as stopped:
        days.alert_id_reader(source, name)

    message = str(stopped.value.code)
    assert message.startswith(f"{name} was written for --source {other}")
    assert f"pass --source {other}" in message


@pytest.mark.parametrize(
    ("source", "name"),
    [
        ("days", "interval-ba-outcomes-days-20261126-110000.csv"),
        ("days", "my-own-copy.csv"),  # a renamed file is the owner's explicit act
        ("export", "interval-ba-outcomes-export-20261126-110000.csv"),
        ("table", "interval-ba-outcomes-export-20261126-110000.csv"),  # told apart by its ids
    ],
)
def test_a_csv_of_the_right_name_or_no_known_name_is_taken(source, name):
    assert callable(days.alert_id_reader(source, name))


def write_outcomes_csv(path: Path, fired: list[str]) -> Path:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["alert_id", "fired_at", "t_minutes", "pct_change"])
        for n, at in enumerate(fired):
            w.writerow([f"a{n}@1", at, 0, "0.1"])
            w.writerow([f"a{n}@1", at, 5, "0.2"])
    return path


def test_the_days_a_csv_covers_run_from_its_first_to_its_last_session_date_in_ct(tmp_path: Path):
    path = write_outcomes_csv(
        tmp_path / "o.csv",
        [
            "2026-11-17T20:50:00+00:00",
            "2026-11-16T14:31:00+00:00",
            "2026-11-18T01:30:00+00:00",  # 19:30 CT on the 17th: still that session's date
        ],
    )

    assert days.csv_days(path) == (date(2026, 11, 16), date(2026, 11, 17))


def test_a_csv_with_no_rows_has_no_days_to_read(tmp_path: Path):
    path = write_outcomes_csv(tmp_path / "empty.csv", [])

    with pytest.raises(SystemExit, match=r"empty\.csv has no rows"):
        days.csv_days(path)


# --- the banner -------------------------------------------------------------------------------


def test_the_method_banner_names_each_change_in_one_line():
    lines = days.METHOD_BANNER.splitlines()

    assert all(line.startswith(">") for line in lines)  # one Markdown blockquote
    assert "not comparable with reports from before" in lines[0]
    changes = [line for line in lines if re.match(r"> - \(\w\) ", line)]
    assert [line[5] for line in changes] == list("abcde")
    text = " ".join(changes)
    assert "t=0 is the root's last print at or before `fired_at`" in text
    assert "`fired_at` + 5k min" in text
    assert "default source is the replay day files" in text
    assert "backward only" in text
    assert "same instant counts" in text
    assert "early close" in text


# --- the parquet alert reader -----------------------------------------------------------------


def test_the_alert_columns_and_prefix_are_the_replay_modules():
    names = [name for name, _ in runs.ibr.EXPORT_COLUMNS]
    assert set(days.ALERT_COLUMNS) <= set(names)
    assert list(days.ALERT_COLUMNS) == [name for name in names if name in days.ALERT_COLUMNS]
    assert days.DAYS_PREFIX == runs.ibr.REPLAY_DAYS_PREFIX
    assert days.DAYS_PREFIX.endswith("/")
    assert days.TAPE_PREFIX == "fulltape/"


def test_day_url_is_the_buckets_object_for_that_day(monkeypatch):
    monkeypatch.setenv("R2_BUCKET_FULLTAPE", "tape-bucket")

    assert days.day_url(date(2026, 11, 25)) == (
        "s3://tape-bucket/research/interval-ba/replay/2026-11-25.parquet"
    )


@pytest.mark.parametrize("value", [None, "", "   "])
def test_day_url_without_a_bucket_exits_naming_the_variable(monkeypatch, value):
    if value is None:
        monkeypatch.delenv("R2_BUCKET_FULLTAPE", raising=False)
    else:
        monkeypatch.setenv("R2_BUCKET_FULLTAPE", value)

    with pytest.raises(SystemExit, match="R2_BUCKET_FULLTAPE"):
        days.day_url(MON)


def read_all(world: DayWorld, con, *session_days: date, **kwargs) -> list[dict[str, Any]]:
    files = days.DayFiles(
        days=tuple(session_days),
        urls=tuple(world.url(day) for day in session_days),
        repaired=(),
        unavailable=(),
        replay_version="1",
    )
    return days.read_day_alerts(con, files, **kwargs)


def test_the_day_files_are_read_as_one_source_in_fired_order(day_world, con):
    for day, clock in ((MON, "15:00:00"), (TUE, "14:35:00")):
        day_world.tape(day)
        day_world.file(day, [day_alert(day, clock), day_alert(day, "14:31:00", cp="P")])

    alerts = read_all(day_world, con, MON, TUE, ticker="SPXW")

    assert [a["option_chain"][-9] for a in alerts] == ["P", "C", "P", "C"]
    assert [a["fired_at"].date() for a in alerts] == [MON, MON, TUE, TUE]
    first = alerts[0]
    # The same keys and Python types as the table's rows, and an id the files can give.
    assert (
        first["id"]
        == f"SPXW{MON:%y%m%d}P06700000@{int(first['fired_at'].timestamp()) // 300 * 300}"
    )
    assert first["fired_at"].tzinfo is not None
    assert {"option_chain", "ticker", "strike", "expiry", "underlying_price"} <= set(first)
    assert "fired_us" not in first
    assert "bucket_us" not in first


def test_the_day_file_reader_filters_by_ticker_expiry_and_limit(day_world, con):
    for day in (MON, TUE):
        day_world.file(day, [day_alert(day, "14:40:00"), day_alert(day, "14:41:00", ticker="SPY")])

    everyone = read_all(day_world, con, MON, TUE, ticker=None)
    spy = read_all(day_world, con, MON, TUE, ticker="SPY")
    one_day = read_all(
        day_world, con, MON, TUE, ticker="SPXW", from_date="2026-11-17", to_date="2026-11-17"
    )
    first = read_all(day_world, con, MON, TUE, ticker=None, limit_alerts=1)

    assert [a["ticker"] for a in everyone] == ["SPXW", "SPY", "SPXW", "SPY"]
    assert {a["ticker"] for a in spy} == {"SPY"}
    assert [a["expiry"] for a in one_day] == [TUE]
    assert len(first) == 1


def test_a_day_file_without_the_columns_the_scripts_read_names_them(day_world, con):
    day_world.file(MON)
    path = Path(day_world.url(MON))
    pq.write_table(pq.read_table(path).drop_columns(["fired_at", "top_trade_is_floor"]), path)

    with pytest.raises(SystemExit, match=r"fired_at, top_trade_is_floor"):
        read_all(day_world, con, MON, ticker=None)


# --- the listing and the plan -----------------------------------------------------------------

T = datetime(2026, 11, 17, 7, 45, tzinfo=UTC)


def test_the_listings_are_read_by_their_exact_key_shapes():
    listing = days.parse_listing(
        {
            "research/interval-ba/replay/2026-11-16.parquet": T,
            "research/interval-ba/replay/2026-11-16.parquet.tmp": T,
            "research/interval-ba/replay/notes.parquet": T,
            "research/interval-ba/replay/2026-13-45.parquet": T,
            "research/interval-ba/replay/sub/2026-11-17.parquet": T,
            "research/interval-ba/replay-2026-11-17.parquet": T,  # the snapshot is not a day file
        },
        {
            "fulltape/2026-11-16-fulltape.parquet": T,
            "fulltape/2026-11-17-fulltape.parquet.part": T,
            "fulltape/_superseded/2026-11-16-abc123.parquet": T,
            "fulltape/_unavailable/2026-11-13.json": T,
            "fulltape/_unavailable/2026-11-14.txt": T,
            "fulltape/2026-99-99-fulltape.parquet": T,
        },
    )

    assert dict(listing.files) == {MON: T}
    assert dict(listing.tapes) == {MON: T}
    assert listing.unavailable == {date(2026, 11, 13)}


def test_each_needed_day_is_kept_missing_stale_unavailable_or_without_a_tape():
    early, late = T, T + timedelta(hours=1)
    listing = days.Listing(
        files={
            date(2026, 11, 2): late,  # a file after its tape: kept
            date(2026, 11, 3): early,  # a file older than its tape: stale
            date(2026, 11, 4): early,  # a file as old as its tape: kept
            date(2026, 11, 5): early,  # a file and no tape: nothing to be stale against
        },
        tapes={
            date(2026, 11, 2): early,
            date(2026, 11, 3): late,
            date(2026, 11, 4): early,
            date(2026, 11, 6): early,  # a tape and no file: missing
            date(2026, 11, 9): early,  # a tape, no file, and a marker too: the tape wins
        },
        unavailable=frozenset({date(2026, 11, 9), date(2026, 11, 10)}),  # 11-10: nothing else
    )
    needed = [date(2026, 11, d) for d in (2, 3, 4, 5, 6, 9, 10, 11)]

    p = days.plan(needed, listing)

    assert p.keep == (date(2026, 11, 2), date(2026, 11, 4), date(2026, 11, 5))
    assert p.stale == (date(2026, 11, 3),)
    assert p.missing == (date(2026, 11, 6), date(2026, 11, 9))
    assert p.unavailable == (date(2026, 11, 10),)
    assert p.no_tape == (date(2026, 11, 11),)
    assert p.to_repair == [date(2026, 11, 3), date(2026, 11, 6), date(2026, 11, 9)]


def test_a_kept_day_whose_footer_has_no_rows_moves_to_the_repair_list_as_its_own_reason():
    kept = (date(2026, 11, 2), date(2026, 11, 3), date(2026, 11, 4))
    p = days.Plan(keep=kept, missing=(date(2026, 11, 5),), stale=(), no_tape=(), unavailable=())
    footers = {day: days.Footer(day=day, rows=0 if day == kept[1] else 40, rule={}) for day in kept}

    after = days.with_empty(p, footers)

    assert after.keep == (kept[0], kept[2])
    assert after.empty == (kept[1],)
    assert after.missing == p.missing
    assert after.to_repair == [kept[1], date(2026, 11, 5)]


# --- the footers and the one-rule check -------------------------------------------------------


def test_the_footers_give_each_files_rule_and_row_count(day_world, con):
    day_world.file(MON)
    day_world.file(TUE, [], rule={"replay-version": "9"})

    footers = days.read_footers(con, {MON: day_world.url(MON), TUE: day_world.url(TUE)})

    assert footers[MON] == days.Footer(day=MON, rows=1, rule=day_world.rule)
    assert footers[TUE] == days.Footer(day=TUE, rows=0, rule={"replay-version": "9"})
    assert days.read_footers(con, {}) == {}


@pytest.mark.parametrize(
    "footer",
    [
        False,
        b"not json",
        b"[1, 2]",
        b'{"rows": 1}',
        b'{"day": "2026-11-17", "rule": {}, "rows": "3"}',
        b'{"day": "2026-11-17", "rule": {}, "rows": true}',
        b'{"rule": {}, "rows": 3}',
        b'{"day": 20261117, "rule": {}, "rows": 3}',
    ],
    ids=[
        "none",
        "garbage",
        "a list",
        "no rule",
        "rows as text",
        "rows as a flag",
        "no day",
        "day as a number",
    ],
)
def test_a_day_file_with_no_readable_footer_exits_naming_the_day(day_world, con, footer):
    day_world.file(MON)
    day_world.file(TUE, footer=footer)

    with pytest.raises(SystemExit) as stopped:
        days.read_footers(con, {MON: day_world.url(MON), TUE: day_world.url(TUE)})

    message = str(stopped.value.code)
    assert message.startswith("2026-11-17: the day file has no readable `interval_ba` footer")
    assert "2026-11-16" not in message
    assert BACKFILL in message
    assert "origin/main" in message


def test_a_day_file_whose_footer_names_another_day_exits_naming_it(day_world, con):
    """A file copied to the wrong key would be read as that day, and its alerts would appear
    twice beside the true day's file."""
    day_world.file(MON)
    write_day_file(Path(day_world.url(TUE)), MON, [day_alert(MON)], rule=day_world.rule)

    with pytest.raises(SystemExit) as stopped:
        days.read_footers(con, {MON: day_world.url(MON), TUE: day_world.url(TUE)})

    message = str(stopped.value.code)
    assert message.startswith("2026-11-17: the day file's footer names another day (2026-11-16)")
    assert BACKFILL in message


def test_a_footer_read_that_fails_names_its_class_and_never_its_text(day_world, con):
    class Failing:
        def execute(self, *_args, **_kwargs):
            raise duckdb.HTTPException(
                "HTTP GET error reading https://account-0123.r2.example.invalid"
            )

    with pytest.raises(SystemExit) as stopped:
        days.read_footers(Failing(), {MON: day_world.url(MON)})

    message = str(stopped.value.code)
    assert message.startswith("Reading the day files' footers failed: HTTPException")
    assert "account-0123" not in message


def test_readers_refuse_mixed_rules_and_name_the_days(day_world, con):
    other = {**day_world.rule, "replay-version": "2"}
    for day in (MON, TUE, WED):
        day_world.tape(day)
    day_world.file(MON)
    day_world.file(TUE, rule=other)
    day_world.file(WED)

    message = refused(con, MON, WED)

    assert message.startswith("The day files are not one study: they hold 2 different rules.")
    assert (
        f"rule 1 (replay-version {day_world.rule['replay-version']}): 2026-11-16, 2026-11-18"
        in message
    )
    assert "rule 2 (replay-version 2): 2026-11-17" in message
    assert "origin/main" in message
    assert BACKFILL in message
    assert day_world.written == []


def test_many_days_on_one_rule_are_named_by_span_and_count(day_world, con):
    other = {**day_world.rule, "replay-version": "2"}
    session = [date(2026, 11, d) for d in (2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 16, 17, 18, 19)]
    for day in session:
        day_world.tape(day)
        day_world.file(day, rule=other if day == WED else None)

    message = refused(con, session[0], session[-1])

    # Thirteen days are the span and the count, then the first twelve, so the span is not read as
    # all of its sessions.
    assert (
        "rule 1 (replay-version 1): 13 days between 2026-11-02 and 2026-11-19: "
        "2026-11-02, 2026-11-03, 2026-11-04, 2026-11-05, 2026-11-06, 2026-11-09, 2026-11-10, "
        "2026-11-11, 2026-11-12, 2026-11-13, 2026-11-16, 2026-11-17, and 1 more"
    ) in message
    assert "rule 2 (replay-version 2): 2026-11-18" in message


# --- the check: nothing to repair -------------------------------------------------------------


def test_a_complete_set_is_read_as_listed_and_nothing_is_written(day_world, con, capsys):
    day_world.full(MON, TUE, WED)

    files = check(con, MON, WED)

    assert files.days == (MON, TUE, WED)
    assert files.urls == tuple(day_world.url(day) for day in (MON, TUE, WED))
    assert (files.first, files.last, files.count) == (MON, WED, 3)
    assert files.repaired == files.unavailable == ()
    assert files.replay_version == day_world.rule["replay-version"]
    assert day_world.write.call_count == 0
    # One list of each prefix, and the tapes' includes the unavailable markers.
    assert day_world.client.listed == [days.DAYS_PREFIX, days.TAPE_PREFIX]
    out = capsys.readouterr().out
    assert "Day files: the replay day files in `research/interval-ba/replay/`" in out
    assert "(3 days, 2026-11-16 to 2026-11-18; replay version" in out


def test_the_listing_is_read_whole_across_pages(day_world, con):
    day_world.client.page_size = 2
    day_world.full(MON, TUE, WED, THU)

    assert check(con, MON, THU).days == (MON, TUE, WED, THU)


def test_the_range_ends_at_its_last_day_and_the_default_at_the_newest_tape(day_world, con):
    day_world.full(MON, TUE, WED)

    assert check(con, MON, TUE).days == (MON, TUE)  # WED is not needed
    # The default range starts at 2026-01-02; those days have no tape here, and it ends at the
    # newest landed tape (WED), so the days after it are never asked for.
    message = refused(con, None, None)
    assert "days between 2026-01-02 and 2026-11-13: 2026-01-02, 2026-01-05," in message
    assert "2026-11-19" not in message


def test_a_range_with_no_trading_day_or_a_backwards_one_or_past_the_calendar_exits(day_world, con):
    day_world.full(MON)
    saturday = date(2026, 11, 14)

    assert "No trading day from 2026-11-14 to 2026-11-15" in refused(
        con, saturday, saturday + timedelta(days=1)
    )
    assert "Nothing to read: 2026-11-17 is after 2026-11-16" in refused(con, TUE, MON)
    assert "2029" in refused(con, date(2029, 1, 2), date(2029, 1, 3))


def test_no_day_file_exits_with_the_prefix(day_world, con):
    # An empty bucket: no day file, and no tape to build one from.
    message = refused(con, None, None)
    assert message == (
        "No day file under research/interval-ba/replay/ in R2, and no tape under fulltape/ to "
        "build one from."
    )

    # Every needed day one that UW did not post: nothing to read.
    day_world.unavailable(MON, TUE)
    message = refused(con, MON, TUE)
    assert message.startswith("No day file under research/interval-ba/replay/ in R2 for 2026-11-16")
    assert day_world.written == []


def test_no_day_file_at_all_with_tapes_landed_names_the_prefix_and_the_backfill(day_world, con):
    """Before the backfill, or after one into the wrong bucket, every needed day is missing: the
    cause is that no day file exists, not that the nightly write broke."""
    session = [date(2026, 11, d) for d in (2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 16)]
    day_world.tape(*session)

    message = refused(con, session[0], session[-1])

    assert message == (
        "No day file under research/interval-ba/replay/ in R2, and the tapes of 11 days have "
        "landed, so the backfill has not run (or wrote to another bucket). Write them with one "
        "command, run from a checkout at origin/main: ml/.venv/Scripts/python.exe -I "
        "scripts/interval_ba_tape.py export --per-day --from 2026-11-02 --to 2026-11-16"
    )
    assert day_world.written == []


def test_a_day_uw_marked_unavailable_is_not_a_gap(day_world, con, capsys):
    day_world.full(MON, WED)
    day_world.unavailable(TUE)

    files = check(con, MON, WED)

    assert files.days == (MON, WED)
    assert files.unavailable == (TUE,)
    assert day_world.write.call_count == 0
    assert "skipped, UW has not posted a tape for: 2026-11-17" in capsys.readouterr().out
    # The report's day count has its explanation in its header too.
    assert "Skipped, UW posted no tape: 2026-11-17" in files.describe()


# --- the check: a day file that holds no alerts ------------------------------------------------


def test_a_kept_day_file_with_no_alerts_is_replayed_again_and_read_once_the_replay_finds_alerts(
    day_world, con, capsys
):
    """A zero-row file is a fault (no session fires fewer than 19), so it is no good day: it is
    the third reason for a repair beside missing and stale."""
    day_world.tape(MON, TUE)
    day_world.file(MON)
    day_world.file(TUE, [])  # newer than its tape, so neither missing nor stale
    day_world.alerts[TUE] = [day_alert(TUE, "14:45:00"), day_alert(TUE, "14:50:00")]

    files = check(con, MON, TUE)

    assert day_world.written == [TUE]
    assert files.repaired == (TUE,)
    assert len(days.read_day_alerts(con, files, "SPXW", from_date="2026-11-17")) == 2
    assert "2026-11-17  repaired (its file held no alerts)" in capsys.readouterr().out


def test_a_second_run_over_a_day_file_with_no_alerts_still_exits_with_the_zero_row_message(
    day_world, con
):
    """The first run's refusal is not a way round the second: the file it wrote is not a good day
    on the next run either, while the replay still finds nothing."""
    day_world.full(MON)
    day_world.tape(TUE)  # missing; the replay finds nothing
    day_world.alerts[TUE] = []

    first = refused(con, MON, TUE)
    second = refused(con, MON, TUE)  # TUE now has a zero-row file, newer than its tape

    expected = "The repair wrote a day file with no alerts for 2026-11-17."
    assert first.startswith(expected)
    assert second.startswith(expected)
    assert day_world.written == [TUE, TUE]


def test_dry_run_lists_a_day_file_with_no_alerts_as_a_repair(day_world, con):
    day_world.full(MON)
    day_world.tape(TUE)
    day_world.file(TUE, [])

    message = refused(con, MON, TUE, dry_run=True)

    assert "1 day file(s) would be repaired:" in message
    assert "2026-11-17  no alerts: its file holds no alerts" in message
    assert day_world.write.call_count == 0


def test_a_day_file_with_no_alerts_counts_toward_the_limit_of_ten(day_world, con):
    session = [date(2026, 11, d) for d in (2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 16)]
    for day in session[:5]:
        day_world.tape(day)
        day_world.file(day, [])  # five zero-row files, read from their footers
    day_world.tape(*session[5:])  # six missing

    assert refused(con, session[0], session[-1]).startswith(
        "11 day files need a repair, more than 10"
    )


def test_a_day_file_with_no_alerts_stays_in_the_rule_check(day_world, con):
    other = {**day_world.rule, "replay-version": "2"}
    day_world.tape(MON, TUE)
    day_world.file(MON)
    day_world.file(TUE, [], rule=other)  # a zero-row file on another rule

    message = refused(con, MON, TUE)

    assert message.startswith("The day files are not one study: they hold 2 different rules.")
    assert "rule 2 (replay-version 2): 2026-11-17" in message
    assert day_world.written == []


# --- the check: the repair --------------------------------------------------------------------


def test_a_missing_day_with_a_tape_is_rebuilt_written_and_read(day_world, con, capsys):
    day_world.full(MON)
    day_world.tape(TUE)  # its tape landed; its file never was written
    day_world.alerts[TUE] = [day_alert(TUE, "14:45:00"), day_alert(TUE, "14:50:00", cp="P")]

    files = check(con, MON, TUE)

    # The tool's writer ran once, for the missing day, with market hours allowed (it writes only
    # research files, never Neon), and each of its files is listed again.
    assert day_world.write.call_count == 1
    assert day_world.written == [TUE]
    assert day_world.write.call_args.kwargs == {"allow_market_hours": True}
    assert day_world.client.listed == [days.DAYS_PREFIX, days.TAPE_PREFIX, days.DAYS_PREFIX]
    # The run goes on over the files, the repaired one included.
    assert files.days == (MON, TUE)
    assert files.repaired == (TUE,)
    assert len(days.read_day_alerts(con, files, "SPXW")) == 3  # MON's one, and TUE's two
    out = capsys.readouterr().out
    assert "2026-11-17  repaired (missing): the nightly should have written it" in out
    assert "check the interval-ba-tape step" in out
    assert "This run repaired 2026-11-17: the nightly should have written them" in files.describe()


def test_a_day_file_older_than_its_tape_is_repaired(day_world, con, capsys):
    day_world.full(MON, TUE)
    day_world.tape(TUE, at=day_world.landed(TUE) + timedelta(days=1))  # the tape was re-landed
    day_world.alerts[TUE] = [day_alert(TUE, "14:45:00"), day_alert(TUE, "14:50:00")]

    files = check(con, MON, TUE)

    assert day_world.written == [TUE]
    assert files.repaired == (TUE,)
    assert len(days.read_day_alerts(con, files, "SPXW", from_date="2026-11-17")) == 2
    assert "2026-11-17  repaired (stale: its tape landed after it)" in capsys.readouterr().out


def test_a_missing_day_without_a_tape_refuses_and_names_it(day_world, con):
    day_world.full(MON)
    day_world.file(WED)  # a file with no tape is fine; TUE has neither

    message = refused(con, MON, WED)

    assert message == (
        "No tape in R2 for 2026-11-17, and no unavailable marker, so the day file cannot be "
        "rebuilt: wait for the nightly run to land the tape, or use --source table."
    )
    assert day_world.written == []


def test_the_repair_refuses_in_the_nightly_window_and_names_the_retry_time(day_world, con):
    day_world.full(MON)
    day_world.tape(TUE)
    day_world.now = datetime(2026, 11, 28, 9, 30, tzinfo=UTC)

    message = refused(con, MON, TUE)

    assert message == (
        "No repair now: 09:30 UTC is inside 07:15-12:30 UTC, the nightly run's window, where the "
        "step may write a day file. Retry after 12:30 UTC (06:30 CT)."
    )
    assert day_world.written == []


@pytest.mark.parametrize(
    ("now", "refuses"),
    [
        (datetime(2026, 11, 28, 7, 14, tzinfo=UTC), False),
        (datetime(2026, 11, 28, 7, 15, tzinfo=UTC), True),
        (datetime(2026, 11, 28, 12, 29, tzinfo=UTC), True),
        (datetime(2026, 11, 28, 12, 30, tzinfo=UTC), False),
        # A weekday in market hours: the repair writes only research files, so it goes ahead.
        (datetime(2026, 11, 30, 16, 0, tzinfo=UTC), False),
    ],
)
def test_the_nightly_window_is_the_only_one_that_stops_a_repair(day_world, con, now, refuses):
    day_world.full(MON)
    day_world.tape(TUE)
    day_world.now = now

    if refuses:
        assert "Retry after 12:30 UTC" in refused(con, MON, TUE)
        assert day_world.written == []
    else:
        assert check(con, MON, TUE).repaired == (TUE,)


def test_the_retry_time_in_summer_is_a_different_ct_clock(day_world, con):
    day_world.full(MON)
    day_world.tape(TUE)
    day_world.now = datetime(2026, 7, 14, 9, 0, tzinfo=UTC)

    assert "Retry after 12:30 UTC (07:30 CT)." in refused(con, MON, TUE)


def test_more_than_ten_missing_days_refuses_with_the_backfill_command(day_world, con):
    session = [date(2026, 11, d) for d in (2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 16)]
    assert len(session) == 11
    day_world.tape(*session)
    day_world.file(date(2026, 10, 30))  # a day file elsewhere: the prefix is not empty

    message = refused(con, session[0], session[-1])

    assert message == (
        "11 day files need a repair, more than 10: that points to a broken nightly write, so "
        "none is repaired here. Fill them with one command, run from a checkout at origin/main: "
        "ml/.venv/Scripts/python.exe -I scripts/interval_ba_tape.py export --per-day "
        "--from 2026-11-02 --to 2026-11-16"
    )
    assert day_world.written == []

    # Ten is not more than ten: the same set minus one is repaired.
    day_world.file(session[0])
    files = check(con, session[0], session[-1])
    assert files.repaired == tuple(session[1:])
    assert day_world.written == session[1:]


def test_stale_and_missing_days_count_together_toward_the_limit(day_world, con):
    session = [date(2026, 11, d) for d in (2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 16)]
    for day in session[:6]:
        day_world.full(day)
        day_world.tape(day, at=day_world.landed(day) + timedelta(days=30))  # re-landed: stale
    day_world.tape(*session[6:])  # five missing

    assert refused(con, session[0], session[-1]).startswith(
        "11 day files need a repair, more than 10"
    )


def test_a_local_rule_unlike_the_files_refuses_the_repair(day_world, con):
    old = {**day_world.rule, "replay-version": "0"}
    day_world.tape(MON, TUE)
    day_world.file(MON, rule=old)  # every file on one rule, which is not the local one

    message = refused(con, MON, TUE)

    assert message.startswith(
        "The replay rule here is not the day files' (replay-version: 0 in the files, "
        f"{day_world.rule['replay-version']} here), so a repair would leave two studies in one "
        "prefix."
    )
    assert BACKFILL in message
    assert day_world.written == []


def test_a_rule_unlike_the_local_one_is_no_reason_to_refuse_when_nothing_needs_a_repair(
    day_world, con
):
    old = {**day_world.rule, "replay-version": "0"}
    day_world.tape(MON)
    day_world.file(MON, rule=old)

    assert check(con, MON, MON).replay_version == "0"


def test_refusals_come_together_in_the_order_the_owner_would_fix_them(day_world, con):
    old = {**day_world.rule, "replay-version": "0"}
    day_world.tape(MON, TUE)
    day_world.file(MON, rule=old)
    day_world.now = datetime(2026, 11, 28, 9, 0, tzinfo=UTC)  # in the nightly window too
    # WED has neither a file nor a tape.

    message = refused(con, MON, WED)

    kinds = re.findall(r"No tape in R2|The replay rule here|No repair now", message)
    assert kinds == ["No tape in R2", "The replay rule here", "No repair now"]


def test_dry_run_never_writes_and_lists_the_days_to_repair(day_world, con):
    day_world.full(MON, TUE, WED)
    day_world.tape(WED, at=day_world.landed(WED) + timedelta(days=1))  # stale
    day_world.tape(THU)  # missing
    before = dict(day_world.client.objects)

    message = refused(con, MON, THU, dry_run=True)

    assert message.splitlines()[0] == "--dry-run: nothing was written."
    assert "2 day file(s) would be repaired:" in message
    assert (
        "2026-11-18  stale: its file (2026-11-19 08:45 UTC) is older than its tape "
        "(2026-11-20 07:45 UTC)"
    ) in message
    assert "2026-11-19  missing: its tape landed (2026-11-20 07:45 UTC)" in message
    assert day_world.write.call_count == 0
    assert day_world.client.objects == before
    assert not Path(day_world.url(THU)).exists()


def test_dry_run_with_nothing_to_repair_says_the_files_are_present_and_current(
    day_world, con, capsys
):
    day_world.full(MON, TUE)

    files = check(con, MON, TUE, dry_run=True)

    assert files.days == (MON, TUE)
    out = capsys.readouterr().out
    assert (
        "--dry-run: the 2 day files, 2026-11-16 to 2026-11-17, are present and current; "
        "nothing to repair."
    ) in out
    assert day_world.write.call_count == 0
    assert day_world.guard.call_count == 0  # nothing to repair, so nothing to ask the guard


def test_dry_run_says_one_day_file_in_the_singular(day_world, con, capsys):
    day_world.full(MON)

    check(con, MON, MON, dry_run=True)

    assert "--dry-run: the 1 day file, 2026-11-16 to 2026-11-16, is present and current" in (
        capsys.readouterr().out
    )


def test_dry_run_with_a_problem_and_nothing_to_repair_lists_the_problem(day_world, con):
    day_world.full(MON, TUE)

    message = refused(con, MON, WED, dry_run=True)  # WED: no tape at all

    assert message.startswith("--dry-run: nothing was written.\nNo tape in R2 for 2026-11-18")
    assert "would be repaired" not in message


def test_a_repair_the_deployed_code_guard_would_refuse_is_a_problem_a_dry_run_lists(day_world, con):
    """A dry run from a checkout that is not origin/main's must not say a repair would go
    ahead: the real run would stop at the writer's guard."""
    day_world.full(MON)
    day_world.tape(TUE)
    day_world.guard.side_effect = runs.RefusedError(
        "scripts/x.py is not origin/main's. Run from a checkout at origin/main."
    )

    dry = refused(con, MON, TUE, dry_run=True)
    real = refused(con, MON, TUE)

    assert "2026-11-17  missing" in dry
    assert (
        "The repair would be refused: scripts/x.py is not origin/main's. "
        "Run from a checkout at origin/main."
    ) in dry
    assert real == (
        "The repair would be refused: scripts/x.py is not origin/main's. "
        "Run from a checkout at origin/main."
    )
    assert day_world.written == []


def test_the_deployed_code_guard_is_asked_before_a_repair_goes_ahead(day_world, con):
    day_world.full(MON)
    day_world.tape(TUE)

    check(con, MON, TUE)

    assert day_world.guard.call_count == 1
    assert day_world.written == [TUE]


def test_a_repaired_day_with_no_alerts_refuses_and_names_the_day(day_world, con):
    day_world.full(MON)
    day_world.tape(TUE, WED)
    day_world.alerts[TUE] = []  # the replay found nothing

    message = refused(con, MON, WED)

    assert message.startswith("The repair wrote a day file with no alerts for 2026-11-17.")
    assert "fewer than 19" in message
    assert f"{BACKFILL} --from 2026-11-17 --to 2026-11-17" in message
    assert "origin/main" in message


@pytest.mark.parametrize(
    ("error", "starts"),
    [
        (runs.RefusedError("the replay module is not origin/main's"), "The repair was refused: "),
        (runs.UsageError("no .env.local in this checkout"), "The repair cannot run: "),
        (runs.CheckFailedError("day file 2026-11-17 does not verify"), "The repair stopped: "),
    ],
)
def test_the_writers_own_refusals_end_the_run_as_exits_with_its_message(
    day_world, con, error, starts
):
    day_world.full(MON)
    day_world.tape(TUE)
    day_world.write_error = error

    message = refused(con, MON, TUE)

    assert message == f"{starts}{error}"


def test_an_r2_failure_in_the_repair_names_its_class_and_never_its_text(day_world, con):
    day_world.full(MON)
    day_world.tape(TUE)
    day_world.write_error = ClientError(
        {"Error": {"Code": "AccessDenied", "Message": "https://account-0123.r2.example.invalid"}},
        "PutObject",
    )

    message = refused(con, MON, TUE)

    assert message.startswith("The repair failed: ClientError")
    assert "account-0123" not in message
    assert "AccessDenied" not in message


def test_a_replay_that_cannot_read_its_tape_stops_the_run_with_its_message(day_world, con):
    """replay_day's ValueError names the tape key only (no 0DTE rows, a damaged tape)."""
    day_world.full(MON)
    day_world.tape(TUE)
    day_world.write_error = ValueError("fulltape/2026-11-17-fulltape.parquet: no 0DTE rows")

    message = refused(con, MON, TUE)

    assert message == "The repair stopped: fulltape/2026-11-17-fulltape.parquet: no 0DTE rows"


def test_a_duckdb_error_in_the_repair_names_its_class_and_never_its_text(day_world, con):
    """Under path-style httpfs the HTTP error text carries the endpoint host: the R2 account."""
    day_world.full(MON)
    day_world.tape(TUE)
    day_world.write_error = duckdb.HTTPException(
        "HTTP GET error reading https://account-0123.r2.example.invalid/bucket/x (HTTP 503)"
    )

    message = refused(con, MON, TUE)

    assert message.startswith("The repair failed: HTTPException")
    assert "account-0123" not in message


def test_a_duckdb_error_reading_the_alerts_names_its_class_and_never_its_text(day_world, con):
    day_world.file(MON)
    files = days.DayFiles(
        days=(MON,),
        urls=(day_world.url(MON),),
        repaired=(),
        unavailable=(),
        replay_version="1",
    )

    class Failing:
        def execute(self, *_args, **_kwargs):
            raise duckdb.IOException(
                "IO Error: Could not read https://account-0123.r2.example.invalid"
            )

    with pytest.raises(SystemExit) as stopped:
        days.read_day_alerts(Failing(), files, "SPXW")

    message = str(stopped.value.code)
    assert message.startswith("Reading the day files failed: IOException")
    assert "account-0123" not in message


def test_a_repair_that_leaves_a_day_unlisted_refuses_instead_of_reading_a_gap(day_world, con):
    day_world.full(MON)
    day_world.tape(TUE)
    day_world.write.side_effect = lambda write_days, **_: [
        # It reports a file written that R2 never lists.
        tool.DayFile(day, "key", 1, 10, "sha", 0)
        for day in write_days
    ]

    message = refused(con, MON, TUE)

    assert message.startswith(
        "The repair wrote 1 day file(s), but 2026-11-17 still read as missing"
    )


def test_a_listing_that_fails_names_the_class_and_never_its_text(day_world, con):
    day_world.client.fail = ClientError(
        {"Error": {"Code": "AccessDenied", "Message": "account-0123.r2.example.invalid"}},
        "ListObjectsV2",
    )

    message = refused(con, MON, TUE)

    assert message.startswith("Listing research/interval-ba/replay/ in R2 failed (ClientError;")
    assert "account-0123" not in message
    assert "AccessDenied" not in message


@pytest.mark.parametrize("name", ["R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_BUCKET_FULLTAPE"])
def test_a_missing_r2_value_is_named_before_anything_is_listed(day_world, con, monkeypatch, name):
    monkeypatch.delenv(name)

    message = refused(con, MON, TUE)

    assert message == f"Missing env var(s) {name} (set them in .env.local)"
    assert day_world.client.listed == []


def test_the_check_reads_only_the_footers_of_the_files_it_keeps(day_world, con):
    """A stale file is about to be replaced, so its old footer says nothing about the rule."""
    old = {**day_world.rule, "replay-version": "0"}
    day_world.full(MON)
    day_world.file(TUE, rule=old)
    day_world.tape(TUE, at=day_world.landed(TUE) + timedelta(days=1))  # TUE is stale

    files = check(con, MON, TUE)

    assert files.repaired == (TUE,)
    assert files.replay_version == day_world.rule["replay-version"]


def test_the_describe_sentence_names_the_prefix_the_span_and_the_version():
    files = days.DayFiles(
        days=(MON, TUE),
        urls=("a", "b"),
        repaired=(),
        unavailable=(),
        replay_version=None,
    )

    assert files.describe() == (
        "the replay day files in `research/interval-ba/replay/` (2 days, 2026-11-16 to 2026-11-17)"
    )
    one = days.DayFiles(
        days=(MON,),
        urls=("a",),
        repaired=(MON,),
        unavailable=(TUE, WED),
        replay_version="3",
    )
    assert one.describe() == (
        "the replay day files in `research/interval-ba/replay/` (1 day, 2026-11-16 to "
        "2026-11-16; replay version 3). This run repaired 2026-11-16: the nightly should have "
        "written them. Skipped, UW posted no tape: 2026-11-17, 2026-11-18"
    )


def test_an_analysis_that_repaired_a_day_says_its_outcomes_csv_was_priced_before(day_world, con):
    """The CSV was built from the day files, so a rewritten day may differ from what enrich saw."""
    plain = days.DayFiles(days=(MON,), urls=("a",), repaired=(), unavailable=(), replay_version="1")
    rewritten = days.DayFiles(
        days=(MON, TUE), urls=("a", "b"), repaired=(MON, TUE), unavailable=(), replay_version="1"
    )

    assert plain.analysis_note() == ""
    assert rewritten.analysis_note() == (
        "Rewritten after the outcomes CSV was priced: 2026-11-16, 2026-11-17. Re-run "
        "enrich_interval_ba_outcomes.py for those days."
    )
