"""Tests for the R2 research store.

moto answers every S3 call in-process: no real R2, no real credentials. Failure modes
(a failed upload, a short or broken download, a 403, a malformed JSON object) are
provoked at the boto3 client boundary or by seeding the moto bucket directly.
"""

from __future__ import annotations

import logging
import re
import runpy
import warnings
from collections.abc import Callable, Iterator
from pathlib import Path
from unittest.mock import patch

import boto3
import pytest
import urllib3
from botocore.exceptions import ClientError
from moto import mock_aws

import research_store
from config import Settings, load_settings
from r2_store import R2VerifyError
from research_store import CONTENT_TYPES, ResearchKeyError, ResearchStore

BUCKET = "test-bucket"
KEY = "research/reports/2026-11-20.md"
PAYLOAD = bytes(range(256)) * 40  # 10,240 bytes of non-text


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
def store(s3: object, settings: Settings) -> ResearchStore:
    return ResearchStore(settings)


def _put(s3, key: str, body: bytes = b"x") -> None:
    s3.put_object(Bucket=BUCKET, Key=key, Body=body)


def _keys(s3) -> list[str]:
    return [o["Key"] for o in s3.list_objects_v2(Bucket=BUCKET).get("Contents", [])]


def _file(tmp_path: Path, name: str = "in.md", body: bytes = PAYLOAD) -> Path:
    path = tmp_path / name
    path.write_bytes(body)
    return path


def _part(dest: Path) -> Path:
    return dest.with_name(dest.name + ".part")


class _Body:
    """The slice of botocore's StreamingBody that get_file reads, with a scripted ending."""

    def __init__(self, chunks: list[bytes], then_raise: Exception | None = None) -> None:
        self._chunks = chunks
        self._then_raise = then_raise
        self.closed = False

    def iter_chunks(self, chunk_size: int = 1024) -> Iterator[bytes]:
        yield from self._chunks
        if self._then_raise is not None:
            raise self._then_raise

    def read(self, amt: int | None = None) -> bytes:
        return b"".join(self._chunks)

    def close(self) -> None:
        self.closed = True


# --- keys ------------------------------------------------------------------------------

BAD_KEYS = [
    "fulltape/x",
    "gexbot-eod/x",
    "research/../fulltape/x",
    "research\\x",
    "research/sub\\x",  # starts right, so only the backslash rule refuses it
    "researchx/y",
    "research",
    "/research/x",
    "",
]

CALLS: dict[str, Callable[[ResearchStore, str, Path], object]] = {
    "put_file": lambda s, key, d: s.put_file(key, _file(d)),
    "get_file": lambda s, key, d: s.get_file(key, d / "out.md"),
    "put_json": lambda s, key, d: s.put_json(key, {"a": 1}),
    "get_json": lambda s, key, d: s.get_json(key),
    "list": lambda s, key, d: s.list(key),
    "sync_down": lambda s, key, d: s.sync_down(key, d / "dest"),
}


@pytest.mark.parametrize("key", BAD_KEYS)
@pytest.mark.parametrize("method", list(CALLS))
def test_keys_outside_research_are_refused(
    store: ResearchStore, tmp_path: Path, method: str, key: str
) -> None:
    # The refusal comes before any request: the client is never touched.
    with patch.object(store, "_client") as client, pytest.raises(ResearchKeyError):
        CALLS[method](store, key, tmp_path)
    assert client.mock_calls == []
    assert not (tmp_path / "out.md").exists()
    assert not (tmp_path / "dest").exists()


def test_research_key_error_is_a_value_error() -> None:
    assert issubclass(ResearchKeyError, ValueError)


def test_research_keys_and_prefixes_are_accepted(s3, store: ResearchStore, tmp_path: Path) -> None:
    assert store.list("research/") == {}
    assert store.put_file("research/a.md", _file(tmp_path)) == len(PAYLOAD)
    assert store.list("research/a") == {"research/a.md": len(PAYLOAD)}


# --- put_file / get_file -----------------------------------------------------------------

_MD = "text/markdown; charset=utf-8"
_TEXT = "text/plain; charset=utf-8"


def test_content_types_are_exactly_the_agreed_set() -> None:
    assert dict(CONTENT_TYPES) == {
        ".md": _MD,
        ".txt": _TEXT,
        ".log": _TEXT,
        ".csv": "text/csv; charset=utf-8",
        ".json": "application/json",
        ".png": "image/png",
        ".parquet": "application/vnd.apache.parquet",
    }


