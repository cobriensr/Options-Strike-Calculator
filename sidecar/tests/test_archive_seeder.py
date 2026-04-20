"""Tests for archive_seeder — the Blob → Railway-volume transfer module.

We don't hit Vercel Blob in-process; instead we stub `urlopen` to return
in-memory fake responses. That exercises every real code path: manifest
parsing, per-file SHA verification, resume, retry/backoff, integrity
failure cleanup, and single-flight locking.
"""

from __future__ import annotations

import hashlib
import json
import sys
import threading
import urllib.error
from pathlib import Path
from typing import Iterator
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import archive_seeder  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures + helpers
# ---------------------------------------------------------------------------


def _sha(bytes_: bytes) -> str:
    return hashlib.sha256(bytes_).hexdigest()


class _FakeResp:
    """Minimal context-manager response shaped like `urlopen` output."""

    def __init__(self, body: bytes) -> None:
        self._body = body
        self._offset = 0

    def __enter__(self) -> "_FakeResp":
        return self

    def __exit__(self, *_exc: object) -> None:
        return None

    def read(self, size: int | None = None) -> bytes:
        if size is None:
            out, self._offset = self._body[self._offset :], len(self._body)
            return out
        out = self._body[self._offset : self._offset + size]
        self._offset += len(out)
        return out


def _make_manifest(files: list[tuple[str, bytes]]) -> dict[str, object]:
    """Build a manifest dict from a list of (path, content) pairs."""
    return {
        "schema": 1,
        "generated_at": "2026-04-18T00:00:00Z",
        "total_bytes": sum(len(c) for _, c in files),
        "file_count": len(files),
        "files": [
            {
                "path": p,
                "size": len(c),
                "sha256": _sha(c),
                "blob_url": f"https://blob.example/{p}",
                "content_type": "application/octet-stream",
            }
            for p, c in files
        ],
    }


def _urlopen_stub(
    manifest: dict[str, object],
    files: dict[str, bytes],
    *,
    transient_errors: dict[str, int] | None = None,
    corrupt_files: set[str] | None = None,
):
    """Build a urlopen fake that responds based on the requested URL.

    `transient_errors[path] = N` makes the first N requests for `path`
    raise URLError. `corrupt_files` contains paths whose body is
    returned with a single byte flipped (breaks SHA).
    """
    transient_errors = dict(transient_errors or {})
    corrupt_files = set(corrupt_files or set())
    manifest_url = "https://blob.example/manifest.json"

    def fake(req, *, timeout=None) -> _FakeResp:  # noqa: ARG001
        url = req.full_url if hasattr(req, "full_url") else req
        if url == manifest_url:
            return _FakeResp(json.dumps(manifest).encode())
        # Derive the file path from the URL prefix we used above.
        assert url.startswith("https://blob.example/")
        rel = url[len("https://blob.example/") :]
        if rel in transient_errors and transient_errors[rel] > 0:
            transient_errors[rel] -= 1
            raise urllib.error.URLError("simulated transient failure")
        body = files[rel]
        if rel in corrupt_files:
            # Flip the first byte — breaks SHA but preserves length.
            body = bytes([body[0] ^ 0xFF]) + body[1:]
        return _FakeResp(body)

    return fake, manifest_url


@pytest.fixture(autouse=True)
def _release_seed_lock() -> Iterator[None]:
    """Make sure one test's lock doesn't leak into the next."""
    yield
    archive_seeder._clear_state_for_tests()


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_seed_downloads_all_files_and_verifies_sha(tmp_path: Path) -> None:
    files = {
        "ohlcv_1m/year=2020/part.parquet": b"hello-2020-bars",
        "ohlcv_1m/year=2021/part.parquet": b"hello-2021-bars",
        "symbology.parquet": b"symbology-bytes",
    }
    manifest = _make_manifest(list(files.items()))
    fake, manifest_url = _urlopen_stub(manifest, files)

    with patch.object(archive_seeder.urllib.request, "urlopen", fake):
        result = archive_seeder.seed_from_manifest(
            manifest_url, tmp_path, token="test-token", concurrency=2
        )

    assert result.downloaded == 3
    assert result.skipped == 0
    assert result.failed == 0
    assert result.bytes_downloaded == sum(len(b) for b in files.values())
    for rel, body in files.items():
        assert (tmp_path / rel).read_bytes() == body


