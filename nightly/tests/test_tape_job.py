"""Tests for the tape job: planning, landing, re-landing and the run's limits.

download_tape, convert_zip, probe_source, disk_usage and (where a test needs it) rmtree
are patched at tape_job's module boundary, each wrapped in create_autospec of the real
function so a call that no longer fits the real signature fails. moto answers every R2
call in-process, so nothing touches the network. Most run_tape tests use a January 2026
session so the whole tape is a handful of seeded objects.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import logging
import math
import os
import shutil
from collections.abc import Callable, Iterator
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import create_autospec, patch

import boto3
import httpx
import pytest
import sentry_sdk
from botocore.exceptions import ClientError
from moto import mock_aws

import tape_convert
import tape_job
import uw_client
from calendar_nyse import EASTERN, trading_days
from config import Settings, load_settings
from constants import (
    CATCHUP_MAX_DAYS,
    DAY_BUDGET_SECONDS,
    MAX_MARKERS_PER_RUN,
    MIN_FREE_DISK_BYTES,
    MIN_TAPE_ROWS,
    OUTSIDE_WINDOW_MIN_LOOKBACK_DAYS,
    PROBE_BUDGET_SECONDS,
    REWRITE_RECHECK_DAYS,
    RUN_DEADLINE_SECONDS,
    SCHEMA_VERSION,
    TAPE_START,
)
from r2_store import R2Store, R2VerifyError, tape_key
from tape_convert import ConvertResult, TapeValidationError
from tape_job import RELAND_IDENTICAL, DayOutcome, land_day, plan_days, rewritten_days, run_tape
from tests.test_uw_client import LIVE_HISTORIC_BODY
from uw_client import SourceInfo, TapeDownloadError

BUCKET = "test-bucket"
API_KEY = "test-key"  # conftest's UW_API_KEY
LAST = date(2026, 10, 28)
OLD = date(2026, 5, 29)  # far more than UNAVAILABLE_AGE_TRADING_DAYS before LAST
LAST_MODIFIED = "Thu, 29 Oct 2026 00:05:00 GMT"
METADATA_KEYS = {
    "rows",
    "sha256",
    "schema-version",
    "source-etag",
    "source-last-modified",
    "source-bytes",
    "ingested-at",
}
# 07:15 UTC on Fri 2026-01-09 resolves to the Thu 01-08 session: the tape is Jan 2, 5-8.
JAN_NOW = datetime(2026, 1, 9, 7, 15, tzinfo=UTC)
J2, J5, J6, J7, J8 = trading_days(TAPE_START, date(2026, 1, 8))
SKIPPED_DISK = "free disk below the minimum"
SKIPPED_DEADLINE = "less than a day's budget left before the run deadline"
NO_DEADLINE = math.inf
ROWS = 8_000_000  # a full day: real days run 7.68M-14.93M rows


def _et(day: date, hour: int, minute: int = 0) -> datetime:
    """An Eastern wall-clock time, as the UTC instant ConvertResult carries."""
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=EASTERN).astimezone(UTC)


def zip_body(day: date) -> bytes:
    return b"PK\x03\x04" + day.isoformat().encode()


def parquet_body(day: date) -> bytes:
    return b"PAR1" + day.isoformat().encode()


def new_etag(day: date) -> str:
    return f'"new-{day.isoformat()}"'


def old_etag(day: date) -> str:
    return f'"old-{day.isoformat()}"'


def gcs_404(day: date) -> TapeDownloadError:
    return TapeDownloadError("not_posted", day, "gcs-404", origin="gcs")


class FakeTape:
    """Stand-ins for download_tape, convert_zip, probe_source and disk_usage.

    Each method's parameters mirror the real function's names and order
    (test_fakes_match_the_real_signatures), and the fixture wraps each in
    create_autospec of the real function.
    """

    def __init__(self, work: Path) -> None:
        self.work = work
        self.downloads: list[date] = []
        self.api_keys: set[str] = set()
        self.converts: list[tuple[Path, Path, date, datetime]] = []
        self.probes: list[date] = []
        self.download_error: dict[date, BaseException] = {}
        self.convert_error: dict[date, BaseException] = {}
        self.probe_result: dict[date, str | BaseException | None] = {}
        self.rows: dict[date, int] = {}
        # (min, max) executed_at; a day not listed trades 09:30-16:15 ET on its date.
        self.executed: dict[date, tuple[datetime, datetime]] = {}
        self.free: list[int | OSError] = []
        self.on_download: Callable[[date], None] | None = None
        self.on_probe: Callable[[date], None] | None = None
        # Every call in order, with _record_store_calls adding supersede and put_tape.
        self.events: list[tuple[str, date]] = []

    def download(self, day: date, dest: Path, api_key: str) -> SourceInfo:
        self.downloads.append(day)
        self.events.append(("download", day))
        self.api_keys.add(api_key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        # A stray partial file, so a failed day leaves something for cleanup to remove.
        dest.with_name(dest.name + ".part").write_bytes(b"partial")
        if self.on_download is not None:
            self.on_download(day)
        if day in self.download_error:
            raise self.download_error[day]
        dest.write_bytes(zip_body(day))
        return SourceInfo(etag=new_etag(day), last_modified=LAST_MODIFIED, bytes=len(zip_body(day)))

    def convert(
        self, zip_path: Path, out_path: Path, session: date, ingested_at: datetime
    ) -> ConvertResult:
        self.converts.append((zip_path, out_path, session, ingested_at))
        self.events.append(("convert", session))
        assert zip_path.read_bytes() == zip_body(session)
        out_path.write_bytes(parquet_body(session))
        if session in self.convert_error:
            raise self.convert_error[session]
        low, high = self.executed.get(session, (_et(session, 9, 30), _et(session, 16, 15)))
        return ConvertResult(
            rows=self.rows.get(session, ROWS),
            columns=["id", "date", "ingested_at"],
            sha256=hashlib.sha256(parquet_body(session)).hexdigest(),
            bytes=len(parquet_body(session)),
            min_executed_at=low,
            max_executed_at=high,
        )

    def probe(self, day: date, api_key: str) -> SourceInfo:
        self.probes.append(day)
        self.events.append(("probe", day))
        if self.on_probe is not None:
            self.on_probe(day)
        if day not in self.probe_result:
            pytest.fail(f"unexpected probe of {day}")  # BaseException: escapes the job's catch
        result = self.probe_result[day]
        if isinstance(result, BaseException):
            raise result
        return SourceInfo(etag=result, last_modified=LAST_MODIFIED, bytes=1)

    def disk_usage(self, path: Path) -> SimpleNamespace:
        assert Path(path).is_dir(), "WORK_DIR must exist before the disk check"
        free = self.free.pop(0) if self.free else MIN_FREE_DISK_BYTES
        if isinstance(free, OSError):
            raise free
        return SimpleNamespace(free=free)


@pytest.fixture
def tape(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> FakeTape:
    fake = FakeTape(tmp_path / "work")
    stand_ins = {
        "download_tape": (uw_client.download_tape, fake.download),
        "convert_zip": (tape_convert.convert_zip, fake.convert),
        "probe_source": (uw_client.probe_source, fake.probe),
        "disk_usage": (shutil.disk_usage, fake.disk_usage),
    }
    monkeypatch.setattr(tape_job, "WORK_DIR", fake.work)
    for name, (real, stand_in) in stand_ins.items():
        monkeypatch.setattr(tape_job, name, create_autospec(real, side_effect=stand_in))
    return fake


def _rmtree(monkeypatch: pytest.MonkeyPatch, side_effect: Callable[..., None]) -> None:
    monkeypatch.setattr(tape_job, "rmtree", create_autospec(shutil.rmtree, side_effect=side_effect))


def _record_store_calls(monkeypatch: pytest.MonkeyPatch, tape: FakeTape) -> None:
    """Log every R2Store.supersede and put_tape call in tape.events, then run it."""
    real_supersede, real_put = R2Store.supersede, R2Store.put_tape

    def supersede(self: R2Store, day: date, source_etag: str) -> str:
        tape.events.append(("supersede", day))
        return real_supersede(self, day, source_etag)

    def put_tape(self: R2Store, path: Path, day: date, metadata: dict[str, str]) -> None:
        tape.events.append(("put_tape", day))
        real_put(self, path, day, metadata)

    monkeypatch.setattr(R2Store, "supersede", supersede)
    monkeypatch.setattr(R2Store, "put_tape", put_tape)


@pytest.fixture
def sentry_messages(monkeypatch: pytest.MonkeyPatch):
    mock = create_autospec(sentry_sdk.capture_message)
    monkeypatch.setattr(sentry_sdk, "capture_message", mock)
    return mock


@pytest.fixture
def settings() -> Settings:
    # moto only intercepts AWS hostnames; a custom R2 endpoint would go out to the network.
    return load_settings().model_copy(
        update={"r2_endpoint_url": "https://s3.amazonaws.com", "r2_bucket_fulltape": BUCKET}
    )


@pytest.fixture
def s3() -> Iterator[object]:
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket=BUCKET)
        yield client


@pytest.fixture
def store(s3: object, settings: Settings) -> R2Store:
    return R2Store(settings)


def _seed(s3, day: date, metadata: dict[str, str] | None = None) -> None:
    s3.put_object(
        Bucket=BUCKET,
        Key=tape_key(day),
        Body=b"old-" + day.isoformat().encode(),
        Metadata=metadata or {},
    )


def _body(s3, key: str) -> bytes:
    return s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()


def _keys(s3) -> set[str]:
    return {o["Key"] for o in s3.list_objects_v2(Bucket=BUCKET).get("Contents", [])}


def _statuses(outcomes: list[DayOutcome]) -> list[tuple[date, str, str]]:
    return [(o.day, o.status, o.detail) for o in outcomes]


def _bound(spy, index: int = -1) -> inspect.BoundArguments:
    """The arguments of a land_day spy's call (the last by default), by name."""
    call = spy.call_args_list[index]
    return inspect.signature(land_day).bind(*call.args, **call.kwargs)


