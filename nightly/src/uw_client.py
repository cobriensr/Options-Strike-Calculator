"""Download one day of the Unusual Whales options Full Tape, or probe its identity.

The HTTP handling (headers, zip sniff, ``parse_boundary``, ``classify_403``, the
status mapping) is adapted from Unusual Whales' ``uw-options-data-lake`` skill,
https://unusualwhales.com/skills/uw-options-data-lake-skill.md, fetched 2026-10-28,
sha256 a99ecce6361a295d7ded72e804e9ec77e4fbec94cdace1c0b24c02551596f8bb
(script lines 772-980). No license is stated; vendored by owner decision 2026-10-28.

Fixes from the 2026-10-28 review of that code:
- (b2) Retries with backoff. Each attempt asks UW again, so it gets a fresh signed URL.
- (b3) A wall-clock deadline checked on every chunk, since httpx's timeout is per read.
- (b4) A non-zip body is sniffed (at most SNIFF_MAX_BYTES) and never echoed: errors
  carry status codes, header values and exception class names, never body text.
- (b5) A 404 from UW or from the GCS redirect target is ``not_posted``, not a skip.
- (b7) httpx errors and OSError are caught and typed.
- The body lands in ``<dest>.part``, its size is checked against Content-Length, and
  only then is it renamed to ``dest``. The ``.part`` file never survives a failure.

Endpoint behavior (probed 2026-10-28): UW answers 302 to a signed
storage.googleapis.com URL. An unposted day is 302 then a GCS 404. A day older than
the plan's window is a 403 whose JSON ``code`` is ``historic_data_access_missing``.
httpx drops ``Authorization`` on the cross-origin hop, which is what we want.
"""

from __future__ import annotations

import random
import re
import time
from collections.abc import Callable, Mapping
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import date
from itertools import chain
from pathlib import Path
from typing import Literal

import httpx

from constants import DOWNLOAD_DEADLINE_SECONDS, DOWNLOAD_MAX_ATTEMPTS, SNIFF_MAX_BYTES, USER_AGENT

HISTORIC_CODE = "historic_data_access_missing"

Kind = Literal[
    "not_posted",
    "outside_window",
    "auth",
    "quota_daily",
    "transient",
    "corrupt",
    "timeout",
    "unexpected",
]


class TapeDownloadError(Exception):
    """A download or probe that did not produce the day's tape.

    ``detail`` is built from status codes, header values, parsed dates and exception
    class names only, so it is safe for logs and Sentry.
    """

    def __init__(self, kind: Kind, day: date, detail: str) -> None:
        super().__init__(kind, day, detail)
        self.kind = kind
        self.day = day
        self.detail = detail

    def __str__(self) -> str:
        return f"{self.kind} {self.day.isoformat()}: {self.detail}"


@dataclass(frozen=True)
class SourceInfo:
    """Identity of the upstream file, from the final (post-redirect) response."""

    etag: str | None
    last_modified: str | None
    bytes: int


class _RetryableError(Exception):
    """An attempt failed in a way a fresh request may fix.

    ``kind`` is reported if attempts run out; ``delay`` is a server-requested wait.
    """

    def __init__(self, kind: Kind, detail: str, delay: float | None = None) -> None:
        super().__init__(detail)
        self.kind = kind
        self.detail = detail
        self.delay = delay


def build_headers(api_key: str) -> dict[str, str]:
    """Request headers. UW 403s a Python-urllib User-Agent, so always send ours."""
    return {
        "Authorization": f"Bearer {api_key}",
        # The zip comes under an octet-stream-ish type; a narrow Accept draws a 406.
        "Accept": "*/*",
        "User-Agent": USER_AGENT,
        "UW-CLIENT-API-ID": "100003",  # UW usage attribution, as the source script sends it
    }


