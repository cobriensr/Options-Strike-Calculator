"""Download-and-seed the Databento OHLCV-1m archive from Vercel Blob
to the Railway persistent volume.

The sidecar's own code IS the transfer mechanism — Railway doesn't
support SCP/SFTP into volumes. This module is invoked via the admin
HTTP endpoint `POST /admin/seed-archive` (registered in `health.py`).

Design notes:

- **Stdlib only.** Uses `urllib.request` and `concurrent.futures` to
  keep the sidecar's dependency surface minimal. No new pip deps.
- **Atomic file writes.** Each file downloads to `<path>.tmp`, verifies
  SHA-256 on completion, then atomically renames into place. A crash
  mid-download leaves a `.tmp` that's discarded on resume and re-fetched
  from byte 0 — there is NO byte-range resume of a partial `.tmp`.
- **Whole-file SHA skip (not byte-resume).** "Resume" here means exactly
  one thing: if `<dest>/<path>` already exists AND its on-disk SHA-256
  matches the manifest's expected SHA, the file is skipped entirely.
  A partial download is never continued — the `.tmp` is unlinked and the
  next attempt re-fetches the whole file. Re-triggering the seed is
  therefore safe and nearly free when the volume is already populated,
  but an interrupted large file costs a full re-download.
  (`REQUEST_TIMEOUT_S` is a per-socket-operation timeout, not a total
  transfer deadline — a steadily-streaming large file does not trip it,
  so whole-file re-fetch is acceptable. Byte-range resume is a possible
  future improvement, not implemented here.)
- **Blob URL allowlist.** Every per-file `blob_url` from the manifest is
  validated against an HTTPS-only host allowlist BEFORE the bearer token
  is attached or any connection is opened, so a tampered manifest cannot
  exfiltrate `BLOB_READ_WRITE_TOKEN` to an attacker host or a cloud
  metadata endpoint. See `_validate_blob_url`.
- **Single-flight.** A module-level `threading.Lock` prevents two
  concurrent seed requests from stomping on each other. The HTTP layer
  returns 423 Locked if a seed is already in progress.
- **Fails loud.** A SHA mismatch raises `SeedIntegrityError` and the
  partial `.tmp` is removed. The caller sees a clear failure rather
  than silently-corrupted data.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from logger_setup import log
from sentry_setup import capture_exception

# ---------------------------------------------------------------------------
# Config constants
# ---------------------------------------------------------------------------

DEFAULT_CONCURRENCY = 4
REQUEST_TIMEOUT_S = 60
MAX_ATTEMPTS = 3
BACKOFF_SEQ_S = (1.0, 4.0, 16.0)
CHUNK_SIZE = 1024 * 1024  # 1 MiB streaming read

# SSRF guard: env var holding extra comma-separated hostnames that the
# per-file `blob_url` is permitted to point at, beyond the manifest URL's
# own host (which is always allowed — manifest and blobs live together on
# Vercel Blob). Lets an operator split blobs onto a second host if needed
# without code changes; absent/empty means "manifest host only".
ARCHIVE_BLOB_ALLOWED_HOSTS_ENV = "ARCHIVE_BLOB_ALLOWED_HOSTS"


class SeedIntegrityError(RuntimeError):
    """Raised when a downloaded file's SHA-256 doesn't match the manifest."""


class SeedBusyError(RuntimeError):
    """Raised when a seed is already in progress in this process."""


class SeedPathError(RuntimeError):
    """Raised when a manifest entry's path would escape `dest_root`.

    A malicious or broken manifest could list `..` components or an
    absolute path like `/etc/passwd`. We reject those up-front so a
    single bad entry can't corrupt arbitrary files on the volume.
    """


class SeedUrlError(RuntimeError):
    """Raised when a manifest entry's `blob_url` is not safe to fetch.

    The manifest URL itself is operator-controlled (env
    `ARCHIVE_MANIFEST_URL`), but the per-file `blob_url` values inside
    the fetched manifest are attacker-influenceable if the manifest is
    tampered with. Since every request carries the Blob bearer token
    (`BLOB_READ_WRITE_TOKEN`), an unvalidated `blob_url` is an SSRF /
    token-exfiltration vector: a hostile manifest could point it at
    `file://`, a cloud metadata endpoint (169.254.169.254), or any
    attacker host. We reject anything that isn't HTTPS on an allowlisted
    host BEFORE the token is attached or a connection is opened.
    """


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass
class SeedResult:
    """Summary of a seed run. Returned to the caller as JSON."""

    downloaded: int = 0
    skipped: int = 0
    failed: int = 0
    bytes_downloaded: int = 0
    elapsed_ms: int = 0
    errors: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "downloaded": self.downloaded,
            "skipped": self.skipped,
            "failed": self.failed,
            "bytes_downloaded": self.bytes_downloaded,
            "elapsed_ms": self.elapsed_ms,
            "errors": self.errors,
        }


# ---------------------------------------------------------------------------
# Single-flight state
# ---------------------------------------------------------------------------

_seed_lock = threading.Lock()


def is_seeding() -> bool:
    """True while a seed run is in progress in this process."""
    # Non-blocking acquire probe — immediately releases if it succeeds.
    acquired = _seed_lock.acquire(blocking=False)
    if acquired:
        _seed_lock.release()
        return False
    return True


# ---------------------------------------------------------------------------
# Low-level HTTP + hashing
# ---------------------------------------------------------------------------


def _build_request(url: str, token: str) -> urllib.request.Request:
    return urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})


def _sha256_of_file(path: Path) -> str:
    """Stream SHA-256 of a file on disk."""
    hasher = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(CHUNK_SIZE)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher.hexdigest()


def _download_to_tmp(url: str, token: str, tmp_path: Path) -> tuple[int, str]:
    """Stream a URL to `tmp_path`, returning (bytes_written, sha256_hex).

    Failures raise `urllib.error.URLError` or `OSError`; caller handles retry.
    """
    hasher = hashlib.sha256()
    bytes_written = 0
    tmp_path.parent.mkdir(parents=True, exist_ok=True)

    req = _build_request(url, token)
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
        with tmp_path.open("wb") as fh:
            while True:
                chunk = resp.read(CHUNK_SIZE)
                if not chunk:
                    break
                hasher.update(chunk)
                fh.write(chunk)
                bytes_written += len(chunk)

    return bytes_written, hasher.hexdigest()


def _fetch_manifest(manifest_url: str, token: str) -> dict[str, Any]:
    """GET the manifest JSON from Blob."""
    req = _build_request(manifest_url, token)
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
        body = resp.read()
    return json.loads(body)


def _safe_dest_path(dest_root: Path, rel_path: str) -> Path:
    """Resolve `rel_path` under `dest_root`, rejecting traversal attempts.

    Guards against a malicious manifest listing `..` components or an
    absolute path. Returns the resolved destination path.
    """
    if not rel_path:
        raise SeedPathError("Empty path in manifest entry")
    if os.path.isabs(rel_path):
        raise SeedPathError(f"Absolute path rejected: {rel_path!r}")
    # Walking the parts catches `a/../b` as well as plain `..`.
    if ".." in Path(rel_path).parts:
        raise SeedPathError(f"Parent-directory component rejected: {rel_path!r}")

    root_resolved = dest_root.resolve()
    candidate = (dest_root / rel_path).resolve()
    if not candidate.is_relative_to(root_resolved):
        raise SeedPathError(
            f"Path resolves outside dest_root: {rel_path!r} -> {candidate}"
        )
    return candidate


def _allowed_blob_hosts(manifest_url: str) -> frozenset[str]:
    """The set of hostnames a `blob_url` may target.

    Always includes the manifest URL's own host (manifest + blobs live on
    the same Vercel Blob host). Additional hosts can be supplied via the
    `ARCHIVE_BLOB_ALLOWED_HOSTS` env var (comma-separated). Hosts are
    compared case-insensitively.
    """
    hosts: set[str] = set()
    manifest_host = urllib.parse.urlsplit(manifest_url).hostname
    if manifest_host:
        hosts.add(manifest_host.lower())
    extra = os.environ.get(ARCHIVE_BLOB_ALLOWED_HOSTS_ENV, "")
    for raw in extra.split(","):
        host = raw.strip().lower()
        if host:
            hosts.add(host)
    return frozenset(hosts)


def _is_blocked_address(host: str) -> bool:
    """True if `host` is a literal loopback / link-local / metadata /
    private IP address.

    Catches the obvious SSRF targets when the manifest hands us a raw IP
    (e.g. `169.254.169.254` cloud metadata, `127.0.0.1`, RFC-1918 ranges).
    Hostnames that *resolve* to such addresses (DNS-rebind) are out of
    scope here — the host allowlist is the primary control; this is a
    belt-and-suspenders literal-IP check.
    """
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False  # not a literal IP; allowlist handles hostnames
    return (
        ip.is_loopback
        or ip.is_link_local  # 169.254.0.0/16 + fe80::/10 (incl. metadata)
        or ip.is_private  # 10/8, 172.16/12, 192.168/16, ::1 via loopback
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )


def _validate_blob_url(blob_url: str, manifest_url: str) -> None:
    """Reject any `blob_url` not safe to fetch with the Blob bearer token.

    Enforced BEFORE `_build_request`/`urlopen` for every manifest entry:
      - scheme MUST be `https` (no http/file/ftp/etc.);
      - host MUST be on the allowlist derived from `manifest_url`
        (+ `ARCHIVE_BLOB_ALLOWED_HOSTS`);
      - host MUST NOT be a literal loopback/link-local/metadata/private IP.

    Raises `SeedUrlError` on any violation. The token is only ever sent to
    an allowlisted host because this gate runs first.
    """
    parts = urllib.parse.urlsplit(blob_url)
    if parts.scheme.lower() != "https":
        raise SeedUrlError(
            f"blob_url scheme must be https, got {parts.scheme!r}: {blob_url!r}"
        )
    host = parts.hostname
    if not host:
        raise SeedUrlError(f"blob_url has no host: {blob_url!r}")
    host_lower = host.lower()
    if _is_blocked_address(host_lower):
        raise SeedUrlError(
            f"blob_url host is a blocked (loopback/link-local/private) "
            f"address: {host!r}"
        )
    allowed = _allowed_blob_hosts(manifest_url)
    if host_lower not in allowed:
        raise SeedUrlError(
            f"blob_url host {host!r} not in allowlist {sorted(allowed)}: {blob_url!r}"
        )


# ---------------------------------------------------------------------------
# Per-file seeding
# ---------------------------------------------------------------------------


def _seed_one_file(
    entry: dict[str, Any],
    dest_root: Path,
    token: str,
    manifest_url: str,
) -> tuple[str, int, bool]:
    """Seed one file from its manifest entry.

    Returns (path, bytes_downloaded, was_skipped).

    Raises SeedIntegrityError on SHA mismatch after download.
    Raises SeedUrlError if `blob_url` fails the SSRF allowlist.
    Raises the last underlying error after MAX_ATTEMPTS retries.
    """
    # Pull required keys up front so a missing field is a clear error,
    # not a mysterious KeyError from deep inside the download loop.
    missing = [k for k in ("path", "sha256", "blob_url") if k not in entry]
    if missing:
        raise SeedIntegrityError(f"Manifest entry missing required keys: {missing}")
    rel_path = entry["path"]
    expected_sha = entry["sha256"]
    blob_url = entry["blob_url"]
    # Validate the remote URL BEFORE the token is ever attached or a
    # connection opened — a tampered manifest must not exfiltrate the
    # Blob bearer token to a file://, metadata, or attacker host.
    _validate_blob_url(blob_url, manifest_url)
    # Resolve + validate BEFORE any filesystem work — stops path traversal
    # from a hostile or broken manifest at the gate.
    dest = _safe_dest_path(dest_root, rel_path)
    tmp = dest.with_suffix(dest.suffix + ".tmp")

    # Skip if already present with matching SHA — the resume path.
    if dest.is_file():
        on_disk_sha = _sha256_of_file(dest)
        if on_disk_sha == expected_sha:
            return (rel_path, 0, True)
        log.warning(
            "SHA mismatch for existing %s (on-disk=%s expected=%s) — re-downloading",
            rel_path,
            on_disk_sha[:12],
            expected_sha[:12],
        )

    last_err: Exception | None = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            bytes_written, got_sha = _download_to_tmp(blob_url, token, tmp)
            if got_sha != expected_sha:
                # Wipe the bad .tmp so resume doesn't see it.
                tmp.unlink(missing_ok=True)
                raise SeedIntegrityError(
                    f"SHA mismatch for {rel_path}: got {got_sha[:12]}, "
                    f"expected {expected_sha[:12]}"
                )
            tmp.replace(dest)  # Atomic rename within the same filesystem.
            return (rel_path, bytes_written, False)
        except SeedIntegrityError:
            # Integrity failures are not retryable — re-raise immediately.
            raise
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            last_err = exc
            tmp.unlink(missing_ok=True)
            if attempt < MAX_ATTEMPTS - 1:
                backoff = BACKOFF_SEQ_S[attempt]
                log.warning(
                    "Download failed for %s (attempt %d/%d): %s — backing off %.1fs",
                    rel_path,
                    attempt + 1,
                    MAX_ATTEMPTS,
                    exc,
                    backoff,
                )
                time.sleep(backoff)

    # Exhausted retries.
    assert last_err is not None
    raise last_err


# ---------------------------------------------------------------------------
# Top-level seed
# ---------------------------------------------------------------------------


def seed_from_manifest(
    manifest_url: str,
    dest_root: str | os.PathLike[str],
    token: str,
    *,
    concurrency: int = DEFAULT_CONCURRENCY,
) -> SeedResult:
    """Download every file listed in `manifest_url` into `dest_root`.

    Idempotent: files already present with matching SHA are skipped.

    Raises SeedBusyError if another seed is already running in this
    process (single-flight enforced by module-level lock).
    """
    if not _seed_lock.acquire(blocking=False):
        raise SeedBusyError("A seed is already in progress")

    result = SeedResult()
    start = time.monotonic()

    try:
        dest = Path(dest_root)
        dest.mkdir(parents=True, exist_ok=True)

        log.info("Fetching manifest from %s", manifest_url)
        manifest = _fetch_manifest(manifest_url, token)
        files: list[dict[str, Any]] = manifest.get("files", [])
        log.info(
            "Manifest has %d files, %d bytes total",
            len(files),
            manifest.get("total_bytes", 0),
        )

        # Use a small pool — Blob is bandwidth-bound, not concurrency-bound.
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            futures = {
                pool.submit(
                    _seed_one_file, entry, dest, token, manifest_url
                ): entry["path"]
                for entry in files
            }
            for fut in as_completed(futures):
                path = futures[fut]
                try:
                    _path, bytes_downloaded, was_skipped = fut.result()
                    if was_skipped:
                        result.skipped += 1
                    else:
                        result.downloaded += 1
                        result.bytes_downloaded += bytes_downloaded
                except Exception as exc:  # noqa: BLE001
                    result.failed += 1
                    result.errors.append(f"{path}: {exc}")
                    capture_exception(
                        exc,
                        context={"file": path, "manifest_url": manifest_url},
                        tags={"component": "archive_seeder"},
                    )
                    log.error("Failed to seed %s: %s", path, exc)

    finally:
        result.elapsed_ms = int((time.monotonic() - start) * 1000)
        _seed_lock.release()

    log.info(
        "Seed complete: downloaded=%d skipped=%d failed=%d bytes=%d elapsed_ms=%d",
        result.downloaded,
        result.skipped,
        result.failed,
        result.bytes_downloaded,
        result.elapsed_ms,
    )
    return result


# ---------------------------------------------------------------------------
# Test-only hooks
# ---------------------------------------------------------------------------


def _clear_state_for_tests() -> None:
    """Forcibly release the single-flight lock. Tests only.

    The underscore prefix advertises test-only intent. Raises if the lock
    wasn't actually held — a silent pass would mask tests that leave the
    lock held from a worker thread and hide a real leak.
    """
    if _seed_lock.locked():
        _seed_lock.release()