@pytest.mark.parametrize(
    ("name", "real", "fake"),
    [
        ("download_tape", uw_client.download_tape, FakeTape.download),
        ("convert_zip", tape_convert.convert_zip, FakeTape.convert),
        ("probe_source", uw_client.probe_source, FakeTape.probe),
        ("disk_usage", shutil.disk_usage, FakeTape.disk_usage),
    ],
)
def test_fakes_match_the_real_signatures(name: str, real, fake) -> None:
    """A renamed or reordered parameter in a real function fails here, not in prod."""
    assert getattr(tape_job, name) is real  # the fixture patches the name tape_job uses
    assert list(inspect.signature(fake).parameters)[1:] == list(inspect.signature(real).parameters)


def test_plausibility_warnings_takes_the_keywords_tape_job_passes() -> None:
    # tape_job calls the real plausibility_warnings, by keyword.
    assert list(inspect.signature(tape_convert.plausibility_warnings).parameters) == [
        "rows",
        "baseline_rows",
        "min_executed_at",
        "max_executed_at",
        "session",
    ]


# --- plan_days ---------------------------------------------------------------------------

_ALL = trading_days(TAPE_START, LAST)


@pytest.mark.parametrize(
    ("landed", "unavailable", "last_session", "cap", "expected"),
    [
        pytest.param(
            {d for d in _ALL if d < date(2026, 6, 16) and d != OLD},
            set(),
            LAST,
            CATCHUP_MAX_DAYS,
            trading_days(date(2026, 9, 17), LAST)[::-1],
            id="backlog-0616-to-1028-with-0529-missing-capped-newest-first",
        ),
        pytest.param(
            set(_ALL) - {LAST, date(2026, 10, 27), date(2026, 10, 26)},
            {date(2026, 10, 27)},
            LAST,
            CATCHUP_MAX_DAYS,
            [LAST, date(2026, 10, 26)],
            id="unavailable-excluded",
        ),
        pytest.param(
            set(),
            set(),
            date(2026, 1, 6),
            CATCHUP_MAX_DAYS,
            [date(2026, 1, 6), date(2026, 1, 5), date(2026, 1, 2)],
            id="nothing-before-tape-start",
        ),
        pytest.param(set(_ALL), set(), LAST, CATCHUP_MAX_DAYS, [], id="nothing-missing"),
        pytest.param(
            set(), set(), LAST, 2, [LAST, date(2026, 10, 27)], id="custom-cap-keeps-newest"
        ),
    ],
)
def test_plan_days(
    landed: set[date], unavailable: set[date], last_session: date, cap: int, expected: list[date]
) -> None:
    assert plan_days(landed, unavailable, last_session, cap=cap) == expected


def test_plan_days_backlog_endpoints() -> None:
    """The table's backlog row, pinned to literal dates rather than to trading_days."""
    landed = {d for d in _ALL if d < date(2026, 6, 16) and d != OLD}
    planned = plan_days(landed, set(), LAST)
    assert len(planned) == 30
    assert planned[0] == LAST
    assert planned[-1] == date(2026, 9, 17)
    assert planned == sorted(planned, reverse=True)
    assert OLD not in planned


# --- land_day ----------------------------------------------------------------------------


def test_land_day_success_puts_with_metadata(s3, store: R2Store, tape: FakeTape) -> None:
    outcome = land_day(LAST, store, API_KEY, [], last_session=LAST)

    assert outcome == DayOutcome(LAST, "landed", "", ROWS, (), bytes=len(parquet_body(LAST)))
    head = s3.head_object(Bucket=BUCKET, Key=tape_key(LAST))
    meta = head["Metadata"]
    assert set(meta) == METADATA_KEYS
    assert meta["rows"] == str(ROWS)
    assert meta["sha256"] == hashlib.sha256(parquet_body(LAST)).hexdigest()
    assert meta["schema-version"] == SCHEMA_VERSION
    assert meta["source-etag"] == new_etag(LAST)
    assert meta["source-last-modified"] == LAST_MODIFIED
    assert meta["source-bytes"] == str(len(zip_body(LAST)))
    ingested = datetime.fromisoformat(meta["ingested-at"])
    assert ingested.utcoffset() == timedelta(0)
    assert _body(s3, tape_key(LAST)) == parquet_body(LAST)

    [(zip_path, out_path, session, ingested_at)] = tape.converts
    assert session == LAST
    assert ingested_at == ingested  # the Parquet column and the metadata agree
    assert zip_path.name.endswith(".zip")
    assert out_path.name.endswith(".parquet")
    assert zip_path.parent == out_path.parent == tape.work / "2026-10-28"
    assert tape.api_keys == {API_KEY}
    assert not (tape.work / "2026-10-28").exists()


def test_land_day_reports_plausibility_warnings(s3, store: R2Store, tape: FakeTape) -> None:
    tape.rows[LAST] = 2_000_000
    outcome = land_day(LAST, store, API_KEY, [ROWS] * 12, last_session=LAST)
    assert outcome.status == "landed"
    [warning] = outcome.warnings
    assert warning == "rows 2,000,000 below 0.65 x the baseline median 8,000,000 of 12 day(s)"


# --- row floor and wrong-day tape ------------------------------------------------------


def test_min_tape_rows_is_one_million() -> None:
    # Real days run 7.68M-14.93M rows and half-days about 4-5M.
    assert MIN_TAPE_ROWS == 1_000_000


@pytest.mark.parametrize("rows", [0, 999_999])
def test_a_tape_below_the_row_floor_fails_and_puts_nothing(
    s3, store: R2Store, tape: FakeTape, caplog: pytest.LogCaptureFixture, rows: int
) -> None:
    tape.rows[LAST] = rows
    with caplog.at_level(logging.WARNING, logger="tape_job"):
        outcome = land_day(LAST, store, API_KEY, [ROWS] * 12, last_session=LAST)

    assert outcome == DayOutcome(LAST, "failed", "row floor", None, ())
    assert _keys(s3) == set()
    assert not (tape.work / LAST.isoformat()).exists()
    assert f"{rows} rows, below the 1000000-row floor" in caplog.text


def test_a_tape_on_the_row_floor_lands(s3, store: R2Store, tape: FakeTape) -> None:
    tape.rows[LAST] = MIN_TAPE_ROWS
    outcome = land_day(LAST, store, API_KEY, [], last_session=LAST)
    assert (outcome.status, outcome.rows) == ("landed", MIN_TAPE_ROWS)
    assert _keys(s3) == {tape_key(LAST)}


# The tape's own window for the 10-28 session: [10-27 20:00 ET, 10-28 20:00 ET).
WINDOW_START, WINDOW_END = _et(date(2026, 10, 27), 20), _et(LAST, 20)
ONE_US = timedelta(microseconds=1)


@pytest.mark.parametrize(
    ("low", "high"),
    [
        pytest.param(
            _et(date(2026, 10, 29), 9, 30), _et(date(2026, 10, 29), 16, 15), id="the-next-day"
        ),
        pytest.param(WINDOW_END, WINDOW_END + timedelta(hours=8), id="starts-at-the-window-end"),
        pytest.param(
            _et(date(2026, 10, 27), 9, 30), WINDOW_START - ONE_US, id="ends-before-the-window"
        ),
    ],
)
def test_a_tape_wholly_outside_the_session_window_fails(
    s3, store: R2Store, tape: FakeTape, low: datetime, high: datetime
) -> None:
    tape.executed[LAST] = (low, high)

    outcome = land_day(LAST, store, API_KEY, [], last_session=LAST)

    assert outcome == DayOutcome(LAST, "failed", "wrong-day tape", None, ())
    assert _keys(s3) == set()


@pytest.mark.parametrize(
    ("low", "high", "warned"),
    [
        pytest.param(
            _et(date(2026, 10, 27), 9, 30), WINDOW_START, 1, id="ends-on-the-window-start"
        ),
        pytest.param(WINDOW_END - ONE_US, WINDOW_END + timedelta(hours=8), 1, id="starts-inside"),
        pytest.param(WINDOW_START - ONE_US, WINDOW_END, 2, id="spans-the-window"),
    ],
)
def test_a_tape_partly_in_the_window_lands_with_a_warning(
    s3, store: R2Store, tape: FakeTape, low: datetime, high: datetime, warned: int
) -> None:
    tape.executed[LAST] = (low, high)

    outcome = land_day(LAST, store, API_KEY, [], last_session=LAST)

    assert outcome.status == "landed"
    assert len(outcome.warnings) == warned
    assert all("session window" in w for w in outcome.warnings)
    assert _keys(s3) == {tape_key(LAST)}


