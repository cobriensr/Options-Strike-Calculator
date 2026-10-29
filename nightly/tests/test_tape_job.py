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
from botocore.exceptions import ClientError
from moto import mock_aws

import tape_convert
import tape_job
import uw_client
from calendar_nyse import trading_days
from config import Settings, load_settings
from constants import (
    CATCHUP_MAX_DAYS,
    DAY_BUDGET_SECONDS,
    MIN_FREE_DISK_BYTES,
    REWRITE_RECHECK_DAYS,
    RUN_DEADLINE_SECONDS,
    SCHEMA_VERSION,
    TAPE_START,
)
from r2_store import R2Store, R2VerifyError, tape_key
from tape_convert import ConvertResult, TapeValidationError
from tape_job import DayOutcome, land_day, plan_days, rewritten_days, run_tape
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
        self.free: list[int | OSError] = []
        self.on_download: Callable[[date], None] | None = None
        self.on_probe: Callable[[date], None] | None = None

    def download(self, day: date, dest: Path, api_key: str) -> SourceInfo:
        self.downloads.append(day)
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
        assert zip_path.read_bytes() == zip_body(session)
        out_path.write_bytes(parquet_body(session))
        if session in self.convert_error:
            raise self.convert_error[session]
        return ConvertResult(
            rows=self.rows.get(session, 1000),
            columns=["id", "date", "ingested_at"],
            sha256=hashlib.sha256(parquet_body(session)).hexdigest(),
            bytes=len(parquet_body(session)),
            min_executed_at=None,
            max_executed_at=None,
        )

    def probe(self, day: date, api_key: str) -> SourceInfo:
        self.probes.append(day)
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


def _bound(spy) -> inspect.BoundArguments:
    return inspect.signature(land_day).bind(*spy.call_args.args, **spy.call_args.kwargs)


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
        "trailing_rows",
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

    assert outcome == DayOutcome(LAST, "landed", "", 1000, (), bytes=len(parquet_body(LAST)))
    head = s3.head_object(Bucket=BUCKET, Key=tape_key(LAST))
    meta = head["Metadata"]
    assert set(meta) == METADATA_KEYS
    assert meta["rows"] == "1000"
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
    tape.rows[LAST] = 100
    outcome = land_day(LAST, store, API_KEY, [1000] * 12, last_session=LAST)
    assert outcome.status == "landed"
    [warning] = outcome.warnings
    assert warning.startswith("rows 100 below 0.65 x the trailing median 1,000 of 12 day(s)")


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
    assert outcome == DayOutcome(LAST, "failed", "TapeValidationError", None, ())


def test_put_verify_error_fails_day(s3, store: R2Store, tape: FakeTape) -> None:
    error = R2VerifyError("fulltape/x: could not verify")
    with patch.object(store, "put_tape", autospec=True, side_effect=error) as put:
        outcome = land_day(LAST, store, API_KEY, [], last_session=LAST)
    assert put.call_count == 1
    assert outcome == DayOutcome(LAST, "failed", "R2VerifyError", None, ())


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


def test_outside_window_before_uw_earliest_marks_unavailable(
    s3, store: R2Store, tape: FakeTape
) -> None:
    tape.download_error[OLD] = _outside_window(OLD, earliest=date(2026, 6, 1))

    outcome = land_day(OLD, store, API_KEY, [], last_session=LAST)

    assert outcome == DayOutcome(OLD, "unavailable", "outside_window", None, ())
    marker = json.loads(_body(s3, "fulltape/_unavailable/2026-05-29.json"))
    assert marker["reason"] == (
        "outside_window: uw-403 historic window: earliest 2026-06-01, 730 trading days"
    )


