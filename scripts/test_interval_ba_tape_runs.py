"""scripts/interval_ba_tape_runs.py: the shared machinery's pieces with no database or tape.

The end-to-end tests of the tool, including the driver, the backup and the windows, are in
scripts/test_interval_ba_tape.py. Run from the repo root with ml/.venv:

    ml/.venv/Scripts/python -m pytest scripts/test_interval_ba_tape_runs.py -q
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import interval_ba_tape_runs as runs
import psycopg2
import pytest
from botocore.exceptions import ClientError

_DIRECT = "postgresql://u:p@ep-cool-123.us-east-2.aws.neon.tech/neondb?sslmode=require"


@pytest.mark.parametrize(
    ("url", "direct"),
    [
        (
            "postgresql://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
            _DIRECT,
        ),
        (
            "postgres://u:p@ep-x-pooler.c-2.us-east-2.aws.neon.tech:5432/db",
            "postgres://u:p@ep-x.c-2.us-east-2.aws.neon.tech:5432/db",
        ),
        ("POSTGRESQL://u:p@EP-X-POOLER.neon.tech/db", "POSTGRESQL://u:p@EP-X.neon.tech/db"),
        # Already direct.
        (_DIRECT, _DIRECT),
        # A user name ending in -pooler is not a host label.
        (
            "postgresql://svc-pooler:p@ep-a.neon.tech/db",
            "postgresql://svc-pooler:p@ep-a.neon.tech/db",
        ),
        # -pooler past the host, and in the password, is kept.
        (
            "postgresql://u:p%40ss-pooler@ep-a-pooler.neon.tech/db-pooler?application_name=x-pooler",
            "postgresql://u:p%40ss-pooler@ep-a.neon.tech/db-pooler?application_name=x-pooler",
        ),
        # Only the first host label.
        (
            "postgresql://u:p@ep-a.region-pooler.neon.tech/db",
            "postgresql://u:p@ep-a.region-pooler.neon.tech/db",
        ),
    ],
)
def test_direct_dsn_drops_the_pooler_suffix_of_the_first_host_label_only(url: str, direct: str):
    assert runs.direct_dsn(url) == direct


def test_output_hides_the_pooled_and_the_direct_host(capsys: pytest.CaptureFixture[str]):
    out = runs.Output()
    out.hide(
        {
            "DATABASE_URL": "postgresql://user1:pw-secret@ep-cool-123-pooler.example.neon.tech/db",
            "R2_ENDPOINT_URL": "https://0123abcd.r2.cloudflarestorage.com",
        }
    )

    out.say(
        "pooled ep-cool-123-pooler.example.neon.tech, direct ep-cool-123.example.neon.tech,"
        " endpoint id ep-cool-123, account 0123abcd, password pw-secret, user user1"
    )

    text = capsys.readouterr().out
    for secret in ("ep-cool-123", "0123abcd", "pw-secret", "user1", "example.neon.tech"):
        assert secret not in text
    assert text.count("<redacted>") == 6


def test_code_blobs_cover_every_file_of_the_tool():
    blobs = runs.code_blobs()

    assert set(blobs["tool_blobs"]) == set(runs.TOOL_FILES)
    for name, path in runs.TOOL_FILES.items():
        assert path.is_file() and path.as_posix().endswith(name)
    # A new file of the tool beside these is hashed only once it is listed. The calendar it
    # loads by path from nightly decides which days a range holds, so it is listed too.
    beside = {path.name for path in Path(runs.__file__).parent.glob("interval_ba_tape*.py")}
    assert {Path(name).name for name in runs.TOOL_FILES} == beside | {"calendar_nyse.py"}
    assert "nightly/src/calendar_nyse.py" in runs.TOOL_FILES
    assert blobs["module_blob"] == runs.blob_hash(runs.MODULE_PATH)


def test_trading_days_follow_the_nightly_calendar_past_2026():
    # 2027: New Year's Day (Fri 01-01) and Martin Luther King Jr. Day (Mon 01-18) are closed.
    assert runs.trading_days(date(2026, 12, 30), date(2027, 1, 5)) == [
        date(2026, 12, 30),
        date(2026, 12, 31),
        date(2027, 1, 4),
        date(2027, 1, 5),
    ]
    assert runs.trading_days(date(2027, 1, 15), date(2027, 1, 19)) == [
        date(2027, 1, 15),
        date(2027, 1, 19),
    ]
    # 2025 was refused by the old 2026-only table; Thanksgiving (11-27) is closed.
    assert runs.trading_days(date(2025, 11, 26), date(2025, 11, 28)) == [
        date(2025, 11, 26),
        date(2025, 11, 28),
    ]
    # 2026 as the old table had it: Thanksgiving, the Friday after, a Saturday.
    assert runs.trading_days(date(2026, 11, 25), date(2026, 11, 30)) == [
        date(2026, 11, 25),
        date(2026, 11, 27),
        date(2026, 11, 30),
    ]
    # It is nightly's module, loaded by its path, and not a copy.
    assert Path(runs.calendar_nyse.__file__).resolve() == runs.CALENDAR_PATH.resolve()
    assert runs.CALENDAR_PATH == runs.REPO_ROOT / "nightly" / "src" / "calendar_nyse.py"


def test_trading_days_name_a_range_the_calendar_does_not_cover_or_that_runs_backwards():
    # Past the table (2025-2028) the calendar raises rather than guess a holiday.
    with pytest.raises(runs.UsageError, match="2029"):
        runs.trading_days(date(2029, 1, 2), date(2029, 1, 3))
    with pytest.raises(runs.UsageError, match="2024"):
        runs.trading_days(date(2024, 12, 30), date(2025, 1, 3))
    with pytest.raises(runs.UsageError, match="--from 2026-03-11 is after --to 2026-03-10"):
        runs.trading_days(date(2026, 3, 11), date(2026, 3, 10))


@pytest.mark.parametrize(
    ("now", "ends"),
    [
        # The window is 07:15 (included) to 12:30 (not included) UTC, every day.
        (datetime(2026, 11, 28, 7, 14, 59, tzinfo=UTC), None),
        (datetime(2026, 11, 28, 7, 15, tzinfo=UTC), datetime(2026, 11, 28, 12, 30, tzinfo=UTC)),
        (datetime(2026, 11, 28, 9, 0, tzinfo=UTC), datetime(2026, 11, 28, 12, 30, tzinfo=UTC)),
        (
            datetime(2026, 11, 28, 12, 29, 59, tzinfo=UTC),
            datetime(2026, 11, 28, 12, 30, tzinfo=UTC),
        ),
        (datetime(2026, 11, 28, 12, 30, tzinfo=UTC), None),
        # A clock that is not UTC is read as the instant it is: 03:00 EST is 08:00 UTC.
        (
            datetime(2026, 11, 28, 3, 0, tzinfo=ZoneInfo("America/New_York")),
            datetime(2026, 11, 28, 12, 30, tzinfo=UTC),
        ),
    ],
)
def test_nightly_window_end_is_when_the_nightly_window_closes_or_none_outside_it(
    now: datetime, ends: datetime | None
):
    assert runs.nightly_window_end(now) == ends


def test_the_window_refusal_for_the_nightly_run_is_the_same_window():
    inside = datetime(2026, 11, 28, 9, 0, tzinfo=UTC)
    assert runs.nightly_window_end(inside) is not None
    assert "07:15-12:30 UTC" in (runs.window_refusal(inside, allow_market_hours=True) or "")
    outside = datetime(2026, 11, 28, 12, 30, tzinfo=UTC)  # a Saturday: no market-hours window
    assert runs.nightly_window_end(outside) is None
    assert runs.window_refusal(outside, allow_market_hours=False) is None


class _Pages:
    """A paginator over fixed pages, as boto3's `list_objects_v2` one gives them."""

    def __init__(self, pages: list[dict[str, Any]], asked: list[dict[str, Any]]) -> None:
        self._pages = pages
        self._asked = asked

    def paginate(self, **kwargs: Any) -> list[dict[str, Any]]:
        self._asked.append(kwargs)
        return self._pages