def _fail_put(store: R2Store, monkeypatch: pytest.MonkeyPatch) -> None:
    error = R2VerifyError("fulltape/x: uploaded 1 bytes but R2 reports 2")
    monkeypatch.setattr(store, "put_tape", create_autospec(store.put_tape, side_effect=error))


@pytest.mark.parametrize(
    ("arrange", "detail"),
    [
        pytest.param(
            lambda t, s, mp: t.download_error.update(
                {LAST: TapeDownloadError("transient", LAST, "gcs-503 after 4 attempts")}
            ),
            "transient",
            id="download",
        ),
        pytest.param(
            lambda t, s, mp: t.convert_error.update(
                {LAST: TapeValidationError("row count 1 != 2")}
            ),
            "TapeValidationError",
            id="convert",
        ),
        pytest.param(lambda t, s, mp: _fail_put(s, mp), "R2VerifyError", id="put"),
    ],
)
def test_land_day_cleans_work_dir_on_failure(
    s3, store: R2Store, tape: FakeTape, monkeypatch: pytest.MonkeyPatch, arrange, detail: str
) -> None:
    arrange(tape, store, monkeypatch)
    outcome = land_day(LAST, store, API_KEY, [], last_session=LAST)

    assert (outcome.status, outcome.detail, outcome.rows) == ("failed", detail, None)
    assert tape.work.is_dir()
    assert not (tape.work / "2026-10-28").exists()
    assert tape_key(LAST) not in _keys(s3)


def test_validation_error_fails_with_class_name(s3, store: R2Store, tape: FakeTape) -> None:
    tape.convert_error[LAST] = TapeValidationError("missing 1 core column(s): price")
    outcome = land_day(LAST, store, API_KEY, [], last_session=LAST)
    assert outcome == DayOutcome(
        LAST, "failed", "TapeValidationError", None, (), reason="missing 1 core column(s): price"
    )


def test_put_verify_error_fails_day(s3, store: R2Store, tape: FakeTape) -> None:
    error = R2VerifyError("fulltape/x: could not verify")
    with patch.object(store, "put_tape", autospec=True, side_effect=error) as put:
        outcome = land_day(LAST, store, API_KEY, [], last_session=LAST)
    assert put.call_count == 1
    assert outcome == DayOutcome(
        LAST, "failed", "R2VerifyError", None, (), reason="fulltape/x: could not verify"
    )


def test_old_not_posted_marks_unavailable(s3, store: R2Store, tape: FakeTape) -> None:
    """05-29 with last session 10-28: UW redirected and GCS had no object."""
    tape.download_error[OLD] = gcs_404(OLD)

    outcome = land_day(OLD, store, API_KEY, [], last_session=LAST)

    assert outcome == DayOutcome(OLD, "unavailable", "not_posted", None, ())
    assert store.unavailable() == {OLD}
    marker = json.loads(_body(s3, "fulltape/_unavailable/2026-05-29.json"))
    assert marker["date"] == "2026-05-29"
    assert marker["reason"] == "not_posted: gcs-404"
    assert not (tape.work / "2026-05-29").exists()


@pytest.mark.parametrize(
    ("origin", "detail"), [("uw", "not_posted uw"), (None, "not_posted unknown")]
)
def test_old_not_posted_not_from_gcs_fails_without_a_marker(
    s3, store: R2Store, tape: FakeTape, origin: str | None, detail: str
) -> None:
    tape.download_error[OLD] = TapeDownloadError("not_posted", OLD, "uw-404", origin=origin)

    outcome = land_day(OLD, store, API_KEY, [], last_session=LAST)

    assert outcome == DayOutcome(OLD, "failed", detail, None, ())
    assert store.unavailable() == set()


@pytest.mark.parametrize("origin", ["gcs", "uw"])
def test_recent_not_posted_is_not_marked_unavailable(
    s3, store: R2Store, tape: FakeTape, origin: str
) -> None:
    """Last session 10-28, day 10-28: UW is late, whichever side answered 404."""
    tape.download_error[LAST] = TapeDownloadError(
        "not_posted", LAST, f"{origin}-404", origin=origin
    )

    outcome = land_day(LAST, store, API_KEY, [], last_session=LAST)

    assert outcome == DayOutcome(LAST, "not_posted", "not_posted", None, ())
    assert store.unavailable() == set()


@pytest.mark.parametrize(
    ("day", "status"),
    [
        pytest.param(date(2026, 10, 21), "unavailable", id="5-sessions-before"),
        pytest.param(date(2026, 10, 22), "not_posted", id="4-sessions-before"),
        # Fri 10-16 is 8 sessions before 10-28; weekends between don't count either way.
        pytest.param(date(2026, 10, 16), "unavailable", id="across-weekends"),
    ],
)
def test_not_posted_age_boundary(
    s3, store: R2Store, tape: FakeTape, day: date, status: str
) -> None:
    tape.download_error[day] = gcs_404(day)
    outcome = land_day(day, store, API_KEY, [], last_session=LAST)
    assert outcome.status == status
    assert store.unavailable() == ({day} if status == "unavailable" else set())


def _outside_window(day: date, earliest: date | None) -> TapeDownloadError:
    detail = f"uw-403 historic window: earliest {earliest or 'unknown'}, 730 trading days"
    return TapeDownloadError("outside_window", day, detail, earliest=earliest, origin="uw")


# LAST minus OUTSIDE_WINDOW_MIN_LOOKBACK_DAYS: the newest boundary that can mark a day.
CUTOFF = date(2024, 12, 7)
OLD_BOUNDARY = date(2024, 9, 10)


def test_outside_window_cutoff_is_690_days_before_the_last_session() -> None:
    assert OUTSIDE_WINDOW_MIN_LOOKBACK_DAYS == 690
    assert LAST - timedelta(days=OUTSIDE_WINDOW_MIN_LOOKBACK_DAYS) == CUTOFF


@pytest.mark.parametrize(
    "earliest",
    [
        pytest.param(CUTOFF, id="boundary-on-the-cutoff"),
        pytest.param(date(2023, 11, 30), id="the-live-boundary"),
    ],
)
def test_outside_window_with_an_old_boundary_marks_the_day_before_it(
    s3, store: R2Store, tape: FakeTape, earliest: date
) -> None:
    day = earliest - timedelta(days=1)
    tape.download_error[day] = _outside_window(day, earliest=earliest)

    outcome = land_day(day, store, API_KEY, [], last_session=LAST)

    assert outcome == DayOutcome(day, "unavailable", "outside_window", None, ())
    marker = json.loads(_body(s3, f"fulltape/_unavailable/{day}.json"))
    assert marker["reason"] == (
        f"outside_window: uw-403 historic window: earliest {earliest}, 730 trading days"
    )


@pytest.mark.parametrize(
    ("day", "earliest"),
    [
        pytest.param(date(2024, 12, 6), CUTOFF + timedelta(days=1), id="a-day-past-the-cutoff"),
        pytest.param(OLD, date(2026, 6, 1), id="a-boundary-months-old"),
        pytest.param(OLD, OLD, id="a-recent-boundary-on-the-day"),
    ],
)
def test_outside_window_with_a_recent_boundary_fails_without_a_marker(
    s3, store: R2Store, tape: FakeTape, day: date, earliest: date
) -> None:
    """A boundary this recent means the token's entitlement shrank, not that UW lacks
    the day: it fails loudly and is retried."""
    tape.download_error[day] = _outside_window(day, earliest=earliest)

    outcome = land_day(day, store, API_KEY, [], last_session=LAST)

    assert outcome == DayOutcome(day, "failed", "outside_window short-window", None, ())
    assert store.unavailable() == set()


@pytest.mark.parametrize(
    "day",
    [pytest.param(OLD_BOUNDARY, id="on-earliest"), pytest.param(OLD, id="after-earliest")],
)
def test_outside_window_on_or_after_an_old_earliest_fails_without_a_marker(
    s3, store: R2Store, tape: FakeTape, day: date
) -> None:
    """UW's own boundary says the day is inside the window: an anomaly, retried."""
    tape.download_error[day] = _outside_window(day, earliest=OLD_BOUNDARY)

    outcome = land_day(day, store, API_KEY, [], last_session=LAST)

    assert outcome == DayOutcome(day, "failed", "outside_window", None, ())
    assert store.unavailable() == set()


def test_outside_window_without_a_boundary_fails_without_a_marker(
    s3, store: R2Store, tape: FakeTape
) -> None:
    tape.download_error[OLD] = _outside_window(OLD, earliest=None)

    outcome = land_day(OLD, store, API_KEY, [], last_session=LAST)

    assert outcome == DayOutcome(OLD, "failed", "outside_window", None, ())
    assert store.unavailable() == set()