# ---------------------------------------------------------------------------
# Resume — idempotent re-seed
# ---------------------------------------------------------------------------


def test_seed_skips_files_already_present_with_matching_sha(
    tmp_path: Path,
) -> None:
    files = {
        "a.parquet": b"payload-a",
        "b.parquet": b"payload-b",
    }
    manifest = _make_manifest(list(files.items()))

    # Pre-populate the destination with matching content.
    for rel, body in files.items():
        target = tmp_path / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)

    fake, manifest_url = _urlopen_stub(manifest, files)
    with patch.object(archive_seeder.urllib.request, "urlopen", fake):
        result = archive_seeder.seed_from_manifest(
            manifest_url, tmp_path, token="test-token"
        )

    assert result.downloaded == 0
    assert result.skipped == 2
    assert result.failed == 0
    assert result.bytes_downloaded == 0


# ---------------------------------------------------------------------------
# Integrity — SHA mismatch
# ---------------------------------------------------------------------------


def test_sha_mismatch_is_recorded_as_failure_and_leaves_no_tmp(
    tmp_path: Path,
) -> None:
    files = {"bad.parquet": b"valid-bytes"}
    manifest = _make_manifest(list(files.items()))
    fake, manifest_url = _urlopen_stub(manifest, files, corrupt_files={"bad.parquet"})

    with patch.object(archive_seeder.urllib.request, "urlopen", fake):
        result = archive_seeder.seed_from_manifest(
            manifest_url, tmp_path, token="test-token"
        )

    assert result.downloaded == 0
    assert result.failed == 1
    assert "SHA mismatch" in result.errors[0]
    # No .tmp file left behind.
    leftovers = list(tmp_path.rglob("*.tmp"))
    assert leftovers == []
    # No partial dest file either.
    assert not (tmp_path / "bad.parquet").exists()


# ---------------------------------------------------------------------------
# Retry + backoff
# ---------------------------------------------------------------------------


def test_transient_errors_retry_and_succeed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two transient failures then success — should still download."""
    files = {"flaky.parquet": b"eventual-success"}
    manifest = _make_manifest(list(files.items()))
    fake, manifest_url = _urlopen_stub(
        manifest, files, transient_errors={"flaky.parquet": 2}
    )

    # Skip real sleep to keep tests fast.
    monkeypatch.setattr(archive_seeder.time, "sleep", lambda _s: None)

    with patch.object(archive_seeder.urllib.request, "urlopen", fake):
        result = archive_seeder.seed_from_manifest(
            manifest_url, tmp_path, token="test-token"
        )

    assert result.downloaded == 1
    assert result.failed == 0


def test_exhausted_retries_become_a_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    files = {"always-fails.parquet": b"doesnt-matter"}
    manifest = _make_manifest(list(files.items()))
    # More transient errors than MAX_ATTEMPTS — guarantees total failure.
    fake, manifest_url = _urlopen_stub(
        manifest,
        files,
        transient_errors={"always-fails.parquet": archive_seeder.MAX_ATTEMPTS + 1},
    )

    monkeypatch.setattr(archive_seeder.time, "sleep", lambda _s: None)

    with patch.object(archive_seeder.urllib.request, "urlopen", fake):
        result = archive_seeder.seed_from_manifest(
            manifest_url, tmp_path, token="test-token"
        )

    assert result.failed == 1
    assert result.downloaded == 0


# ---------------------------------------------------------------------------
# Single-flight lock
# ---------------------------------------------------------------------------


def test_concurrent_seed_raises_busy_error(tmp_path: Path) -> None:
    """While one seed holds the lock, a second call raises SeedBusyError."""
    files = {"slow.parquet": b"slow-bytes"}
    manifest = _make_manifest(list(files.items()))

    # Gate the first seed inside its ThreadPoolExecutor so we can observe
    # the lock being held from the test thread.
    started = threading.Event()
    release = threading.Event()

    def slow_fake(req, *, timeout=None):  # noqa: ARG001
        url = req.full_url if hasattr(req, "full_url") else req
        if url.endswith("/manifest.json"):
            return _FakeResp(json.dumps(manifest).encode())
        started.set()
        release.wait(timeout=5)
        return _FakeResp(files["slow.parquet"])

    def run_first() -> None:
        with patch.object(archive_seeder.urllib.request, "urlopen", slow_fake):
            archive_seeder.seed_from_manifest(
                "https://blob.example/manifest.json",
                tmp_path,
                token="test-token",
            )

    t = threading.Thread(target=run_first, daemon=True)
    t.start()
    # Wait until the first seed is actively holding the lock.
    assert started.wait(timeout=5), "first seed never started"
    assert archive_seeder.is_seeding() is True

    with pytest.raises(archive_seeder.SeedBusyError):
        archive_seeder.seed_from_manifest(
            "https://blob.example/manifest.json", tmp_path, token="test-token"
        )

    # Let the first seed finish so the test thread doesn't leak.
    release.set()
    t.join(timeout=5)
    # And confirm the lock was released properly afterwards.
    assert archive_seeder.is_seeding() is False


# ---------------------------------------------------------------------------
# Path traversal — malicious or broken manifest
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "malicious_path",
    [
        "../escape.parquet",
        "a/../../etc/passwd",
        "/etc/passwd",  # absolute
        "",  # empty
    ],
)
def test_path_traversal_is_rejected(tmp_path: Path, malicious_path: str) -> None:
    """A hostile or broken manifest can't write outside dest_root."""
    files = {malicious_path: b"pwn"} if malicious_path else {"": b"pwn"}
    manifest = {
        "schema": 1,
        "files": [
            {
                "path": malicious_path,
                "size": 3,
                "sha256": _sha(b"pwn"),
                "blob_url": "https://blob.example/attack",
                "content_type": "application/octet-stream",
            }
        ],
    }

    # The request should never reach urlopen — path validation is
    # the first thing `_seed_one_file` does. We still provide a stub
    # so an accidental download would be obvious.
    fake, manifest_url = _urlopen_stub(manifest, files)

    with patch.object(archive_seeder.urllib.request, "urlopen", fake):
        result = archive_seeder.seed_from_manifest(
            manifest_url, tmp_path, token="test-token"
        )

    assert result.failed == 1
    assert result.downloaded == 0
    # And — critically — no files were written anywhere. Even a .tmp
    # outside dest_root would indicate the guard didn't hold.
    unexpected = list(tmp_path.rglob("*"))
    assert unexpected == [], f"unexpected writes to dest_root: {unexpected}"