@pytest.mark.parametrize(
    ("name", "content_type"),
    [
        ("r.md", _MD),
        ("r.txt", _TEXT),
        ("r.log", _TEXT),
        ("r.csv", "text/csv; charset=utf-8"),
        ("r.json", "application/json"),
        ("r.png", "image/png"),
        ("r.parquet", "application/vnd.apache.parquet"),
        ("R.MD", _MD),  # the suffix is matched without case
        ("r.bin", "application/octet-stream"),  # a suffix outside the map
        ("README", "application/octet-stream"),
    ],
)
def test_put_file_round_trip_sets_content_type(
    s3, store: ResearchStore, tmp_path: Path, name: str, content_type: str
) -> None:
    key = f"research/reports/{name}"
    assert store.put_file(key, _file(tmp_path)) == len(PAYLOAD)

    head = s3.head_object(Bucket=BUCKET, Key=key)
    assert head["ContentType"] == content_type
    assert head["ContentLength"] == len(PAYLOAD)

    dest = tmp_path / "out" / name
    assert store.get_file(key, dest) is True
    assert dest.read_bytes() == PAYLOAD
    assert not _part(dest).exists()


def test_put_file_empty_file(s3, store: ResearchStore, tmp_path: Path) -> None:
    assert store.put_file(KEY, _file(tmp_path, body=b"")) == 0
    assert s3.head_object(Bucket=BUCKET, Key=KEY)["ContentLength"] == 0


def test_put_file_size_mismatch_deletes_and_raises(
    s3, store: ResearchStore, tmp_path: Path
) -> None:
    real_head = store._client.head_object
    with (
        patch.object(
            store._client,
            "head_object",
            side_effect=lambda **kw: {**real_head(**kw), "ContentLength": 99},
        ),
        pytest.raises(R2VerifyError, match="uploaded 10240 bytes but R2 reports 99"),
    ):
        store.put_file(KEY, _file(tmp_path))
    assert _keys(s3) == []


def test_put_file_head_failure_deletes_and_raises(s3, store: ResearchStore, tmp_path: Path) -> None:
    err = ClientError({"Error": {"Code": "500", "Message": "boom"}}, "HeadObject")
    with (
        patch.object(store._client, "head_object", side_effect=err),
        pytest.raises(R2VerifyError, match="could not verify"),
    ):
        store.put_file(KEY, _file(tmp_path))
    assert _keys(s3) == []


def test_put_file_upload_failure_propagates_and_stores_nothing(
    s3, store: ResearchStore, tmp_path: Path
) -> None:
    err = ClientError({"Error": {"Code": "AccessDenied", "Message": "no"}}, "PutObject")
    with (
        patch.object(store._client, "put_object", side_effect=err),
        patch.object(store._client, "head_object") as head,
        pytest.raises(ClientError) as info,
    ):
        store.put_file(KEY, _file(tmp_path))
    assert info.value.response["Error"]["Code"] == "AccessDenied"
    head.assert_not_called()
    assert _keys(s3) == []


def test_put_file_missing_source_raises_before_any_request(
    s3, store: ResearchStore, tmp_path: Path
) -> None:
    with pytest.raises(FileNotFoundError):
        store.put_file(KEY, tmp_path / "absent.md")
    assert _keys(s3) == []


def test_get_file_missing_returns_false_and_leaves_nothing(
    store: ResearchStore, tmp_path: Path
) -> None:
    dest = tmp_path / "out" / "deep" / "r.md"
    assert store.get_file(KEY, dest) is False
    assert list(tmp_path.rglob("*")) == []


def test_get_file_short_body_raises_and_leaves_no_part(
    s3, store: ResearchStore, tmp_path: Path
) -> None:
    dest = tmp_path / "r.md"
    dest.write_bytes(b"previous good copy")
    short = {"Body": _Body([b"abc"]), "ContentLength": 10}
    with (
        patch.object(store._client, "get_object", return_value=short),
        pytest.raises(R2VerifyError, match=r"downloaded 3 bytes but R2 reports 10"),
    ):
        store.get_file(KEY, dest)
    assert not _part(dest).exists()
    assert dest.read_bytes() == b"previous good copy"  # a failed fetch never replaces a good file