@pytest.mark.parametrize(
    ("day", "status"),
    [
        pytest.param(date(2021, 1, 4), "unavailable", id="the-requested-day-before-earliest"),
        pytest.param(date(2023, 12, 1), "failed", id="a-day-after-earliest"),
    ],
)
def test_live_historic_403_end_to_end(
    s3,
    store: R2Store,
    tape: FakeTape,
    monkeypatch: pytest.MonkeyPatch,
    respx_mock,
    day: date,
    status: str,
) -> None:
    """The real download_tape reads UW's live 403 body (boundary 2023-11-30, which the
    same sentence follows with the echoed requested day); land_day acts on it."""
    monkeypatch.setattr(tape_job, "download_tape", uw_client.download_tape)
    respx_mock.get(f"https://api.unusualwhales.com/api/option-trades/full-tape/{day}").mock(
        return_value=httpx.Response(
            403,
            content=LIVE_HISTORIC_BODY.encode(),
            headers={"Content-Type": "application/json"},
        )
    )

    outcome = land_day(day, store, API_KEY, [], last_session=LAST)

    assert outcome == DayOutcome(day, status, "outside_window", None, ())
    if status == "unavailable":
        marker = json.loads(_body(s3, f"fulltape/_unavailable/{day}.json"))
        assert marker["reason"] == (
            "outside_window: uw-403 historic window: earliest 2023-11-30, unknown trading days"
        )
        assert store.unavailable() == {day}
    else:
        assert store.unavailable() == set()
    assert not (tape.work / day.isoformat()).exists()


@pytest.mark.parametrize(
    "kind", ["auth", "quota_daily", "transient", "corrupt", "timeout", "unexpected"]
)
def test_other_download_errors_fail_with_kind(
    s3, store: R2Store, tape: FakeTape, kind: str
) -> None:
    tape.download_error[OLD] = TapeDownloadError(kind, OLD, "gcs-500", origin="gcs")
    outcome = land_day(OLD, store, API_KEY, [], last_session=LAST)
    assert outcome == DayOutcome(OLD, "failed", kind, None, ())
    assert store.unavailable() == set()


def test_mark_unavailable_failure_fails_day(s3, store: R2Store, tape: FakeTape) -> None:
    tape.download_error[OLD] = gcs_404(OLD)
    err = ClientError({"Error": {"Code": "500", "Message": "boom"}}, "PutObject")
    with patch.object(store, "mark_unavailable", autospec=True, side_effect=err) as mark:
        outcome = land_day(OLD, store, API_KEY, [], last_session=LAST)
    mark.assert_called_once_with(OLD, "not_posted: gcs-404")
    assert outcome == DayOutcome(OLD, "failed", "ClientError", None, (), reason="500")


# --- re-landing ---------------------------------------------------------------------


def _replaced(day: date, rows: int = ROWS, source_bytes: int | None = None) -> dict[str, str]:
    """A landed object's metadata, as run_tape hands it to a re-land."""
    meta = {"rows": str(rows), "source-etag": old_etag(day)}
    if source_bytes is not None:
        meta["source-bytes"] = str(source_bytes)
    return meta


def test_reland_supersedes_right_before_the_put(
    s3, store: R2Store, tape: FakeTape, monkeypatch: pytest.MonkeyPatch
) -> None:
    replaced = _replaced(LAST)
    _seed(s3, LAST, replaced)
    _record_store_calls(monkeypatch, tape)

    outcome = land_day(LAST, store, API_KEY, [], replaced, last_session=LAST)

    assert (outcome.status, outcome.warnings) == ("relanded", ())
    # After the download, the convert and every check; nothing else in between.
    assert tape.events == [
        ("download", LAST),
        ("convert", LAST),
        ("supersede", LAST),
        ("put_tape", LAST),
    ]
    copy = s3.get_object(
        Bucket=BUCKET, Key="fulltape/_superseded/2026-10-28-old-2026-10-28.parquet"
    )
    assert copy["Body"].read() == b"old-2026-10-28"
    assert _body(s3, tape_key(LAST)) == parquet_body(LAST)


@pytest.mark.parametrize(
    ("arrange", "detail"),
    [
        pytest.param(
            lambda t: t.download_error.update(
                {LAST: TapeDownloadError("transient", LAST, "gcs-503 after 4 attempts")}
            ),
            "transient",
            id="download",
        ),
        pytest.param(
            lambda t: t.convert_error.update({LAST: TapeValidationError("corrupt zip")}),
            "TapeValidationError",
            id="convert",
        ),
        pytest.param(lambda t: t.rows.update({LAST: 999_999}), "row floor", id="row-floor"),
        pytest.param(
            lambda t: t.executed.update(
                {LAST: (_et(date(2026, 10, 29), 9, 30), _et(date(2026, 10, 29), 16))}
            ),
            "wrong-day tape",
            id="wrong-day",
        ),
    ],
)
def test_a_reland_that_fails_before_the_put_leaves_r2_untouched(
    s3, store: R2Store, tape: FakeTape, arrange, detail: str
) -> None:
    replaced = _replaced(LAST)
    _seed(s3, LAST, replaced)
    arrange(tape)

    outcome = land_day(LAST, store, API_KEY, [], replaced, last_session=LAST)

    assert (outcome.status, outcome.detail) == ("failed", detail)
    assert _keys(s3) == {tape_key(LAST)}  # no superseded copy
    assert _body(s3, tape_key(LAST)) == b"old-2026-10-28"


def test_supersede_failure_fails_day_and_never_puts(s3, store: R2Store, tape: FakeTape) -> None:
    replaced = _replaced(LAST)
    _seed(s3, LAST, replaced)
    err = ClientError({"Error": {"Code": "500", "Message": "boom"}}, "CopyObject")
    real_put = store.put_tape
    with (
        patch.object(store, "supersede", autospec=True, side_effect=err) as supersede,
        patch.object(store, "put_tape", autospec=True, side_effect=real_put) as put,
    ):
        outcome = land_day(LAST, store, API_KEY, [], replaced, last_session=LAST)

    supersede.assert_called_once_with(LAST, old_etag(LAST))
    assert put.call_count == 0
    assert tape.downloads == [LAST]
    assert outcome == DayOutcome(LAST, "failed", "ClientError", None, (), reason="500")
    assert _body(s3, tape_key(LAST)) == b"old-2026-10-28"


def test_supersede_of_missing_object_fails_day(
    s3, store: R2Store, tape: FakeTape, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger="tape_job"):
        outcome = land_day(LAST, store, API_KEY, [], _replaced(LAST), last_session=LAST)
    # botocore raises its modeled ClientError subclass, so the class name is specific.
    assert outcome == DayOutcome(LAST, "failed", "NoSuchKey", None, (), reason="NoSuchKey")
    assert tape.downloads == [LAST]
    assert _keys(s3) == set()
    # The log names this service's frame, not botocore's.
    assert "failed: NoSuchKey at r2_store.py:" in caplog.text


@pytest.mark.parametrize(
    ("new_rows", "status"),
    [
        pytest.param(6_499_999, "failed", id="below-0.65-of-the-old-rows"),
        pytest.param(6_500_000, "relanded", id="0.65-exactly"),
    ],
)
def test_a_reland_with_a_big_row_drop_keeps_the_old_object(
    s3, store: R2Store, tape: FakeTape, new_rows: int, status: str
) -> None:
    replaced = _replaced(LAST, rows=10_000_000)
    _seed(s3, LAST, replaced)
    tape.rows[LAST] = new_rows

    outcome = land_day(LAST, store, API_KEY, [], replaced, last_session=LAST)

    assert outcome.status == status
    if status == "failed":
        assert outcome == DayOutcome(LAST, "failed", "re-land row drop", None, ())
        assert _keys(s3) == {tape_key(LAST)}
        assert _body(s3, tape_key(LAST)) == b"old-2026-10-28"
    else:
        assert _body(s3, tape_key(LAST)) == parquet_body(LAST)


@pytest.mark.parametrize(
    ("rows", "source_bytes", "churn"),
    [
        pytest.param(ROWS, len(zip_body(LAST)), True, id="rows-and-source-bytes-equal"),
        pytest.param(ROWS + 1, len(zip_body(LAST)), False, id="rows-differ"),
        pytest.param(ROWS, len(zip_body(LAST)) + 1, False, id="source-bytes-differ"),
        pytest.param(ROWS, None, False, id="no-source-bytes"),
    ],
)
def test_a_reland_of_identical_content_warns_of_etag_churn(
    s3, store: R2Store, tape: FakeTape, rows: int, source_bytes: int | None, churn: bool
) -> None:
    replaced = _replaced(LAST, rows=rows, source_bytes=source_bytes)
    _seed(s3, LAST, replaced)

    outcome = land_day(LAST, store, API_KEY, [], replaced, last_session=LAST)

    # Still re-landed: the old object is copied aside and the new one put.
    assert outcome.status == "relanded"
    assert outcome.warnings == ((RELAND_IDENTICAL,) if churn else ())
    assert _body(s3, tape_key(LAST)) == parquet_body(LAST)
    assert len(_keys(s3)) == 2


