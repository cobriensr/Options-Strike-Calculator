"""Tests for the R2 tape store.

moto answers every S3 call in-process: no real R2, no real credentials. Failure
modes (size mismatch, failed upload, head_object errors, paged listings) are patched or
provoked at the boto3 client boundary.
"""

from __future__ import annotations

import hashlib
import socket
from collections.abc import Iterator
from datetime import date
from pathlib import Path
from unittest.mock import patch

import boto3
import pytest
from boto3.exceptions import S3UploadFailedError
from botocore.exceptions import ClientError
from moto import mock_aws

from config import Settings, load_settings
from r2_store import R2Store, R2VerifyError, make_client, tape_key
from research_store import ResearchStore

BUCKET = "test-bucket"
D1 = date(2026, 10, 26)
D2 = date(2026, 10, 27)
META = {
    "rows": "3",
    "sha256": "abc",
    "schema-version": "nightly-1",
    "source-etag": "gcs-etag-1",
}


@pytest.fixture(autouse=True)
def _isolated_home(
    tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """boto3 reads ~/.aws and may cache under the home dir; keep it off the real one."""
    home = tmp_path_factory.mktemp("home")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))


@pytest.fixture
def settings() -> Settings:
    # moto only intercepts AWS hostnames; a custom R2 endpoint would go out to the network.
    return load_settings().model_copy(
        update={"r2_endpoint_url": "https://s3.amazonaws.com", "r2_bucket_fulltape": BUCKET}
    )


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


def _file(tmp_path: Path, size: int = 100) -> Path:
    f = tmp_path / "t.parquet"
    f.write_bytes(b"p" * size)
    return f


def _key_exists(s3, key: str) -> bool:
    return any(o["Key"] == key for o in s3.list_objects_v2(Bucket=BUCKET).get("Contents", []))


def test_size_mismatch_deletes_and_raises(s3, store: R2Store, tmp_path: Path) -> None:
    real_head = store._client.head_object
    with (
        patch.object(
            store._client,
            "head_object",
            side_effect=lambda **kw: {**real_head(**kw), "ContentLength": 99},
        ),
        pytest.raises(R2VerifyError, match="uploaded 100 bytes but R2 reports 99"),
    ):
        store.put_tape(_file(tmp_path), D1, META)
    assert not _key_exists(s3, tape_key(D1))
    assert store.landed() == {}


def test_head_failure_after_upload_deletes_and_raises(s3, store: R2Store, tmp_path: Path) -> None:
    err = ClientError({"Error": {"Code": "500", "Message": "boom"}}, "HeadObject")
    with (
        patch.object(store._client, "head_object", side_effect=err),
        pytest.raises(R2VerifyError, match="could not verify"),
    ):
        store.put_tape(_file(tmp_path), D1, META)
    assert not _key_exists(s3, tape_key(D1))


def test_cleanup_delete_failure_still_raises(s3, store: R2Store, tmp_path: Path) -> None:
    del_err = ClientError({"Error": {"Code": "500", "Message": "boom"}}, "DeleteObject")
    with (
        patch.object(store._client, "head_object", return_value={"ContentLength": 1}),
        patch.object(store._client, "delete_object", side_effect=del_err),
        pytest.raises(R2VerifyError, match="may remain"),
    ):
        store.put_tape(_file(tmp_path), D1, META)