def test_get_file_long_body_raises_and_leaves_no_part(store: ResearchStore, tmp_path: Path) -> None:
    dest = tmp_path / "r.md"
    long = {"Body": _Body([b"abcdef"]), "ContentLength": 4}
    with (
        patch.object(store._client, "get_object", return_value=long),
        pytest.raises(R2VerifyError, match=r"downloaded 6 bytes but R2 reports 4"),
    ):
        store.get_file(KEY, dest)
    assert not dest.exists()
    assert not _part(dest).exists()


def test_get_file_stream_error_propagates_and_leaves_no_part(
    store: ResearchStore, tmp_path: Path
) -> None:
    dest = tmp_path / "r.md"
    broken = {
        "Body": _Body([b"abc"], then_raise=ConnectionResetError("reset")),
        "ContentLength": 10,
    }
    with (
        patch.object(store._client, "get_object", return_value=broken),
        pytest.raises(ConnectionResetError),
    ):
        store.get_file(KEY, dest)
    assert not dest.exists()
    assert not _part(dest).exists()


def test_get_file_closes_the_body_when_the_dest_dir_cannot_be_made(
    store: ResearchStore, tmp_path: Path
) -> None:
    body = _Body([b"abc"])
    response = {"Body": body, "ContentLength": 3}
    with (
        patch.object(store._client, "get_object", return_value=response),
        patch.object(Path, "mkdir", side_effect=PermissionError("denied")),
        pytest.raises(PermissionError, match="denied"),
    ):
        store.get_file(KEY, tmp_path / "out" / "r.md")
    assert body.closed is True
    assert list(tmp_path.rglob("*")) == []


@pytest.mark.parametrize(
    "failure",
    [
        pytest.param(None, id="success"),
        pytest.param(ConnectionResetError("reset"), id="stream-error"),
    ],
)
def test_get_file_closes_the_body_after_the_stream(
    store: ResearchStore, tmp_path: Path, failure: Exception | None
) -> None:
    body = _Body([b"abc"], then_raise=failure)
    response = {"Body": body, "ContentLength": 3}
    with patch.object(store._client, "get_object", return_value=response):
        if failure is None:
            assert store.get_file(KEY, tmp_path / "r.md") is True
        else:
            with pytest.raises(ConnectionResetError):
                store.get_file(KEY, tmp_path / "r.md")
    assert body.closed is True


def test_get_file_access_denied_is_not_reported_as_missing(
    store: ResearchStore, tmp_path: Path
) -> None:
    err = ClientError({"Error": {"Code": "AccessDenied", "Message": "no"}}, "GetObject")
    with patch.object(store._client, "get_object", side_effect=err), pytest.raises(ClientError):
        store.get_file(KEY, tmp_path / "r.md")
    assert list(tmp_path.rglob("*")) == []


def test_get_file_replaces_an_existing_file(s3, store: ResearchStore, tmp_path: Path) -> None:
    _put(s3, KEY, b"new")
    dest = tmp_path / "r.md"
    dest.write_bytes(b"old and longer")
    assert store.get_file(KEY, dest) is True
    assert dest.read_bytes() == b"new"
    assert not _part(dest).exists()


# --- put_json / get_json ----------------------------------------------------------------------


def test_json_round_trip_sets_content_type(s3, store: ResearchStore) -> None:
    key = "research/state/summary.json"
    obj = {"b": [1, 2.5, None], "a": "café"}
    store.put_json(key, obj)

    assert s3.head_object(Bucket=BUCKET, Key=key)["ContentType"] == "application/json"
    assert store.get_json(key) == obj


def test_get_json_missing_returns_none(store: ResearchStore) -> None:
    assert store.get_json("research/state/absent.json") is None


@pytest.mark.parametrize("body", [b"SECRET {not json", b"\xff\xfe\x00bad utf-8", b""])
def test_get_json_malformed_names_the_key(s3, store: ResearchStore, body: bytes) -> None:
    key = "research/state/bad.json"
    _put(s3, key, body)
    with pytest.raises(ValueError, match=re.escape(key)) as info:
        store.get_json(key)
    assert "SECRET" not in str(info.value)


def test_get_json_access_denied_is_not_reported_as_missing(store: ResearchStore) -> None:
    err = ClientError({"Error": {"Code": "AccessDenied", "Message": "no"}}, "GetObject")
    with patch.object(store._client, "get_object", side_effect=err), pytest.raises(ClientError):
        store.get_json("research/state/x.json")