@pytest.mark.parametrize(
    "earliest",
    [pytest.param(OLD, id="on-earliest"), pytest.param(date(2026, 1, 2), id="after-earliest")],
)
def test_outside_window_on_or_after_earliest_fails_without_a_marker(
    s3, store: R2Store, tape: FakeTape, earliest: date
) -> None:
    """UW's own boundary says the day is inside the window: an anomaly, retried."""
    tape.download_error[OLD] = _outside_window(OLD, earliest=earliest)

    outcome = land_day(OLD, store, API_KEY, [], last_session=LAST)

    assert outcome == DayOutcome(OLD, "failed", "outside_window", None, ())
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
    assert outcome == DayOutcome(OLD, "failed", "ClientError", None, ())


def test_supersede_failure_fails_day_and_never_puts(s3, store: R2Store, tape: FakeTape) -> None:
    _seed(s3, LAST, {"source-etag": old_etag(LAST)})
    err = ClientError({"Error": {"Code": "500", "Message": "boom"}}, "CopyObject")
    real_put = store.put_tape
    with (
        patch.object(store, "supersede", autospec=True, side_effect=err) as supersede,
        patch.object(store, "put_tape", autospec=True, side_effect=real_put) as put,
    ):
        outcome = land_day(LAST, store, API_KEY, [], old_etag(LAST), last_session=LAST)

    supersede.assert_called_once_with(LAST, old_etag(LAST))
    assert put.call_count == 0
    assert tape.downloads == []
    assert outcome == DayOutcome(LAST, "failed", "ClientError", None, ())
    assert _body(s3, tape_key(LAST)) == b"old-2026-10-28"


def test_supersede_of_missing_object_fails_day(
    s3, store: R2Store, tape: FakeTape, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger="tape_job"):
        outcome = land_day(LAST, store, API_KEY, [], old_etag(LAST), last_session=LAST)
    # botocore raises its modeled ClientError subclass, so the class name is specific.
    assert outcome == DayOutcome(LAST, "failed", "NoSuchKey", None, ())
    assert tape.downloads == []
    assert _keys(s3) == set()
    # The log names this service's frame, not botocore's.
    assert "failed: NoSuchKey at r2_store.py:" in caplog.text


@pytest.mark.parametrize(
    "error",
    [
        pytest.param(gcs_404(OLD), id="old-gcs-404"),
        pytest.param(_outside_window(OLD, earliest=date(2026, 6, 1)), id="before-earliest"),
    ],
)
def test_relanding_never_marks_unavailable(
    s3, store: R2Store, tape: FakeTape, error: TapeDownloadError
) -> None:
    """A landed day is never marked unavailable, and its object stays as it was."""
    _seed(s3, OLD, {"source-etag": old_etag(OLD)})
    tape.download_error[OLD] = error

    outcome = land_day(OLD, store, API_KEY, [], old_etag(OLD), last_session=LAST)

    assert outcome == DayOutcome(OLD, "failed", error.kind, None, ())
    assert store.unavailable() == set()
    assert _body(s3, tape_key(OLD)) == b"old-2026-05-29"


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
    for text in (repr(outcome), caplog.text):
        assert SECRET not in text
        assert "storage.googleapis.com" not in text
        assert API_KEY not in text
        assert "4521.35" not in text


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