@pytest.mark.parametrize(
    "error",
    [
        pytest.param(gcs_404(OLD), id="old-gcs-404"),
        pytest.param(
            _outside_window(date(2024, 9, 9), earliest=OLD_BOUNDARY), id="before-an-old-earliest"
        ),
    ],
)
def test_relanding_never_marks_unavailable(
    s3, store: R2Store, tape: FakeTape, error: TapeDownloadError
) -> None:
    """Each error would mark a day that isn't landed. A landed day is never marked
    unavailable, and its object stays as it was."""
    day = error.day
    replaced = _replaced(day)
    _seed(s3, day, replaced)
    tape.download_error[day] = error

    outcome = land_day(day, store, API_KEY, [], replaced, last_session=LAST)

    assert outcome == DayOutcome(day, "failed", error.kind, None, ())
    assert store.unavailable() == set()
    assert _body(s3, tape_key(day)) == b"old-" + day.isoformat().encode()


SECRET = "sig-SECRET-0123456789abcdef"
URL = f"https://storage.googleapis.com/uw-tape/2026-10-28.zip?X-Goog-Signature={SECRET}"


@pytest.mark.parametrize(
    "error",
    [
        pytest.param(RuntimeError(f"bad value at {URL} using {API_KEY}"), id="runtime"),
        pytest.param(OSError(28, f"No space left writing {URL}"), id="oserror"),
        pytest.param(KeyError(f"{URL} 4521.35 SPXW"), id="keyerror"),
    ],
)
def test_detail_never_carries_exception_text(
    s3, store: R2Store, tape: FakeTape, caplog: pytest.LogCaptureFixture, error: Exception
) -> None:
    tape.convert_error[LAST] = error
    with caplog.at_level(logging.DEBUG, logger="tape_job"):
        outcome = land_day(LAST, store, API_KEY, [], last_session=LAST)

    assert outcome == DayOutcome(LAST, "failed", type(error).__name__, None, ())
    assert outcome.reason is None  # only the three log-safe classes carry one
    for text in (repr(outcome), caplog.text):
        assert SECRET not in text
        assert "storage.googleapis.com" not in text
        assert API_KEY not in text
        assert "4521.35" not in text


def _put_fails(error: Exception) -> Callable[[FakeTape, R2Store, pytest.MonkeyPatch], None]:
    def arrange(tape: FakeTape, store: R2Store, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(store, "put_tape", create_autospec(store.put_tape, side_effect=error))

    return arrange


VERIFY_TEXT = "fulltape/2026-10-28-fulltape.parquet: uploaded 1016 bytes but R2 reports 1015"


@pytest.mark.parametrize(
    ("arrange", "detail", "reason"),
    [
        pytest.param(
            lambda t, s, mp: t.convert_error.update(
                {LAST: TapeValidationError("row count 9 != 10 csv lines")}
            ),
            "TapeValidationError",
            "row count 9 != 10 csv lines",
            id="validation",
        ),
        pytest.param(
            _put_fails(R2VerifyError(VERIFY_TEXT)), "R2VerifyError", VERIFY_TEXT, id="verify"
        ),
        pytest.param(
            _put_fails(
                ClientError({"Error": {"Code": "SlowDown", "Message": f"see {URL}"}}, "PutObject")
            ),
            "ClientError",
            "SlowDown",
            id="client-error-code-only",
        ),
        pytest.param(
            _put_fails(ClientError({}, "PutObject")), "ClientError", None, id="client-error-no-code"
        ),
    ],
)
def test_a_failure_of_a_log_safe_class_carries_its_reason(
    s3,
    store: R2Store,
    tape: FakeTape,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    arrange,
    detail: str,
    reason: str | None,
) -> None:
    arrange(tape, store, monkeypatch)
    with caplog.at_level(logging.DEBUG, logger="tape_job"):
        outcome = land_day(LAST, store, API_KEY, [], last_session=LAST)

    assert outcome == DayOutcome(LAST, "failed", detail, None, (), reason=reason)
    for text in (repr(outcome), caplog.text):
        assert SECRET not in text
        assert "storage.googleapis.com" not in text


def test_the_days_log_line_carries_the_reason(
    s3, settings: Settings, tape: FakeTape, caplog: pytest.LogCaptureFixture
) -> None:
    _seed(s3, J2)
    _seed(s3, J5)
    tape.convert_error[J7] = TapeValidationError("missing 1 core column(s): price")

    with caplog.at_level(logging.INFO, logger="tape_job"):
        run_tape(settings, JAN_NOW)

    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("tape 2026-01-0")]
    assert (
        "tape 2026-01-07 failed (TapeValidationError) rows=None bytes=None"
        " reason: missing 1 core column(s): price"
    ) in lines
    assert f"tape 2026-01-08 landed rows={ROWS} bytes={len(parquet_body(J8))}" in lines


def test_download_error_detail_is_kind_only(s3, store: R2Store, tape: FakeTape) -> None:
    tape.download_error[LAST] = TapeDownloadError("unexpected", LAST, f"uw-200 non-zip {URL}")
    outcome = land_day(LAST, store, API_KEY, [], last_session=LAST)
    assert outcome.detail == "unexpected"


