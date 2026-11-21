"""The research store: reports, logs and derived state under `research/` in the R2 bucket.

The bucket also holds `fulltape/` (the landed tape, `r2_store.py`) and `gexbot-eod/`. This
module reads and writes `research/` only: every key or prefix is checked before any request,
and anything else raises ResearchKeyError, so a bad key can never reach a tape object.

Single-threaded by design, like `R2Store`: one boto3 client per store, built by
`r2_store.make_client`, and every transfer is a plain `put_object` / `get_object` stream. Never
`upload_file`, `download_file` or the `*_fileobj` and `copy` calls: they run a thread pool over
the one client, and a client shared across threads once sent half its R2 calls without TLS
verification (Windows workstation, 2026-10-28). urllib3 warns before it sends an unverified
request, so each store turns that warning into an error when it is built (`__init__`), which
stops one from going out. Importing the module changes no warning filter.

Logs carry the key, byte counts and seconds only: never a credential, the endpoint, a row of
data or the text of a report.
"""

from __future__ import annotations

import json
import logging
import time
import warnings
from collections.abc import Iterable, Mapping
from contextlib import closing
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Any

import urllib3
from botocore.exceptions import ClientError

from config import Settings
from r2_store import R2VerifyError, make_client, verify_upload_size

log = logging.getLogger(__name__)

RESEARCH_PREFIX = "research/"
CONTENT_TYPES: Mapping[str, str] = MappingProxyType(
    {
        ".md": "text/markdown; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
        ".log": "text/plain; charset=utf-8",
        ".csv": "text/csv; charset=utf-8",
        ".json": "application/json",
        ".png": "image/png",
        ".parquet": "application/vnd.apache.parquet",
    }
)
_FALLBACK_CONTENT_TYPE = "application/octet-stream"
_JSON_CONTENT_TYPE = CONTENT_TYPES[".json"]
_DOWNLOAD_CHUNK_BYTES = 8 * 2**20
_MISSING_CODES = frozenset({"NoSuchKey", "404"})


class ResearchKeyError(ValueError):
    """A key or prefix outside `research/`, or one that could climb out of it."""


def _check(key_or_prefix: str) -> None:
    """Refuse anything but a plain `research/...` key or prefix, before any request."""
    if (
        not key_or_prefix.startswith(RESEARCH_PREFIX)
        or ".." in key_or_prefix
        or "\\" in key_or_prefix
    ):
        raise ResearchKeyError(
            f"{key_or_prefix!r} is not a research key: it must start with "
            f"{RESEARCH_PREFIX!r} and contain no '..' and no backslash"
        )


def _content_type(key: str) -> str:
    return CONTENT_TYPES.get(PurePosixPath(key).suffix.lower(), _FALLBACK_CONTENT_TYPE)


def _is_missing(exc: ClientError) -> bool:
    return str(exc.response.get("Error", {}).get("Code")) in _MISSING_CODES


def _part_path(dest: Path) -> Path:
    return dest.with_name(dest.name + ".part")