# ---------------------------------------------------------------------------
# Manifest-shape failures
# ---------------------------------------------------------------------------


def test_malformed_manifest_json_raises(tmp_path: Path) -> None:
    """If the manifest body isn't valid JSON, the seed aborts cleanly."""

    def bad_json_urlopen(_req, *, timeout=None):  # noqa: ARG001
        return _FakeResp(b"this is not json {")

    with (
        patch.object(archive_seeder.urllib.request, "urlopen", bad_json_urlopen),
        pytest.raises(json.JSONDecodeError),
    ):
        archive_seeder.seed_from_manifest(
            "https://blob.example/manifest.json", tmp_path, token="t"
        )
    # And the lock must be released even on manifest-parse failure.
    assert archive_seeder.is_seeding() is False


def test_manifest_entry_missing_sha_is_recorded_as_failure(
    tmp_path: Path,
) -> None:
    """Manifest with an entry missing 'sha256' fails that file, not the run."""
    manifest = {
        "schema": 1,
        "files": [
            {
                "path": "a.parquet",
                "size": 4,
                "blob_url": "https://blob.example/a.parquet",
            },
        ],
    }

    def stub(_req, *, timeout=None):  # noqa: ARG001
        return _FakeResp(json.dumps(manifest).encode())

    with patch.object(archive_seeder.urllib.request, "urlopen", stub):
        result = archive_seeder.seed_from_manifest(
            "https://blob.example/manifest.json", tmp_path, token="t"
        )

    assert result.failed == 1
    assert "missing required keys" in result.errors[0]


def test_empty_manifest_is_a_successful_no_op(tmp_path: Path) -> None:
    manifest = {"schema": 1, "files": []}

    def stub(_req, *, timeout=None):  # noqa: ARG001
        return _FakeResp(json.dumps(manifest).encode())

    with patch.object(archive_seeder.urllib.request, "urlopen", stub):
        result = archive_seeder.seed_from_manifest(
            "https://blob.example/manifest.json", tmp_path, token="t"
        )

    assert result.downloaded == 0
    assert result.skipped == 0
    assert result.failed == 0