def parse_boundary(message: str) -> tuple[date | None, int | None]:
    """Pull the caller's earliest available date and trading-day lookback out of a
    `historic_data_access_missing` message. Either may be None if the wording moved."""
    earliest: date | None = None
    m = re.search(r"(\d{4}-\d{2}-\d{2})", message)
    if m:
        try:
            earliest = date.fromisoformat(m.group(1))
        except ValueError:
            earliest = None
    lookback: int | None = None
    m = re.search(r"(\d+)\s+trading\s+days", message)
    if m:
        lookback = int(m.group(1))
    return earliest, lookback


def classify_403(body: str, headers: Mapping[str, str]) -> str:
    """Which of four mutually-exclusive 403s this is. The historic-window boundary
    is checked FIRST: it is a legitimate entitlement response, not a failure, and
    only a real UW body carries its `code`."""
    low = body.lower()
    if HISTORIC_CODE in low:
        return "historic_boundary"
    deny = headers.get("x-deny-reason", "")
    if deny == "host_not_allowed" or any(
        s in low for s in ("not in allowlist", "egress", "host_not_allowed")
    ):
        return "egress"
    if any(s in low for s in ("cloudflare", "1010", "access denied", "bot", "browser integrity")):
        return "cloudflare"
    return "auth"


def download_tape(day: date, dest: Path, api_key: str) -> SourceInfo:
    """Stream `day`'s tape zip to `dest` and return the final response's identity.

    Raises TapeDownloadError on every failure; `dest` exists only on success.
    """
    deadline = time.monotonic() + DOWNLOAD_DEADLINE_SECONDS
    return _with_retries(day, lambda: _download_once(day, dest, api_key, deadline))


def probe_source(day: date, api_key: str) -> SourceInfo:
    """Return `day`'s source identity from the response headers, reading no body.

    Non-200 responses raise TapeDownloadError, classified as in download_tape.
    """
    return _with_retries(day, lambda: _probe_once(day, api_key))


def _with_retries[T](day: date, attempt: Callable[[], T]) -> T:
    """Run `attempt` up to DOWNLOAD_MAX_ATTEMPTS times, typing every failure."""
    n = 1
    while True:
        try:
            return attempt()
        except httpx.TransportError as exc:
            failure = _RetryableError("transient", type(exc).__name__)
        except _RetryableError as exc:
            failure = exc
        except httpx.HTTPError as exc:
            raise TapeDownloadError("unexpected", day, type(exc).__name__) from None
        except OSError as exc:
            raise TapeDownloadError(
                "unexpected", day, f"{type(exc).__name__} errno {exc.errno}"
            ) from None
        if n == DOWNLOAD_MAX_ATTEMPTS:
            raise TapeDownloadError(failure.kind, day, f"{failure.detail} after {n} attempts")
        delay = failure.delay
        if delay is None:
            delay = min(120, 5 * 2 ** (n - 1)) + random.uniform(0, 3)
        time.sleep(delay)
        n += 1


def _open(day: date, api_key: str) -> AbstractContextManager[httpx.Response]:
    return httpx.stream(
        "GET",
        f"https://api.unusualwhales.com/api/option-trades/full-tape/{day.isoformat()}",
        headers=build_headers(api_key),
        # Bounds each connect and read; the wall clock is DOWNLOAD_DEADLINE_SECONDS.
        timeout=60.0,
        follow_redirects=True,
    )


def _download_once(day: date, dest: Path, api_key: str, deadline: float) -> SourceInfo:
    _check_deadline(day, deadline, 0)
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    try:
        with _open(day, api_key) as response:
            if response.status_code != 200:
                raise _classify_failure(response, day)
            # Chunks of SNIFF_MAX_BYTES: httpx fills a whole chunk before yielding it,
            # so the zip check never pulls more than that from a non-zip body.
            chunks = response.iter_bytes(SNIFF_MAX_BYTES)
            head = next(chunks, b"")
            if head[:4] != b"PK\x03\x04":  # zip local-file-header magic
                raise _not_a_zip(response, head, day)
            expected = _content_length(response, day)
            written = 0
            with part.open("wb") as f:
                for chunk in chain((head,), chunks):
                    f.write(chunk)
                    written += len(chunk)
                    _check_deadline(day, deadline, written)
            if written != expected:
                raise _RetryableError(
                    "corrupt", f"{_where(response)}-200 got {written} of {expected} bytes"
                )
            info = _source_info(response, written)
        part.replace(dest)
        return info
    finally:
        part.unlink(missing_ok=True)