def test_rewritten_days_stops_probing_at_the_deadline(
    tape: FakeTape, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    days = _JAN[-5:]  # Jan 26-30
    landed = {d: {"source-etag": old_etag(d)} for d in days}
    tape.probe_result = dict.fromkeys(days, '"rewritten"')
    clock = SimpleNamespace(now=0.0)
    monkeypatch.setattr(tape_job, "monotonic", lambda: clock.now)

    def slow(day: date) -> None:
        clock.now = 100.0

    tape.on_probe = slow
    with caplog.at_level(logging.WARNING, logger="tape_job"):
        changed = rewritten_days(landed, API_KEY, days[4], deadline=100.0)

    assert tape.probes == [days[4]]
    assert changed == [days[4]]
    assert "rewrite check: run deadline passed; 4 day(s) not probed" in caplog.text


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


def test_run_deadline_passing_during_probes_stops_them(
    s3, settings: Settings, tape: FakeTape, monkeypatch: pytest.MonkeyPatch
) -> None:
    for d in (J2, J5, J6):
        _seed(s3, d, {"rows": "1000", "source-etag": old_etag(d)})
    clock = SimpleNamespace(now=1000.0)
    monkeypatch.setattr(tape_job, "monotonic", lambda: clock.now)

    def slow(day: date) -> None:
        clock.now += RUN_DEADLINE_SECONDS + 1

    tape.on_probe = slow
    tape.probe_result = {J6: '"rewritten"'}

    outcomes = run_tape(settings, JAN_NOW)

    # The probe of the newest etagged day overran the run deadline: no more probes,
    # and every queued day, the re-land included, is skipped.
    assert tape.probes == [J6]
    assert _statuses(outcomes) == [
        (J8, "skipped_deadline", SKIPPED_DEADLINE),
        (J7, "skipped_deadline", SKIPPED_DEADLINE),
        (J6, "skipped_deadline", SKIPPED_DEADLINE),
    ]
    assert tape.downloads == []


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
        _seed(s3, d, {"rows": "1000", "source-etag": old_etag(d)} if d in etagged else None)
    tape.probe_result = {d: old_etag(d) for d in etagged[-REWRITE_RECHECK_DAYS:]}
    tape.probe_result[rewritten] = '"rewritten"'
    tape.rows[missing] = 777

    with patch.object(tape_job, "land_day", autospec=True, side_effect=land_day) as spy:
        outcomes = run_tape(settings, now)

    # The plan's days first, then the re-land.
    assert _statuses(outcomes) == [(missing, "landed", ""), (rewritten, "relanded", "")]
    assert tape.downloads == [missing, rewritten]
    # The re-land's trailing window already counts the day this run just landed.
    reland = _bound(spy)
    assert reland.arguments["relanding_etag"] == old_etag(rewritten)
    assert reland.arguments["trailing_rows"] == [1000, 1000, 1000, 1000, 777]
    copy_key = "fulltape/_superseded/2026-01-28-old-2026-01-28.parquet"
    # The copy holds the old bytes and metadata, so it was taken before the put.
    copy = s3.get_object(Bucket=BUCKET, Key=copy_key)
    assert copy["Body"].read() == b"old-2026-01-28"
    assert copy["Metadata"] == {"rows": "1000", "source-etag": old_etag(rewritten)}
    head = s3.head_object(Bucket=BUCKET, Key=tape_key(rewritten))
    assert set(head["Metadata"]) == METADATA_KEYS
    assert head["Metadata"]["source-etag"] == new_etag(rewritten)
    assert _body(s3, tape_key(rewritten)) == parquet_body(rewritten)


def test_trailing_rows_come_from_up_to_20_landed_days_before(
    s3, settings: Settings, tape: FakeTape
) -> None:
    # 07:15 UTC Sat 2026-02-14 resolves to the Fri 02-13 session.
    now = datetime(2026, 2, 14, 7, 15, tzinfo=UTC)
    target = date(2026, 2, 13)
    before = trading_days(TAPE_START, date(2026, 2, 12))  # 29 days, all landed
    legacy = {date(2026, 2, 11), date(2026, 2, 5)}
    rows = {d: 2000 + i for i, d in enumerate(before)}
    for d in before:
        _seed(s3, d, None if d in legacy else {"rows": str(rows[d])})
    tape.rows[target] = 100

    with patch.object(tape_job, "land_day", autospec=True, side_effect=land_day) as spy:
        [outcome] = run_tape(settings, now)

    nearest = before[::-1][:20]
    expected = [rows[d] for d in nearest if d not in legacy]
    assert len(expected) == 18
    bound = _bound(spy)
    assert bound.arguments["trailing_rows"] == expected
    assert bound.arguments["last_session"] == target
    assert outcome.status == "landed"
    assert len(outcome.warnings) == 1
    assert outcome.warnings[0].startswith("rows 100 below")
