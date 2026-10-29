"""Tests for the R2 tape store.

moto answers every S3 call in-process: no real R2, no real credentials. Failure
modes (size mismatch, failed upload, head_object errors, paged listings) are patched or
provoked at the boto3 client boundary.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date
from pathlib import Path
from unittest.mock import patch

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from config import Settings, load_settings
from r2_store import R2Store, R2VerifyError, tape_key

BUCKET = "test-bucket"
D1 = date(2026, 10, 26)
D2 = date(2026, 10, 27)
META = {
    "rows": "3",
    "sha256": "abc",
    "schema-version": "nightly-1",
    "source-etag": "gcs-etag-1",
}


@pytest.fixture
def settings() -> Settings:
    # moto only intercepts AWS hostnames; a custom R2 endpoint would go out to the network.
    return load_settings().model_copy(update={"r2_endpoint_url": "https://s3.amazonaws.com"})


@pytest.fixture
def s3() -> Iterator[object]:
    """A raw moto-backed client with the bucket created, for seeding and inspecting."""
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket=BUCKET)
        yield client


@pytest.fixture
def store(s3: object, settings: Settings) -> R2Store:
    return R2Store(settings)


def _put(s3, key: str, body: bytes = b"x", metadata: dict[str, str] | None = None) -> None:
    s3.put_object(Bucket=BUCKET, Key=key, Body=body, Metadata=metadata or {})


def test_tape_key_format() -> None:
    assert tape_key(D1) == "fulltape/2026-10-26-fulltape.parquet"


def test_landed_reads_only_tape_keys(s3, store: R2Store) -> None:
    _put(s3, tape_key(D1))  # legacy: no metadata
    _put(s3, tape_key(D2), metadata=META)
    _put(s3, "gexbot-eod/SPX/2026-10-28.zip")
    _put(s3, "fulltape/_unavailable/2026-10-25.json")
    _put(s3, "fulltape/_superseded/2026-10-27-etag.parquet")
    _put(s3, "fulltape/notes.txt")

    assert store.landed() == {D1: {}, D2: META}


def test_landed_paginates_and_heads_each_day_once(s3, store: R2Store) -> None:
    days = [date(2026, 3, n) for n in range(1, 8)]
    for d in days:
        _put(s3, tape_key(d))
    real = store._client.get_paginator
    with (
        patch.object(
            store._client,
            "get_paginator",
            side_effect=lambda op: _small_pages(real(op)),
        ),
        patch.object(store._client, "head_object", wraps=store._client.head_object) as head,
    ):
        assert set(store.landed()) == set(days)
    assert head.call_count == len(days)


def _small_pages(paginator):
    class _P:
        def paginate(self, **kwargs):
            return paginator.paginate(PaginationConfig={"PageSize": 2}, **kwargs)

    return _P()


def test_landed_head_error_propagates(s3, store: R2Store) -> None:
    _put(s3, tape_key(D1))
    err = ClientError({"Error": {"Code": "500", "Message": "boom"}}, "HeadObject")
    with (
        patch.object(store._client, "head_object", side_effect=err),
        pytest.raises(ClientError),
    ):
        store.landed()


def test_put_tape_sets_metadata_and_verifies_size(s3, store: R2Store, tmp_path: Path) -> None:
    f = tmp_path / "t.parquet"
    f.write_bytes(b"p" * 1234)
    store.put_tape(f, D1, META)

    head = s3.head_object(Bucket=BUCKET, Key=tape_key(D1))
    assert head["ContentLength"] == 1234
    assert head["Metadata"] == META
    assert store.landed() == {D1: META}


def test_size_mismatch_raises(s3, store: R2Store, tmp_path: Path) -> None:
    f = tmp_path / "t.parquet"
    f.write_bytes(b"p" * 100)
    with (
        patch.object(store._client, "head_object", return_value={"ContentLength": 99}),
        pytest.raises(R2VerifyError),
    ):
        store.put_tape(f, D1, META)


def test_failed_upload_leaves_day_unlanded(s3, store: R2Store, tmp_path: Path) -> None:
    f = tmp_path / "t.parquet"
    f.write_bytes(b"p" * 100)
    with (
        patch.object(store._client, "upload_file", side_effect=OSError("connection reset")),
        pytest.raises(OSError),
    ):
        store.put_tape(f, D1, META)
    assert store.landed() == {}


def test_supersede_copies_old_object(s3, store: R2Store) -> None:
    _put(s3, tape_key(D1), body=b"old-body", metadata=META)

    key = store.supersede(D1, '"abc123"')

    assert key == "fulltape/_superseded/2026-10-26-abc123.parquet"
    copy = s3.get_object(Bucket=BUCKET, Key=key)
    assert copy["Body"].read() == b"old-body"
    assert copy["Metadata"] == META
    # the original is untouched, and the copy is not mistaken for a landed day
    assert set(store.landed()) == {D1}


def test_unavailable_round_trip(s3, store: R2Store) -> None:
    assert store.unavailable() == set()
    store.mark_unavailable(D1, "UW has not posted this day")
    store.mark_unavailable(D2, "404")
    _put(s3, "fulltape/_unavailable/junk.txt")
    _put(s3, tape_key(date(2026, 10, 20)))

    assert store.unavailable() == {D1, D2}
    assert store.landed() == {date(2026, 10, 20): {}}
    body = s3.get_object(Bucket=BUCKET, Key="fulltape/_unavailable/2026-10-26.json")["Body"].read()
    assert b"UW has not posted this day" in body