class _ListingClient:
    def __init__(self, pages: list[dict[str, Any]]) -> None:
        self.pages = pages
        self.asked: list[dict[str, Any]] = []

    def get_paginator(self, name: str) -> _Pages:
        assert name == "list_objects_v2"
        return _Pages(self.pages, self.asked)


def test_list_objects_gives_each_key_under_the_prefix_with_its_last_modified_in_utc():
    first = datetime(2026, 11, 26, 21, 0, tzinfo=UTC)
    second = datetime(2026, 11, 27, 7, 30, tzinfo=ZoneInfo("America/Chicago"))
    client = _ListingClient(
        [
            {"Contents": [{"Key": "p/a.parquet", "LastModified": first}]},
            {},  # a page with no Contents, as the last page of an empty prefix is
            {"Contents": [{"Key": "p/b.parquet", "LastModified": second}]},
        ]
    )

    found = runs.list_objects(runs.R2Bucket(client, "bucket"), "p/")

    assert found == {"p/a.parquet": first, "p/b.parquet": second.astimezone(UTC)}
    assert all(at.utcoffset() == timedelta(0) for at in found.values())
    assert client.asked == [{"Bucket": "bucket", "Prefix": "p/"}]


def test_list_objects_reads_a_naive_last_modified_as_utc():
    client = _ListingClient([{"Contents": [{"Key": "k", "LastModified": datetime(2026, 1, 2)}]}])

    assert runs.list_objects(runs.R2Bucket(client, "b"), "")["k"] == datetime(
        2026, 1, 2, tzinfo=UTC
    )


def test_list_objects_lets_a_listing_error_through():
    class Refusing:
        def get_paginator(self, _name: str) -> Any:
            raise ClientError({"Error": {"Code": "AccessDenied"}}, "ListObjectsV2")

    with pytest.raises(ClientError):
        runs.list_objects(runs.R2Bucket(Refusing(), "b"), "p/")


def test_blob_hash_is_gits(tmp_path: Path):
    path = tmp_path / "hello.txt"
    path.write_bytes(b"hello\n")

    # `git hash-object` of "hello\n".
    assert runs.blob_hash(path) == "ce013625030ba8dba906f756967f9e9ca394464a"


class _Conn:
    def __init__(self, *, rollback_fails: bool = False) -> None:
        self.rollbacks = 0
        self._fails = rollback_fails

    def rollback(self) -> None:
        self.rollbacks += 1
        if self._fails:
            raise psycopg2.InterfaceError("connection already closed")


def test_rolled_back_ends_the_transaction_and_never_hides_the_error_that_got_there():
    conn = _Conn()
    with runs.rolled_back(conn):
        pass
    assert conn.rollbacks == 1

    dead = _Conn(rollback_fails=True)
    with pytest.raises(ValueError, match="the first error"), runs.rolled_back(dead):
        raise ValueError("the first error")
    assert dead.rollbacks == 1