def test_put_json_unserializable_stores_nothing(s3, store: ResearchStore) -> None:
    with pytest.raises(TypeError):
        store.put_json("research/state/x.json", {"x": object()})
    assert _keys(s3) == []


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_put_json_refuses_nan_and_infinity_before_any_request(
    s3, store: ResearchStore, bad: float
) -> None:
    """Python writes a bare NaN or Infinity, which no strict JSON reader accepts."""
    with (
        patch.object(store._client, "put_object") as put,
        pytest.raises(ValueError, match="Out of range float values are not JSON compliant"),
    ):
        store.put_json("research/state/x.json", {"stats": [1.5, bad]})
    put.assert_not_called()
    assert _keys(s3) == []


# --- list / sync_down ----------------------------------------------------------------------


def test_list_pages_past_1000(s3, store: ResearchStore) -> None:
    for i in range(1001):
        _put(s3, f"research/many/{i:04d}.json", b"x" * (i % 5 + 1))
    _put(s3, "fulltape/2026-10-26-fulltape.parquet")  # outside research/: never listed
    _put(s3, "research-other/x.json")  # a sibling prefix without the slash: never listed

    listing = store.list("research/")
    assert len(listing) == 1001
    assert listing["research/many/0000.json"] == 1
    assert listing["research/many/1000.json"] == 1  # the one past the first page
    assert listing["research/many/0003.json"] == 4
    assert len(store.list("research/many/00")) == 100  # a narrower prefix


def _seed_reports(s3) -> None:
    _put(s3, "research/reports/2026-11-20/a.md", b"alpha")
    _put(s3, "research/reports/2026-11-20/b.json", b"{}")
    _put(s3, "research/reports/2026-11-20/sub/c.csv", b"1,2\n")
    _put(s3, "research/reports/2026-11-20-old/d.md", b"stale")
    _put(s3, "research/other/e.md", b"elsewhere")


def test_sync_down_restricted_to_names(s3, store: ResearchStore, tmp_path: Path) -> None:
    _seed_reports(s3)
    dest = tmp_path / "dest"

    got = store.sync_down(
        "research/reports/2026-11-20/", dest, names=["a.md", "sub/c.csv", "never-uploaded.md"]
    )

    assert got == [dest / "a.md", dest / "sub" / "c.csv"]
    assert (dest / "a.md").read_bytes() == b"alpha"
    assert (dest / "sub" / "c.csv").read_bytes() == b"1,2\n"
    assert sorted(p.relative_to(dest).as_posix() for p in dest.rglob("*") if p.is_file()) == [
        "a.md",
        "sub/c.csv",
    ]


def test_sync_down_without_names_takes_the_whole_prefix(
    s3, store: ResearchStore, tmp_path: Path
) -> None:
    _seed_reports(s3)
    dest = tmp_path / "dest"

    got = store.sync_down("research/reports/2026-11-20/", dest)

    assert got == [dest / "a.md", dest / "b.json", dest / "sub" / "c.csv"]
    assert not list(dest.rglob("*.part"))


def test_sync_down_prefix_without_a_slash_does_not_match_siblings(
    s3, store: ResearchStore, tmp_path: Path
) -> None:
    _seed_reports(s3)
    dest = tmp_path / "dest"

    got = store.sync_down("research/reports/2026-11-20", dest)

    assert got == [
        dest / "a.md",
        dest / "b.json",
        dest / "sub" / "c.csv",
    ]  # not 2026-11-20-old/d.md


def test_sync_down_empty_names_downloads_nothing(s3, store: ResearchStore, tmp_path: Path) -> None:
    _seed_reports(s3)
    assert store.sync_down("research/reports/2026-11-20/", tmp_path / "dest", names=[]) == []


@pytest.mark.parametrize("bad", ["research/p//evil.md", "research/p/a\\b.md"])
def test_sync_down_refuses_a_key_that_could_leave_dest(
    s3, store: ResearchStore, tmp_path: Path, bad: str
) -> None:
    _put(s3, "research/p/-ok.md", b"ok")  # '-' sorts before both bad keys: it would go first
    _put(s3, bad, b"evil")
    dest = tmp_path / "dest"
    with pytest.raises(ResearchKeyError):
        store.sync_down("research/p/", dest)
    assert not dest.exists()  # refused up front: the good key was not downloaded either