def test_cleanup_failure_is_reported_as_a_warning(
    s3, store: R2Store, tape: FakeTape, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(path: Path, *args: object, **kwargs: object) -> None:
        raise PermissionError(13, f"denied {URL}")

    _rmtree(monkeypatch, refuse)
    outcome = land_day(LAST, store, API_KEY, [], last_session=LAST)

    assert outcome.status == "landed"
    assert outcome.warnings == ("work dir cleanup failed (PermissionError)",)
    assert SECRET not in repr(outcome)


def test_a_work_dir_that_was_never_created_is_not_a_cleanup_failure(
    s3,
    store: R2Store,
    tape: FakeTape,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    def gone(path: Path, *args: object, **kwargs: object) -> None:
        raise FileNotFoundError(2, "no such directory")

    _rmtree(monkeypatch, gone)
    with caplog.at_level(logging.WARNING, logger="tape_job"):
        outcome = land_day(LAST, store, API_KEY, [], last_session=LAST)

    assert (outcome.status, outcome.warnings) == ("landed", ())
    assert "cleanup failed" not in caplog.text


# --- rewritten_days ----------------------------------------------------------------------

_JAN = trading_days(TAPE_START, date(2026, 1, 30))


def test_rewritten_days_window_is_the_newest_landed_days(tape: FakeTape) -> None:
    """The window is the newest 5 landed days by date; only its etagged days are probed."""
    landed: dict[date, dict[str, str]] = {d: {} for d in _JAN}  # legacy: no metadata
    for d in _JAN[-9:]:  # Jan 20-30
        landed[d] = {"rows": "1", "source-etag": old_etag(d)}
    landed[date(2026, 1, 29)] = {"rows": "1", "source-etag": ""}  # empty counts as absent
    landed[date(2026, 1, 27)] = {}  # a legacy day inside the window
    landed[date(2026, 2, 2)] = {"rows": "1", "source-etag": old_etag(date(2026, 2, 2))}
    window = [date(2026, 1, n) for n in (30, 29, 28, 27, 26)]
    assert len(window) == REWRITE_RECHECK_DAYS
    checked = [date(2026, 1, n) for n in (30, 28, 26)]
    tape.probe_result = {d: old_etag(d) for d in checked}
    tape.probe_result[date(2026, 1, 28)] = '"rewritten"'

    changed = rewritten_days(landed, API_KEY, date(2026, 1, 30), deadline=NO_DEADLINE)

    assert changed == [date(2026, 1, 28)]
    # 01-23 carries an ETag but is outside the window: never probed.
    assert tape.probes == checked


def test_rewritten_days_skips_days_it_cannot_check(
    tape: FakeTape, caplog: pytest.LogCaptureFixture
) -> None:
    days = _JAN[-5:]  # Jan 26-30
    landed = {d: {"source-etag": old_etag(d)} for d in days}
    tape.probe_result = {
        days[4]: TapeDownloadError("transient", days[4], "gcs-503 after 4 attempts"),
        days[3]: RuntimeError(f"boom {URL}"),
        days[2]: None,  # no ETag: nothing to compare
        days[1]: '"rewritten"',
        days[0]: old_etag(days[0]),
    }
    with caplog.at_level(logging.WARNING, logger="tape_job"):
        changed = rewritten_days(landed, API_KEY, days[4], deadline=NO_DEADLINE)

    assert changed == [days[1]]
    assert tape.probes == days[::-1]
    assert "transient" in caplog.text
    assert "RuntimeError" in caplog.text
    assert SECRET not in caplog.text


def test_rewritten_days_with_nothing_etagged_probes_nothing(tape: FakeTape) -> None:
    landed = {d: {} for d in _JAN}
    assert rewritten_days(landed, API_KEY, date(2026, 1, 30), deadline=NO_DEADLINE) == []
    assert tape.probes == []


PROBES_SKIPPED = "rewrite check: less than the probe budget left before the run deadline"


def test_rewritten_days_stops_probing_once_less_than_the_probe_budget_is_left(
    tape: FakeTape, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    days = _JAN[-5:]  # Jan 26-30
    landed = {d: {"source-etag": old_etag(d)} for d in days}
    tape.probe_result = dict.fromkeys(days, '"rewritten"')
    clock = SimpleNamespace(now=0.0)
    monkeypatch.setattr(tape_job, "monotonic", lambda: clock.now)

    def slow(day: date) -> None:
        clock.now = 1.0  # one second spent: the next probe would start short of its budget

    tape.on_probe = slow
    with caplog.at_level(logging.WARNING, logger="tape_job"):
        # Exactly the budget left: the first probe starts.
        changed = rewritten_days(landed, API_KEY, days[4], deadline=float(PROBE_BUDGET_SECONDS))

    assert tape.probes == [days[4]]
    assert changed == [days[4]]
    assert f"{PROBES_SKIPPED}; 4 day(s) not probed" in caplog.text


def test_no_probe_starts_with_less_than_the_probe_budget_left(
    tape: FakeTape,
    sentry_messages,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    # A stalled probe can take about 1000 s, so one started this late could still be
    # running when the watchdog fires; the newest days stay in the window for next night.
    days = _JAN[-5:]
    landed = {d: {"source-etag": old_etag(d)} for d in days}
    monkeypatch.setattr(tape_job, "monotonic", lambda: 0.0)

    with caplog.at_level(logging.WARNING, logger="tape_job"):
        changed = rewritten_days(landed, API_KEY, days[4], deadline=float(PROBE_BUDGET_SECONDS - 1))

    assert changed == []
    assert tape.probes == []
    assert f"{PROBES_SKIPPED}; 5 day(s) not probed" in caplog.text
    sentry_messages.assert_called_once_with(REWRITE_UNCHECKED, level="warning", extras={"days": 5})


REWRITE_UNCHECKED = "nightly rewrite check unavailable"


@pytest.mark.parametrize(
    "results",
    [
        pytest.param(["error"] * 5, id="every-probe-failed"),
        pytest.param([None] * 5, id="no-etag-came-back"),
        pytest.param(["error", None, "error", None, None], id="failed-or-no-etag"),
    ],
)
def test_a_rewrite_check_that_compares_nothing_sends_one_warning(
    tape: FakeTape, sentry_messages, results: list[str | None]
) -> None:
    days = _JAN[-5:]  # Jan 26-30
    landed = {d: {"source-etag": old_etag(d)} for d in days}
    for d, result in zip(days, results, strict=True):
        error = TapeDownloadError("transient", d, "gcs-503 after 4 attempts")
        tape.probe_result[d] = error if result == "error" else None

    assert rewritten_days(landed, API_KEY, days[4], deadline=NO_DEADLINE) == []

    assert tape.probes == days[::-1]
    sentry_messages.assert_called_once_with(REWRITE_UNCHECKED, level="warning", extras={"days": 5})


def test_a_rewrite_check_cut_off_by_the_deadline_sends_the_warning(
    tape: FakeTape, sentry_messages
) -> None:
    days = _JAN[-5:]
    landed = {d: {"source-etag": old_etag(d)} for d in days}

    assert rewritten_days(landed, API_KEY, days[4], deadline=-NO_DEADLINE) == []

    assert tape.probes == []
    sentry_messages.assert_called_once_with(REWRITE_UNCHECKED, level="warning", extras={"days": 5})


@pytest.mark.parametrize(
    "compared",
    [pytest.param('"rewritten"', id="one-changed"), pytest.param(None, id="one-unchanged")],
)
def test_a_rewrite_check_that_compares_one_day_sends_nothing(
    tape: FakeTape, sentry_messages, compared: str | None
) -> None:
    days = _JAN[-5:]
    landed = {d: {"source-etag": old_etag(d)} for d in days}
    tape.probe_result = dict.fromkeys(days)
    tape.probe_result[days[0]] = compared or old_etag(days[0])

    rewritten_days(landed, API_KEY, days[4], deadline=NO_DEADLINE)

    sentry_messages.assert_not_called()


def test_a_rewrite_check_with_nothing_to_probe_sends_nothing(
    tape: FakeTape, sentry_messages
) -> None:
    assert rewritten_days({d: {} for d in _JAN}, API_KEY, _JAN[-1], deadline=NO_DEADLINE) == []
    sentry_messages.assert_not_called()


# --- run_tape ----------------------------------------------------------------------------


def test_run_tape_with_nothing_missing_does_nothing(s3, settings: Settings, tape: FakeTape) -> None:
    for d in (J2, J5, J6, J7, J8):
        _seed(s3, d)
    assert run_tape(settings, JAN_NOW) == []
    assert tape.downloads == []


def test_one_bad_day_does_not_stop_others(s3, settings: Settings, tape: FakeTape) -> None:
    _seed(s3, J2)
    _seed(s3, J5)
    tape.convert_error[J7] = TapeValidationError("missing 1 core column(s): price")

    outcomes = run_tape(settings, JAN_NOW)

    assert _statuses(outcomes) == [
        (J8, "landed", ""),
        (J7, "failed", "TapeValidationError"),
        (J6, "landed", ""),
    ]
    assert tape.downloads == [J8, J7, J6]
    assert tape.api_keys == {API_KEY}  # the SecretStr was unwrapped for the client only
    keys = _keys(s3)
    assert {tape_key(J8), tape_key(J6)} <= keys
    assert tape_key(J7) not in keys
    assert list(tape.work.iterdir()) == []


def test_low_disk_skips_remaining_days(s3, settings: Settings, tape: FakeTape) -> None:
    _seed(s3, J2)
    _seed(s3, J5)
    tape.free = [MIN_FREE_DISK_BYTES, MIN_FREE_DISK_BYTES - 1]

    outcomes = run_tape(settings, JAN_NOW)

    assert _statuses(outcomes) == [
        (J8, "landed", ""),
        (J7, "skipped_disk", SKIPPED_DISK),
        (J6, "skipped_disk", SKIPPED_DISK),
    ]
    assert tape.downloads == [J8]


def test_disk_check_error_skips_remaining_days_and_keeps_outcomes(
    s3, settings: Settings, tape: FakeTape, caplog: pytest.LogCaptureFixture
) -> None:
    _seed(s3, J2)
    _seed(s3, J5)
    tape.free = [MIN_FREE_DISK_BYTES, PermissionError(13, f"denied {URL}")]

    with caplog.at_level(logging.WARNING, logger="tape_job"):
        outcomes = run_tape(settings, JAN_NOW)

    assert _statuses(outcomes) == [
        (J8, "landed", ""),
        (J7, "skipped_disk", "disk check failed"),
        (J6, "skipped_disk", "disk check failed"),
    ]
    assert tape.downloads == [J8]
    assert "disk check failed (PermissionError)" in caplog.text
    assert SECRET not in caplog.text


def test_run_deadline_skips_remaining_days(
    s3, settings: Settings, tape: FakeTape, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed(s3, J2)
    _seed(s3, J5)
    clock = SimpleNamespace(now=1000.0)
    monkeypatch.setattr(tape_job, "monotonic", lambda: clock.now)

    def slow(day: date) -> None:
        clock.now += RUN_DEADLINE_SECONDS + 1

    tape.on_download = slow

    outcomes = run_tape(settings, JAN_NOW)

    # The slow day itself finishes: the deadline is checked between days.
    assert _statuses(outcomes) == [
        (J8, "landed", ""),
        (J7, "skipped_deadline", SKIPPED_DEADLINE),
        (J6, "skipped_deadline", SKIPPED_DEADLINE),
    ]
    assert tape.downloads == [J8]


def test_rewrite_probes_run_after_the_planned_days(s3, settings: Settings, tape: FakeTape) -> None:
    for d in (J2, J5, J6):
        _seed(s3, d, _replaced(d))
    tape.probe_result = {J6: '"rewritten"', J5: old_etag(J5), J2: old_etag(J2)}

    outcomes = run_tape(settings, JAN_NOW)

    # The days this run landed (J8, J7) are not probed: the window is the listing's.
    assert [e for e in tape.events if e[0] != "convert"] == [
        ("download", J8),
        ("download", J7),
        ("probe", J6),
        ("probe", J5),
        ("probe", J2),
        ("download", J6),
    ]
    assert _statuses(outcomes) == [(J8, "landed", ""), (J7, "landed", ""), (J6, "relanded", "")]


def test_the_probe_window_is_the_runs_listing(s3, settings: Settings, tape: FakeTape) -> None:
    # 07:15 UTC Sat 01-31 resolves to the Fri 01-30 session, which is missing; every
    # earlier January day is landed and etagged.
    now = datetime(2026, 1, 31, 7, 15, tzinfo=UTC)
    listed = [d for d in _JAN if d != date(2026, 1, 30)]
    for d in listed:
        _seed(s3, d, _replaced(d))
    newest = listed[::-1][:REWRITE_RECHECK_DAYS]  # 01-29 back to 01-23
    tape.probe_result = {d: old_etag(d) for d in newest}

    outcomes = run_tape(settings, now)

    assert _statuses(outcomes) == [(date(2026, 1, 30), "landed", "")]
    # The day this run landed takes no slot: five days of the listing are probed.
    assert tape.probes == newest


def test_a_run_whose_planned_days_were_skipped_probes_nothing(
    s3, settings: Settings, tape: FakeTape
) -> None:
    for d in (J2, J5, J6):
        _seed(s3, d, _replaced(d))  # no probe results: any probe fails the test
    tape.free = [MIN_FREE_DISK_BYTES, MIN_FREE_DISK_BYTES - 1]

    outcomes = run_tape(settings, JAN_NOW)

    assert _statuses(outcomes) == [(J8, "landed", ""), (J7, "skipped_disk", SKIPPED_DISK)]
    assert tape.probes == []


def test_run_deadline_passing_during_probes_stops_them(
    s3, settings: Settings, tape: FakeTape, monkeypatch: pytest.MonkeyPatch
) -> None:
    for d in (J2, J5, J6):
        _seed(s3, d, _replaced(d))
    clock = SimpleNamespace(now=1000.0)
    monkeypatch.setattr(tape_job, "monotonic", lambda: clock.now)

    def slow(day: date) -> None:
        clock.now += RUN_DEADLINE_SECONDS + 1

    tape.on_probe = slow
    tape.probe_result = {J6: '"rewritten"'}

    outcomes = run_tape(settings, JAN_NOW)

    # The planned days land first. The probe of the newest etagged day overran the
    # run deadline: no more probes, and the re-land it found is skipped.
    assert tape.probes == [J6]
    assert _statuses(outcomes) == [
        (J8, "landed", ""),
        (J7, "landed", ""),
        (J6, "skipped_deadline", SKIPPED_DEADLINE),
    ]
    assert tape.downloads == [J8, J7]


@pytest.mark.parametrize(
    ("spent", "second_day_starts"),
    [
        (RUN_DEADLINE_SECONDS - DAY_BUDGET_SECONDS, True),
        (RUN_DEADLINE_SECONDS - DAY_BUDGET_SECONDS + 1, False),
    ],
    ids=["budget-left", "one-second-short"],
)
def test_a_day_starts_only_with_its_budget_left(
    s3,
    settings: Settings,
    tape: FakeTape,
    monkeypatch: pytest.MonkeyPatch,
    spent: int,
    second_day_starts: bool,
) -> None:
    # The deadline is a true bound: a day never starts that could run past it.
    for d in (J2, J5, J6):
        _seed(s3, d)
    clock = SimpleNamespace(now=1000.0)
    monkeypatch.setattr(tape_job, "monotonic", lambda: clock.now)

    def first_day_takes(day: date) -> None:
        if day == J8:
            clock.now += spent

    tape.on_download = first_day_takes

    outcomes = run_tape(settings, JAN_NOW)

    if second_day_starts:
        assert _statuses(outcomes) == [(J8, "landed", ""), (J7, "landed", "")]
        assert tape.downloads == [J8, J7]
    else:
        assert _statuses(outcomes) == [
            (J8, "landed", ""),
            (J7, "skipped_deadline", SKIPPED_DEADLINE),
        ]
        assert tape.downloads == [J8]


def test_outcomes_are_reported_as_each_day_finishes(s3, settings: Settings, tape: FakeTape) -> None:
    _seed(s3, J2)
    _seed(s3, J5)
    tape.convert_error[J7] = TapeValidationError("corrupt zip")
    tape.free = [MIN_FREE_DISK_BYTES, MIN_FREE_DISK_BYTES, MIN_FREE_DISK_BYTES - 1]
    reported: list[tuple[date, str, str]] = []
    reported_before_download: list[int] = []
    tape.on_download = lambda day: reported_before_download.append(len(reported))

    outcomes = run_tape(
        settings, JAN_NOW, on_outcome=lambda o: reported.append((o.day, o.status, o.detail))
    )

    # Each day is reported before the next one starts, the skipped day included.
    assert reported == [
        (J8, "landed", ""),
        (J7, "failed", "TapeValidationError"),
        (J6, "skipped_disk", SKIPPED_DISK),
    ]
    assert reported == _statuses(outcomes)
    assert reported_before_download == [0, 1]


def test_a_raising_outcome_callback_does_not_stop_the_run(
    s3, settings: Settings, tape: FakeTape, caplog: pytest.LogCaptureFixture
) -> None:
    _seed(s3, J2)
    _seed(s3, J5)
    calls: list[date] = []

    def report(outcome: DayOutcome) -> None:
        calls.append(outcome.day)
        raise RuntimeError(f"report failed {URL}")

    with caplog.at_level(logging.WARNING, logger="tape_job"):
        outcomes = run_tape(settings, JAN_NOW, on_outcome=report)

    assert _statuses(outcomes) == [(J8, "landed", ""), (J7, "landed", ""), (J6, "landed", "")]
    assert calls == [J8, J7, J6]
    assert "outcome report failed (RuntimeError)" in caplog.text
    assert SECRET not in caplog.text


def test_keyboard_interrupt_propagates_and_cleans_work_dir(
    s3, settings: Settings, tape: FakeTape
) -> None:
    _seed(s3, J2)
    _seed(s3, J5)
    tape.download_error[J8] = KeyboardInterrupt()

    with pytest.raises(KeyboardInterrupt):
        run_tape(settings, JAN_NOW)

    assert tape.downloads == [J8]
    assert not (tape.work / J8.isoformat()).exists()


def test_cleanup_failure_does_not_mask_an_interrupt(
    s3,
    store: R2Store,
    tape: FakeTape,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    def refuse(path: Path, *args: object, **kwargs: object) -> None:
        raise PermissionError(13, "denied")

    _rmtree(monkeypatch, refuse)
    tape.download_error[LAST] = KeyboardInterrupt()
    with caplog.at_level(logging.WARNING, logger="tape_job"), pytest.raises(KeyboardInterrupt):
        land_day(LAST, store, API_KEY, [], last_session=LAST)
    assert "work dir cleanup failed (PermissionError)" in caplog.text


def _seed_all_jan(s3) -> None:
    for d in (J2, J5, J6, J7, J8):
        _seed(s3, d)


def test_stale_day_dirs_are_removed_before_the_run(
    s3, settings: Settings, tape: FakeTape, caplog: pytest.LogCaptureFixture
) -> None:
    _seed_all_jan(s3)
    stale = tape.work / "2026-01-05"
    (stale / "inner").mkdir(parents=True)
    (stale / "inner" / "2026-01-05-fulltape.zip.part").write_bytes(b"partial")
    kept = [
        tape.work / name
        for name in ("2026-02-30", "20260105", "2026-W02-1", "notes", "2026-01-05.bak")
    ]
    for path in kept:
        path.mkdir()
    (tape.work / "2026-01-06").write_bytes(b"a file, not a dir")
    kept.append(tape.work / "2026-01-06")

    with caplog.at_level(logging.WARNING, logger="tape_job"):
        assert run_tape(settings, JAN_NOW) == []

    assert not stale.exists()
    assert all(path.exists() for path in kept)
    assert "removed 1 stale day dir(s) from WORK_DIR; 0 could not be removed" in caplog.text


def _link_dir(link: Path, target: Path) -> None:
    """A directory symlink, or on Windows without the privilege, a junction."""
    try:
        os.symlink(target, link, target_is_directory=True)
    except OSError:
        if os.name != "nt":
            raise
        import _winapi  # Windows-only module

        _winapi.CreateJunction(str(target), str(link))


def test_stale_day_dir_link_is_left_alone(
    s3, settings: Settings, tape: FakeTape, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    _seed_all_jan(s3)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep.txt").write_bytes(b"keep")
    tape.work.mkdir()
    link = tape.work / "2026-01-05"
    _link_dir(link, outside)

    with caplog.at_level(logging.WARNING, logger="tape_job"):
        assert run_tape(settings, JAN_NOW) == []

    assert (outside / "keep.txt").read_bytes() == b"keep"
    assert link.is_symlink() or link.is_junction()
    assert "stale day dir" not in caplog.text  # never counted as a day dir


def test_stale_day_dir_that_cannot_be_removed_does_not_stop_the_run(
    s3,
    settings: Settings,
    tape: FakeTape,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    _seed_all_jan(s3)
    (tape.work / "2026-01-05").mkdir(parents=True)

    def stuck(path: Path, ignore_errors: bool = False, *args: object, **kwargs: object) -> None:
        if not ignore_errors:
            raise PermissionError(13, "in use")

    _rmtree(monkeypatch, stuck)
    with caplog.at_level(logging.WARNING, logger="tape_job"):
        assert run_tape(settings, JAN_NOW) == []

    assert "removed 0 stale day dir(s) from WORK_DIR; 1 could not be removed" in caplog.text


def test_a_run_writes_at_most_two_markers(s3, settings: Settings, tape: FakeTape) -> None:
    # 07:15 UTC Sat 2026-01-31 resolves to the Fri 01-30 session; all three days are
    # old GCS 404s, which would each be marked.
    now = datetime(2026, 1, 31, 7, 15, tzinfo=UTC)
    gone = [date(2026, 1, 22), date(2026, 1, 21), date(2026, 1, 20)]
    for d in _JAN:
        if d not in gone:
            _seed(s3, d)
    for d in gone:
        tape.download_error[d] = gcs_404(d)

    outcomes = run_tape(settings, now)

    assert MAX_MARKERS_PER_RUN == 2
    assert _statuses(outcomes) == [
        (gone[0], "unavailable", "not_posted"),
        (gone[1], "unavailable", "not_posted"),
        (gone[2], "failed", "marker cap"),
    ]
    assert R2Store(settings).unavailable() == set(gone[:2])

    # The capped day is retried, and marked, by the next run.
    assert _statuses(run_tape(settings, now)) == [(gone[2], "unavailable", "not_posted")]
    assert R2Store(settings).unavailable() == set(gone)


def test_a_failed_marker_write_does_not_count_toward_the_cap(
    s3, settings: Settings, tape: FakeTape, monkeypatch: pytest.MonkeyPatch
) -> None:
    now = datetime(2026, 1, 31, 7, 15, tzinfo=UTC)
    gone = [date(2026, 1, 22), date(2026, 1, 21), date(2026, 1, 20)]
    for d in _JAN:
        if d not in gone:
            _seed(s3, d)
    for d in gone:
        tape.download_error[d] = gcs_404(d)
    real_mark = R2Store.mark_unavailable
    err = ClientError({"Error": {"Code": "500", "Message": "boom"}}, "PutObject")

    def mark(self: R2Store, day: date, reason: str) -> None:
        if day == gone[0]:
            raise err
        real_mark(self, day, reason)

    monkeypatch.setattr(R2Store, "mark_unavailable", mark)

    outcomes = run_tape(settings, now)

    assert _statuses(outcomes) == [
        (gone[0], "failed", "ClientError"),
        (gone[1], "unavailable", "not_posted"),
        (gone[2], "unavailable", "not_posted"),
    ]


def test_listing_error_propagates(s3, settings: Settings, tape: FakeTape) -> None:
    missing = settings.model_copy(update={"r2_bucket_fulltape": "missing-bucket"})

    with pytest.raises(ClientError) as caught:
        run_tape(missing, JAN_NOW)

    assert caught.value.response["Error"]["Code"] == "NoSuchBucket"
    assert tape.downloads == []


def test_rewrite_relands_after_supersede(s3, settings: Settings, tape: FakeTape) -> None:
    # 07:15 UTC Sat 2026-01-31 resolves to the Fri 01-30 session.
    now = datetime(2026, 1, 31, 7, 15, tzinfo=UTC)
    missing = date(2026, 1, 16)
    rewritten = date(2026, 1, 28)
    etagged = [date(2026, 1, n) for n in (22, 23, 26, 27, 28, 29, 30)]
    for d in _JAN:
        if d == missing:
            continue
        _seed(s3, d, {"rows": str(ROWS), "source-etag": old_etag(d)} if d in etagged else None)
    tape.probe_result = {d: old_etag(d) for d in etagged[-REWRITE_RECHECK_DAYS:]}
    tape.probe_result[rewritten] = '"rewritten"'
    tape.rows[missing] = 7_770_000

    with patch.object(tape_job, "land_day", autospec=True, side_effect=land_day) as spy:
        outcomes = run_tape(settings, now)

    # The plan's days first, then the re-land.
    assert _statuses(outcomes) == [(missing, "landed", ""), (rewritten, "relanded", "")]
    assert tape.downloads == [missing, rewritten]
    reland = _bound(spy)
    # The re-land gets the replaced object's metadata, from the run's one listing.
    assert reland.arguments["replacing"] == {"rows": str(ROWS), "source-etag": old_etag(rewritten)}
    # Nearest first, both sides (01-27 and 01-29, then 01-26 and 01-30, ...); the
    # baseline already counts 01-16, which this run just landed.
    assert reland.arguments["baseline_rows"] == [ROWS] * 6 + [7_770_000]
    copy_key = "fulltape/_superseded/2026-01-28-old-2026-01-28.parquet"
    # The copy holds the old bytes and metadata, so it was taken before the put.
    copy = s3.get_object(Bucket=BUCKET, Key=copy_key)
    assert copy["Body"].read() == b"old-2026-01-28"
    assert copy["Metadata"] == {"rows": str(ROWS), "source-etag": old_etag(rewritten)}
    head = s3.head_object(Bucket=BUCKET, Key=tape_key(rewritten))
    assert set(head["Metadata"]) == METADATA_KEYS
    assert head["Metadata"]["source-etag"] == new_etag(rewritten)
    assert _body(s3, tape_key(rewritten)) == parquet_body(rewritten)


FEB_NOW = datetime(2026, 2, 14, 7, 15, tzinfo=UTC)  # resolves to the Fri 02-13 session


def test_baseline_rows_come_from_the_20_nearest_landed_days_on_either_side(
    s3, settings: Settings, tape: FakeTape
) -> None:
    target = date(2026, 1, 23)
    around = [d for d in trading_days(TAPE_START, date(2026, 2, 13)) if d != target]
    legacy = {date(2026, 1, 21), date(2026, 2, 4)}  # no rows: skipped, never a slot
    rows = {d: ROWS + i for i, d in enumerate(around)}
    for d in around:
        _seed(s3, d, None if d in legacy else {"rows": str(rows[d])})
    tape.rows[target] = 2_000_000

    with patch.object(tape_job, "land_day", autospec=True, side_effect=land_day) as spy:
        [outcome] = run_tape(settings, FEB_NOW)

    # Nearest first; on a tie in distance, the earlier day first. The two legacy days
    # are skipped, so the 20 reach two days further out: 01-07 and 01-06.
    nearest = [
        date(2026, 1, 22),  # 1 day
        date(2026, 1, 20),  # 3
        date(2026, 1, 26),  # 3
        date(2026, 1, 27),  # 4
        date(2026, 1, 28),  # 5
        date(2026, 1, 29),  # 6
        date(2026, 1, 16),  # 7
        date(2026, 1, 30),  # 7
        date(2026, 1, 15),  # 8
        date(2026, 1, 14),  # 9
        date(2026, 1, 13),  # 10
        date(2026, 2, 2),  # 10
        date(2026, 1, 12),  # 11
        date(2026, 2, 3),  # 11
        date(2026, 2, 5),  # 13
        date(2026, 1, 9),  # 14
        date(2026, 2, 6),  # 14
        date(2026, 1, 8),  # 15
        date(2026, 1, 7),  # 16
        date(2026, 1, 6),  # 17, before 02-09 (also 17)
    ]
    bound = _bound(spy)
    assert bound.arguments["baseline_rows"] == [rows[d] for d in nearest]
    assert bound.arguments["last_session"] == date(2026, 2, 13)
    assert outcome.status == "landed"
    [warning] = outcome.warnings
    assert warning.startswith("rows 2,000,000 below 0.65 x the baseline median")


def test_a_day_beside_legacy_days_still_gets_20_baseline_values(
    s3, settings: Settings, tape: FakeTape
) -> None:
    # 07:15 UTC Sat 2026-03-14 resolves to the Fri 03-13 session, the one missing day.
    # Its 15 nearest landed days are legacy (no rows); the 20 before those carry rows.
    now = datetime(2026, 3, 14, 7, 15, tzinfo=UTC)
    target = date(2026, 3, 13)
    before = trading_days(TAPE_START, date(2026, 3, 12))[::-1]  # newest first
    legacy = set(before[:15]) | set(before[35:])
    valued = before[15:35]
    for d in before:
        _seed(s3, d, None if d in legacy else {"rows": str(ROWS)})
    tape.rows[target] = 2_000_000

    with patch.object(tape_job, "land_day", autospec=True, side_effect=land_day) as spy:
        [outcome] = run_tape(settings, now)

    assert len(valued) == 20
    assert _bound(spy).arguments["baseline_rows"] == [ROWS] * 20
    # With 20 values, the ratio check runs (15 legacy slots would have left 5 values).
    [warning] = outcome.warnings
    assert warning == "rows 2,000,000 below 0.65 x the baseline median 8,000,000 of 20 day(s)"


def test_a_backfill_day_with_only_later_landed_days_gets_a_baseline(
    s3, settings: Settings, tape: FakeTape
) -> None:
    # 01-02 to 01-15 are missing and nothing before them is landed: the backfill. The
    # newest missing day, 01-15, lands first, against the ten landed days after it.
    later = trading_days(date(2026, 1, 16), date(2026, 2, 13))
    for d in later:
        _seed(s3, d, {"rows": str(ROWS)})
    first = date(2026, 1, 15)
    tape.rows[first] = 2_000_000

    with patch.object(tape_job, "land_day", autospec=True, side_effect=land_day) as spy:
        outcomes = run_tape(settings, FEB_NOW)

    assert [o.day for o in outcomes] == trading_days(TAPE_START, first)[::-1]
    assert all(o.status == "landed" for o in outcomes)
    assert _bound(spy, 0).arguments["baseline_rows"] == [ROWS] * 20
    [warning] = outcomes[0].warnings
    assert warning == "rows 2,000,000 below 0.65 x the baseline median 8,000,000 of 20 day(s)"
    # The next day's nearest landed neighbour is the day this run just landed.
    assert _bound(spy, 1).arguments["baseline_rows"][0] == 2_000_000