class ResearchStore:
    """Reads and writes research outputs in the Full Tape bucket, under `research/` only."""

    def __init__(self, settings: Settings) -> None:
        # urllib3 warns before it sends, so an error here stops an unverified request
        # from going out. botocore wraps it as an HTTPClientError (see _is_tls_guard_error
        # in scripts/_tape_reader.py).
        warnings.filterwarnings("error", category=urllib3.exceptions.InsecureRequestWarning)
        self._bucket = settings.r2_bucket_fulltape
        self._client = make_client(settings)

    def _get(self, key: str) -> dict[str, Any] | None:
        """The `get_object` response, or None when the object does not exist.

        Only a missing key is None: an AccessDenied or a 5xx raises, so a store that
        cannot read is never mistaken for one that holds nothing.
        """
        try:
            return self._client.get_object(Bucket=self._bucket, Key=key)
        except ClientError as exc:
            if _is_missing(exc):
                return None
            raise

    def put_file(self, key: str, path: Path) -> int:
        """Upload a file as one `put_object` stream; returns its byte count.

        The object's ContentLength is checked against the file afterwards. A mismatch, or a
        HEAD that fails, deletes the key and raises R2VerifyError.
        """
        _check(key)
        started = time.monotonic()
        size = path.stat().st_size
        with path.open("rb") as body:
            self._client.put_object(
                Bucket=self._bucket,
                Key=key,
                Body=body,
                ContentLength=size,
                ContentType=_content_type(key),
            )
        verify_upload_size(self._client, self._bucket, key, size)
        log.info("research put %s bytes=%d seconds=%.1f", key, size, time.monotonic() - started)
        return size

    def get_file(self, key: str, dest: Path) -> bool:
        """Download an object to `dest`; False when the object does not exist.

        The body streams to `<dest>.part` and the byte count must equal the object's
        ContentLength before the file is renamed over `dest`. On any error the `.part` is
        removed and an existing `dest` is left as it was. A missing object creates nothing.
        """
        _check(key)
        started = time.monotonic()
        response = self._get(key)
        if response is None:
            return False
        written = 0
        # Closing covers everything from here, the mkdir too; only the `.part` is unlinked.
        with closing(response["Body"]) as body:
            expected = response["ContentLength"]
            part = _part_path(dest)
            dest.parent.mkdir(parents=True, exist_ok=True)
            try:
                with part.open("wb") as out:
                    for chunk in body.iter_chunks(_DOWNLOAD_CHUNK_BYTES):
                        out.write(chunk)
                        written += len(chunk)
                if written != expected:
                    raise R2VerifyError(
                        f"{key}: downloaded {written} bytes but R2 reports {expected}"
                    )
                part.replace(dest)
            except BaseException:
                part.unlink(missing_ok=True)
                raise
        log.info("research get %s bytes=%d seconds=%.1f", key, written, time.monotonic() - started)
        return True

    def put_json(self, key: str, obj: object) -> None:
        """Store `obj` as a JSON object.

        An object json cannot encode raises before any request: a TypeError for a type it
        does not know, a ValueError for a NaN or an infinity, which strict JSON has no form for.
        """
        _check(key)
        started = time.monotonic()
        data = json.dumps(obj, allow_nan=False).encode()
        self._client.put_object(
            Bucket=self._bucket, Key=key, Body=data, ContentType=_JSON_CONTENT_TYPE
        )
        log.info(
            "research put %s bytes=%d seconds=%.1f", key, len(data), time.monotonic() - started
        )

    def get_json(self, key: str) -> object | None:
        """The decoded JSON object, or None when it does not exist.

        A body that is not valid UTF-8 JSON raises ValueError naming the key (never the body).
        """
        _check(key)
        started = time.monotonic()
        response = self._get(key)
        if response is None:
            return None
        body = response["Body"]
        try:
            data = body.read()
        finally:
            body.close()
        try:
            obj = json.loads(data.decode("utf-8"))
        except ValueError as exc:  # JSONDecodeError and UnicodeDecodeError both land here
            raise ValueError(f"{key}: not valid JSON") from exc
        log.info(
            "research get %s bytes=%d seconds=%.1f", key, len(data), time.monotonic() - started
        )
        return obj

    def list(self, prefix: str) -> dict[str, int]:
        """Every key under `prefix` mapped to its size in bytes, across all pages."""
        _check(prefix)
        paginator = self._client.get_paginator("list_objects_v2")
        sizes: dict[str, int] = {}
        for page in paginator.paginate(Bucket=self._bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                sizes[obj["Key"]] = obj["Size"]
        return sizes

    def sync_down(
        self, prefix: str, dest_dir: Path, names: Iterable[str] | None = None
    ) -> list[Path]:
        """Download the objects under `prefix` into `dest_dir`; returns the paths, key-sorted.

        `prefix` names a folder: a missing trailing slash is added, so `research/a/b` never
        matches `research/a/b-old/`. Each object lands at its key's path below the prefix.
        `names` limits the download to those paths below the prefix (`a.md`, `sub/c.csv`); one
        that is not in R2 is left out of the result. Folder markers are skipped. A listed key
        that would land outside `dest_dir` or on another key's path (an empty or `.` segment)
        raises ResearchKeyError before anything is downloaded. An object deleted between the
        listing and its download is skipped.
        """
        _check(prefix)
        if not prefix.endswith("/"):
            prefix += "/"
        wanted = None if names is None else set(names)
        selected: list[tuple[str, Path]] = []
        for key in sorted(self.list(prefix)):
            relative = key[len(prefix) :]
            if not relative or relative.endswith("/"):  # the prefix's own marker, or a subfolder's
                continue
            if wanted is not None and relative not in wanted:
                continue
            segments = relative.split("/")
            if any(segment in ("", ".") for segment in segments):
                raise ResearchKeyError(f"{key!r} has an empty or '.' path segment")
            _check(key)
            selected.append((key, dest_dir.joinpath(*segments)))
        fetched: list[Path] = []
        for key, target in selected:
            if self.get_file(key, target):
                fetched.append(target)
            else:
                log.warning("research sync skipped %s: gone since the listing", key)
        return fetched