def test_failed_part_upload_leaves_day_unlanded(
    s3, settings: Settings, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("r2_store._MULTIPART_THRESHOLD", 5 * 2**20)
    store = R2Store(settings)
    err = ClientError({"Error": {"Code": "500", "Message": "boom"}}, "UploadPart")
    with (
        patch.object(store._client, "upload_part", side_effect=err),
        pytest.raises(S3UploadFailedError),
    ):
        store.put_tape(_file(tmp_path, 12 * 2**20), D1, META)
    assert store.landed() == {}
    assert s3.list_multipart_uploads(Bucket=BUCKET).get("Uploads", []) == []


def test_multipart_upload_round_trips(
    s3, settings: Settings, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("r2_store._MULTIPART_THRESHOLD", 5 * 2**20)
    store = R2Store(settings)
    store.put_tape(_file(tmp_path, 12 * 2**20), D1, META)
    head = s3.head_object(Bucket=BUCKET, Key=tape_key(D1))
    assert head["ContentLength"] == 12 * 2**20
    assert head["Metadata"] == META


def test_non_ascii_metadata_rejected_before_upload(s3, store: R2Store, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="'sha256'") as info:
        store.put_tape(_file(tmp_path), D1, {"sha256": "café"})
    assert "caf" not in str(info.value)
    assert not _key_exists(s3, tape_key(D1))


def test_malformed_keys_are_ignored(s3, store: R2Store) -> None:
    _put(s3, tape_key(D1))
    _put(s3, "fulltape/2026-02-30-fulltape.parquet")
    _put(s3, "fulltape/2026-13-45-fulltape.parquet")
    _put(s3, "fulltape/٢٠٢٦-10-26-fulltape.parquet")
    _put(s3, "fulltape/2026-10-27-fulltape.parquet.bak")
    _put(s3, "fulltape/2026-10-27-fulltape.parquet\n")
    _put(s3, "fulltape/_unavailable/2026-10-27.json")
    _put(s3, "fulltape/_unavailable/2026-10-27.json.bak")
    _put(s3, "fulltape/_unavailable/2026-02-30.json")
    _put(s3, "fulltape/_unavailable/2026-13-45.json")
    assert store.landed() == {D1: {}}
    assert store.unavailable() == {date(2026, 10, 27)}


def test_slash_in_etag_is_sanitized(s3, store: R2Store) -> None:
    _put(s3, tape_key(D1), body=b"old")
    key = store.supersede(D1, '"ab/c+d=="')
    assert key == "fulltape/_superseded/2026-10-26-ab_c_d__.parquet"
    assert s3.get_object(Bucket=BUCKET, Key=key)["Body"].read() == b"old"


def test_supersede_missing_source_raises(s3, store: R2Store) -> None:
    with pytest.raises(ClientError) as info:
        store.supersede(D1, "etag")
    assert info.value.response["Error"]["Code"] == "NoSuchKey"


def test_network_guard_blocks_real_connections() -> None:
    with pytest.raises(RuntimeError, match="real network connection"), socket.socket() as sock:
        sock.connect(("93.184.216.34", 443))


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


def test_transfers_are_single_threaded(store: R2Store) -> None:
    assert store._transfer.use_threads is False
    assert store._transfer.preferred_transfer_client == "classic"


def _md5(body: bytes) -> str:
    return hashlib.md5(body, usedforsecurity=False).hexdigest()


def test_tape_etags_lists_only_tape_keys(s3, store: R2Store) -> None:
    _put(s3, tape_key(D1), body=b"one")
    _put(s3, tape_key(D2), body=b"two", metadata=META)
    _put(s3, "gexbot-eod/SPX/2026-10-28.zip")
    _put(s3, "fulltape/_unavailable/2026-10-25.json")
    _put(s3, "fulltape/_superseded/2026-10-27-etag.parquet")
    _put(s3, "fulltape/notes.txt")
    _put(s3, "fulltape/2026-02-30-fulltape.parquet")  # an impossible date
    _put(s3, "fulltape/2026-10-28-fulltape.parquet.bak")  # starts like a tape key, is not one
    _put(s3, "fulltape/2026-10-29-notes.txt")

    with (
        patch.object(store._client, "head_object", wraps=store._client.head_object) as head,
        patch.object(
            store._client, "list_objects_v2", wraps=store._client.list_objects_v2
        ) as listing,
    ):
        etags = store.tape_etags()

    # S3 hands back a single-part ETag as the body's MD5 in quotes; the quotes are gone.
    assert etags == {D1: _md5(b"one"), D2: _md5(b"two")}
    assert all('"' not in etag for etag in etags.values())
    assert head.call_count == 0
    assert listing.call_count == 1


def test_tape_etags_empty_bucket(s3, store: R2Store) -> None:
    assert store.tape_etags() == {}


def test_tape_etags_reads_every_page(s3, store: R2Store) -> None:
    days = [date(2026, 3, n) for n in range(1, 8)]
    for d in days:
        _put(s3, tape_key(d), body=d.isoformat().encode())
    real = store._client.get_paginator
    with patch.object(
        store._client, "get_paginator", side_effect=lambda op: _small_pages(real(op))
    ):
        assert store.tape_etags() == {d: _md5(d.isoformat().encode()) for d in days}


def test_tape_etags_list_error_propagates(s3, store: R2Store) -> None:
    err = ClientError({"Error": {"Code": "500", "Message": "boom"}}, "ListObjectsV2")
    with (
        patch.object(store._client, "list_objects_v2", side_effect=err),
        pytest.raises(ClientError),
    ):
        store.tape_etags()


def test_make_client_config(settings: Settings) -> None:
    """One client config for both stores: TLS verified, s3v4 signing, 5 attempts."""
    with patch("r2_store.boto3.client") as client:
        make_client(settings)
        R2Store(settings)
        ResearchStore(settings)

    assert client.call_count == 3
    for call in client.call_args_list:
        assert call.args == ("s3",)
        assert call.kwargs["verify"] is True
        assert call.kwargs["region_name"] == "auto"
        assert call.kwargs["endpoint_url"] == settings.r2_endpoint_url
        assert call.kwargs["aws_access_key_id"] == settings.r2_access_key_id.get_secret_value()
        assert (
            call.kwargs["aws_secret_access_key"] == settings.r2_secret_access_key.get_secret_value()
        )
        config = call.kwargs["config"]
        assert config.signature_version == "s3v4"
        assert config.retries == {"mode": "standard", "max_attempts": 5}


def test_make_client_builds_a_working_client(s3, settings: Settings) -> None:
    client = make_client(settings)
    assert client.meta.region_name == "auto"
    assert client.meta.config.signature_version == "s3v4"
    assert client.list_objects_v2(Bucket=BUCKET)["KeyCount"] == 0