def test_sync_down_skips_folder_markers(s3, store: ResearchStore, tmp_path: Path) -> None:
    _put(s3, "research/p/", b"")
    _put(s3, "research/p/sub/", b"")
    _put(s3, "research/p/ok.md", b"ok")
    dest = tmp_path / "dest"
    assert store.sync_down("research/p/", dest) == [dest / "ok.md"]


def test_sync_down_skips_an_object_deleted_after_the_listing(
    s3, store: ResearchStore, tmp_path: Path
) -> None:
    _put(s3, "research/p/a.md", b"a")
    _put(s3, "research/p/b.md", b"b")
    real_get = store._client.get_object

    def racing(**kwargs):
        if kwargs["Key"].endswith("a.md"):
            s3.delete_object(Bucket=BUCKET, Key=kwargs["Key"])
        return real_get(**kwargs)

    dest = tmp_path / "dest"
    with patch.object(store._client, "get_object", side_effect=racing):
        assert store.sync_down("research/p/", dest) == [dest / "b.md"]
    assert not (dest / "a.md").exists()


def test_sync_down_download_failure_propagates(s3, store: ResearchStore, tmp_path: Path) -> None:
    _put(s3, "research/p/a.md", b"a")
    err = ClientError({"Error": {"Code": "AccessDenied", "Message": "no"}}, "GetObject")
    with patch.object(store._client, "get_object", side_effect=err), pytest.raises(ClientError):
        store.sync_down("research/p/", tmp_path / "dest")


# --- transfer threads, TLS, logs ------------------------------------------------------------


def test_never_uses_transfer_threads(s3, store: ResearchStore, tmp_path: Path) -> None:
    """upload_file, download_file and their fileobj/copy cousins run a thread pool over one client."""
    boom = AssertionError("a threaded transfer was used")
    names = ("upload_file", "download_file", "upload_fileobj", "download_fileobj", "copy")
    patches = [patch.object(store._client, n, side_effect=boom) for n in names]
    for p in patches:
        p.start()
    try:
        store.put_file(KEY, _file(tmp_path))
        assert store.get_file(KEY, tmp_path / "out.md") is True
        store.put_json("research/state/x.json", {"a": 1})
        assert store.get_json("research/state/x.json") == {"a": 1}
        assert set(store.list("research/")) == {KEY, "research/state/x.json"}
        assert len(store.sync_down("research/", tmp_path / "dest")) == 2
    finally:
        for p in patches:
            p.stop()


def test_constructing_a_store_turns_the_unverified_tls_warning_into_an_error(
    settings: Settings,
) -> None:
    """The store installs the filter itself; pytest's own filters must not be what passes this."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # a baseline under which the warning would be dropped
        warnings.warn("before", urllib3.exceptions.InsecureRequestWarning, stacklevel=1)  # no raise
        ResearchStore(settings)
        with pytest.raises(urllib3.exceptions.InsecureRequestWarning):
            warnings.warn("probe", urllib3.exceptions.InsecureRequestWarning, stacklevel=1)


def test_importing_the_module_leaves_the_warning_filters_alone() -> None:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        baseline = list(warnings.filters)
        runpy.run_path(research_store.__file__)  # a fresh import: runs every module-level line
        assert warnings.filters == baseline
        warnings.warn("probe", urllib3.exceptions.InsecureRequestWarning, stacklevel=1)  # no raise


def test_logs_carry_key_bytes_and_seconds_only(
    s3, store: ResearchStore, settings: Settings, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    # Only this module's records are read: botocore's own DEBUG lines are not ours.
    caplog.set_level(logging.DEBUG, logger="research_store")
    store.put_file(KEY, _file(tmp_path))
    store.get_file(KEY, tmp_path / "out.md")
    store.put_json("research/state/x.json", {"secret_looking_field": "do-not-log-me"})
    store.get_json("research/state/x.json")
    store.list("research/")
    store.sync_down("research/", tmp_path / "dest")

    text = "\n".join(r.getMessage() for r in caplog.records if r.name == "research_store")
    assert KEY in text
    assert "research/state/x.json" in text
    assert "bytes" in text
    assert "seconds" in text
    for forbidden in (
        settings.r2_access_key_id.get_secret_value(),
        settings.r2_secret_access_key.get_secret_value(),
        settings.r2_endpoint_url,
        "do-not-log-me",
    ):
        assert forbidden not in text
