"""End to end: one day landed, then re-landed when UW's ETag changes.

The real uw_client (respx answers every HTTP request), the real convert_zip on a tiny
valid zip, and the real R2Store (moto) run across two run_tape calls. Only the HTTP
boundary, sleep and the calendar's "now" (run_tape's `now_utc`) are stand-ins, plus
three of tape_job's constants: WORK_DIR (a tmp dir), MIN_TAPE_ROWS (the zip has a few
rows, far below the real floor) and MIN_FREE_DISK_BYTES (so a nearly full test disk
can't skip the day). No function of the service is faked.
"""

from __future__ import annotations

import io
import zipfile
from collections.abc import Iterator
from datetime import UTC, date, datetime
from pathlib import Path

import boto3
import httpx
import polars as pl
import pytest
from moto import mock_aws

import tape_job
from config import Settings, load_settings
from r2_store import tape_key
from tape_job import run_tape
from tests.test_tape_convert import _csv_bytes, _row

pytestmark = pytest.mark.respx(assert_all_called=True)

BUCKET = "test-bucket"
# 07:15 UTC Fri 2026-01-09 resolves to the Thu 01-08 session; the tape starts 01-02.
NOW = datetime(2026, 1, 9, 7, 15, tzinfo=UTC)
DAY = date(2026, 1, 8)
EARLIER = [date(2026, 1, 2), date(2026, 1, 5), date(2026, 1, 6), date(2026, 1, 7)]
UW_URL = "https://api.unusualwhales.com/api/option-trades/full-tape/2026-01-08"
GCS_URL = "https://storage.googleapis.com/uw-full-tape/2026-01-08-fulltape.zip"
LAST_MODIFIED = "Fri, 09 Jan 2026 05:12:00 GMT"


def _tape_zip(rows: int) -> bytes:
    """A one-CSV zip of `rows` trades, all inside the 01-08 session (09:30 ET on)."""
    trades = [
        _row(
            id=f"trade-{n}",
            executed_at=f"2026-01-08 14:30:{n:02d}.25+00",
            created_at=f"2026-01-08 14:30:{n:02d}.5+00",
        )
        for n in range(rows)
    ]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("full_tape_20260108.csv", _csv_bytes(trades))
    return buf.getvalue()


@pytest.fixture
def s3() -> Iterator[object]:
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket=BUCKET)
        yield client


@pytest.fixture
def settings() -> Settings:
    # moto only intercepts AWS hostnames; a custom R2 endpoint would go out to the network.
    return load_settings().model_copy(
        update={"r2_endpoint_url": "https://s3.amazonaws.com", "r2_bucket_fulltape": BUCKET}
    )


@pytest.fixture
def sleeps(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    calls: list[float] = []
    monkeypatch.setattr("uw_client.time.sleep", calls.append)
    return calls


@pytest.fixture(autouse=True)
def _limits(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(tape_job, "WORK_DIR", tmp_path / "work")
    monkeypatch.setattr(tape_job, "MIN_TAPE_ROWS", 1)
    monkeypatch.setattr(tape_job, "MIN_FREE_DISK_BYTES", 0)


def test_a_day_lands_then_relands_when_its_etag_changes(
    s3, settings: Settings, respx_mock, sleeps: list[float]
) -> None:
    for d in EARLIER:  # legacy days: landed, no metadata, never probed
        s3.put_object(Bucket=BUCKET, Key=tape_key(d), Body=b"legacy")
    served = {"etag": '"etag-1"', "body": _tape_zip(3)}
    signed = iter(range(1, 100))
    uw = respx_mock.get(UW_URL).mock(
        side_effect=lambda _request: httpx.Response(
            302, headers={"Location": f"{GCS_URL}?X-Goog-Signature=sig-{next(signed)}"}
        )
    )
    gcs = respx_mock.get(GCS_URL).mock(
        side_effect=lambda _request: httpx.Response(
            200,
            headers={
                "ETag": served["etag"],
                "Last-Modified": LAST_MODIFIED,
                "Content-Type": "application/zip",
                "Content-Length": str(len(served["body"])),
            },
            content=served["body"],
        )
    )

    # Night 1: the day is missing, so it lands.
    first = run_tape(settings, NOW)

    assert [(o.day, o.status, o.detail, o.rows) for o in first] == [(DAY, "landed", "", 3)]
    head = s3.head_object(Bucket=BUCKET, Key=tape_key(DAY))
    assert head["Metadata"]["source-etag"] == '"etag-1"'
    assert head["Metadata"]["rows"] == "3"
    assert head["Metadata"]["source-bytes"] == str(len(served["body"]))
    landed_first = s3.get_object(Bucket=BUCKET, Key=tape_key(DAY))["Body"].read()
    assert pl.read_parquet(io.BytesIO(landed_first))["id"].to_list() == [
        "trade-0",
        "trade-1",
        "trade-2",
    ]
    assert (uw.call_count, gcs.call_count) == (1, 1)

    # Night 2: UW serves a changed ETag and different content. The probe sees the new
    # ETag, and the day is re-landed with the old object copied aside first.
    served.update(etag='"etag-2"', body=_tape_zip(4))

    second = run_tape(settings, NOW)

    assert [(o.day, o.status, o.detail, o.rows, o.warnings) for o in second] == [
        (DAY, "relanded", "", 4, ())
    ]
    copy = s3.get_object(Bucket=BUCKET, Key="fulltape/_superseded/2026-01-08-etag-1.parquet")
    assert copy["Body"].read() == landed_first
    assert copy["Metadata"]["source-etag"] == '"etag-1"'
    new = s3.get_object(Bucket=BUCKET, Key=tape_key(DAY))
    assert new["Metadata"]["source-etag"] == '"etag-2"'
    assert new["Metadata"]["rows"] == "4"
    assert pl.read_parquet(io.BytesIO(new["Body"].read())).height == 4
    # One probe and one download, each a UW request redirected to GCS; no retries.
    assert (uw.call_count, gcs.call_count) == (3, 3)
    assert sleeps == []
    assert list((tape_job.WORK_DIR).iterdir()) == []