def _probe_once(day: date, api_key: str) -> SourceInfo:
    # Leaving the block closes the stream, so a 200's body is never read.
    with _open(day, api_key) as response:
        if response.status_code != 200:
            raise _classify_failure(response, day)
        return _source_info(response, _content_length(response, day))


def _check_deadline(day: date, deadline: float, written: int) -> None:
    if time.monotonic() > deadline:
        detail = f"deadline {DOWNLOAD_DEADLINE_SECONDS}s passed after {written} bytes"
        raise TapeDownloadError("timeout", day, detail)


def _where(response: httpx.Response) -> str:
    return "gcs" if response.url.host == "storage.googleapis.com" else "uw"


def _source_info(response: httpx.Response, size: int) -> SourceInfo:
    return SourceInfo(
        etag=response.headers.get("etag"),
        last_modified=response.headers.get("last-modified"),
        bytes=size,
    )


def _content_length(response: httpx.Response, day: date) -> int:
    value = response.headers.get("content-length", "")
    if not value.isdecimal():
        raise TapeDownloadError("unexpected", day, f"{_where(response)}-200 no content-length")
    return int(value)


def _sniff(response: httpx.Response) -> str:
    """At most SNIFF_MAX_BYTES of an error body, for classification only."""
    return next(response.iter_bytes(SNIFF_MAX_BYTES), b"").decode("utf-8", "replace")


def _outside_window(body: str, day: date, tag: str) -> TapeDownloadError:
    earliest, lookback = parse_boundary(body)
    detail = (
        f"{tag} historic window: earliest {earliest or 'unknown'}, "
        f"{lookback or 'unknown'} trading days"
    )
    return TapeDownloadError("outside_window", day, detail)


def _not_a_zip(response: httpx.Response, head: bytes, day: date) -> TapeDownloadError:
    tag = f"{_where(response)}-200"
    body = head.decode("utf-8", "replace")
    if HISTORIC_CODE in body.lower():
        return _outside_window(body, day, tag)
    media = response.headers.get("content-type", "none").split(";")[0].strip()
    return TapeDownloadError("unexpected", day, f"{tag} not a zip ({media})")


def _classify_failure(response: httpx.Response, day: date) -> Exception:
    """Map a non-200 final response to the error the attempt should raise."""
    status = response.status_code
    where = _where(response)
    tag = f"{where}-{status}"
    if status == 404:
        return TapeDownloadError("not_posted", day, tag)
    if status == 401:
        return TapeDownloadError("auth", day, tag)
    # Only UW's own 403s carry its codes; a GCS 403 falls through to unexpected.
    if status == 403 and where == "uw":
        body = _sniff(response)
        kind = classify_403(body, response.headers)
        if kind == "historic_boundary":
            return _outside_window(body, day, tag)
        if kind == "auth":
            return TapeDownloadError("auth", day, tag)
        return TapeDownloadError("unexpected", day, f"{tag} {kind}")
    if status == 429:
        count = response.headers.get("x-uw-daily-req-count", "")
        limit = response.headers.get("x-uw-token-req-limit", "")
        if count.isdecimal() and limit.isdecimal() and int(count) >= int(limit):
            return TapeDownloadError("quota_daily", day, f"{tag} daily {count} of {limit}")
        return _RetryableError("transient", tag, _retry_after(response))
    if status >= 500:
        return _RetryableError("transient", tag)
    return TapeDownloadError("unexpected", day, tag)


def _retry_after(response: httpx.Response) -> float | None:
    """Retry-After in seconds, capped at 300; None when absent or an HTTP-date."""
    value = response.headers.get("retry-after", "").strip()
    return float(min(int(value), 300)) if value.isdecimal() else None
