"""Read Full Tape days from the R2 lake, one cached Parquet file per day.

Single-threaded by design: a TapeReader owns one boto3 client, so make one per
thread and never share it. A client shared across threads once sent half its R2
requests without TLS verification (Windows workstation, 2026-10-28), so the
client is built with `verify=True`, every transfer is a plain `get_object`
stream (never `download_file`, which runs its own thread pool over the client)
and urllib3's InsecureRequestWarning is turned into an error.

Callers read the returned path themselves (pandas, pyarrow, DuckDB), `release`
each day when done and `close` the reader at the end. The reader imports no
polars, only boto3, botocore and urllib3, so the nightly image can carry it.

Logs and errors carry the object key, byte counts and seconds only: never a
credential, the endpoint, botocore's own error text (it embeds the endpoint
URL) or a row of tape data.
"""

from __future__ import annotations

import logging
import os
import re
import time
import warnings
from datetime import date
from pathlib import Path
from shutil import disk_usage
from typing import Any

import boto3
import urllib3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError, HTTPClientError, IncompleteReadError
from botocore.exceptions import ConnectionError as BotoConnectionError

log = logging.getLogger(__name__)

FETCH_CHUNK_BYTES = 8 * 2**20
FETCH_ATTEMPTS = 3
# The largest tape day is 1.74 GB, which needs at least 2.9 MB/s to land in this time.
FETCH_DEADLINE_SECONDS = 600
# A fetch is refused unless the free disk is at least the object's size plus this.
FETCH_DISK_HEADROOM_BYTES = 2 * 2**30

_PREFIX = 'fulltape/'
_TAPE_KEY = re.compile(r'fulltape/([0-9]{4}-[0-9]{2}-[0-9]{2})-fulltape\.parquet')
_ENV_NAMES = ('R2_ENDPOINT_URL', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_FULLTAPE')
_NO_SUCH_KEY_CODES = frozenset({'NoSuchKey', '404'})
# Everything a request or a body stream may raise apart from an S3 ClientError. A local
# OSError (full disk, locked file) is deliberately absent: it is not R2's doing.
_REQUEST_ERRORS = (BotoCoreError, urllib3.exceptions.HTTPError, ConnectionError, TimeoutError)
# The part of that a fresh GET may cure: a dropped, stalled or truncated transport.
# Everything else (no credentials, a bad parameter, a bad config) fails the same way
# again, so it is final on the first try.
_TRANSIENT_ERRORS = (
    HTTPClientError,  # ReadTimeoutError, ResponseStreamingError, ConnectionClosedError
    BotoConnectionError,  # EndpointConnectionError, ConnectTimeoutError, SSLError
    IncompleteReadError,  # botocore's own check that the body matched Content-Length
    urllib3.exceptions.HTTPError,
    ConnectionError,
    TimeoutError,
)


class TapeReadError(Exception):
    """A tape read failed. Messages hold the key, byte counts and a fixed phrase."""


class _Transient(Exception):
    """One GET failed in a way a fresh GET may cure. The message is a fixed phrase."""


def _tape_key(day: date) -> str:
    return f'{_PREFIX}{day.isoformat()}-fulltape.parquet'


def _parse_tape_key(key: str) -> date | None:
    """The day a tape key names, or None for any other key or an impossible date."""
    match = _TAPE_KEY.fullmatch(key)
    if match is None:
        return None
    try:
        return date.fromisoformat(match.group(1))
    except ValueError:
        return None


def _is_tls_guard_error(exc: BaseException) -> bool:
    """True when botocore gave up after urllib3's unverified-HTTPS guard fired."""
    return isinstance(exc, HTTPClientError) and isinstance(
        exc.kwargs.get('error'), urllib3.exceptions.InsecureRequestWarning
    )


def _failure_phrase(exc: BaseException) -> str:
    """A short, safe name for a botocore or transport failure: never its text."""
    if _is_tls_guard_error(exc):
        return 'TLS verification was skipped'
    if isinstance(exc, ClientError):
        return str(exc.response.get('Error', {}).get('Code', 'unknown'))
    return type(exc).__name__


def _request_failure(key: str, exc: BaseException) -> Exception:
    """The error to raise for a failed request or stream: only a dropped transport is transient."""
    if _is_tls_guard_error(exc):
        return TapeReadError(f'{key}: TLS verification was skipped for an R2 request; aborting')
    if isinstance(exc, _TRANSIENT_ERRORS):
        return _Transient(_failure_phrase(exc))
    return TapeReadError(f'{key}: R2 request failed ({_failure_phrase(exc)})')


def _check_deadline(key: str, deadline: float, written: int = 0, expected: int | None = None) -> None:
    if time.monotonic() <= deadline:
        return
    if expected is None:
        raise TapeReadError(f'{key}: fetch deadline passed before the read started')
    raise TapeReadError(f'{key}: fetch deadline passed after {written} of {expected} bytes')


class TapeReader:
    """Lists and fetches Full Tape days. One per thread: never share an instance.

    `cache_dir` belongs to one reader. The partial file's name is fixed per day
    (`<day>-fulltape.parquet.part`), so two readers, or two processes, on one directory
    would overwrite each other's download. Give each reader its own, empty directory.
    """

    def __init__(
        self,
        *,
        endpoint_url: str,
        access_key_id: str,
        secret_access_key: str,
        bucket: str,
        cache_dir: Path,
    ) -> None:
        # urllib3 warns before it sends, so an error here stops an unverified request
        # from going out. botocore wraps it as an HTTPClientError (see _is_tls_guard_error).
        warnings.filterwarnings('error', category=urllib3.exceptions.InsecureRequestWarning)
        self._bucket = bucket
        self._cache_dir = Path(cache_dir)
        self._cached: set[date] = set()
        try:
            self._client = boto3.client(
                's3',
                endpoint_url=endpoint_url,
                aws_access_key_id=access_key_id,
                aws_secret_access_key=secret_access_key,
                region_name='auto',
                verify=True,
                config=Config(
                    signature_version='s3v4',
                    retries={'mode': 'standard', 'max_attempts': 5},
                    connect_timeout=10,
                    read_timeout=60,
                ),
            )
        except Exception as exc:
            # Not chained: botocore's text can embed the endpoint URL, which holds the R2 account id.
            raise TapeReadError(f'could not build the R2 client ({type(exc).__name__})') from None
        self._cache_dir.mkdir(parents=True, exist_ok=True)

    @classmethod
    def from_env(cls, cache_dir: Path) -> TapeReader:
        """Build a reader from the four R2_* variables; a missing one is named, never any value."""
        values = {name: os.environ.get(name, '').strip() for name in _ENV_NAMES}
        missing = [name for name, value in values.items() if not value]
        if missing:
            raise TapeReadError(f'R2 is not configured: missing {", ".join(missing)}')
        return cls(
            endpoint_url=values['R2_ENDPOINT_URL'],
            access_key_id=values['R2_ACCESS_KEY_ID'],
            secret_access_key=values['R2_SECRET_ACCESS_KEY'],
            bucket=values['R2_BUCKET_FULLTAPE'],
            cache_dir=cache_dir,
        )

    @property
    def cache_dir(self) -> Path:
        return self._cache_dir

    def landed_days(self) -> set[date]:
        """Every day with a tape object under `fulltape/`. The key existing is what landed means."""
        days: set[date] = set()
        paginator = self._client.get_paginator('list_objects_v2')
        try:
            for page in paginator.paginate(Bucket=self._bucket, Prefix=_PREFIX):
                for obj in page.get('Contents', []):
                    day = _parse_tape_key(obj['Key'])
                    if day is not None:
                        days.add(day)
        except (ClientError, BotoCoreError) as exc:
            raise TapeReadError(f'listing {_PREFIX} failed ({_failure_phrase(exc)})') from None
        return days

    def path(self, day: date) -> Path:
        return self._cache_dir / f'{day.isoformat()}-fulltape.parquet'

    def fetch_day(self, day: date, deadline: float | None = None) -> Path | None:
        """Download a day into the cache and return its path; None when R2 has no such object.

        `deadline` is an absolute `time.monotonic()` reading that covers every attempt;
        the default is FETCH_DEADLINE_SECONDS from now. The object streams to
        `<path>.part`, its byte count is checked against ContentLength, and only then
        is it renamed into place, so `path(day)` never holds a partial file. A file
        already at `path(day)` is replaced. A dropped, stalled or short stream is retried
        as a whole GET up to FETCH_ATTEMPTS times; a refusal, an empty object, any other
        client error, a full disk or a passed deadline is final.
        """
        key = _tape_key(day)
        target = self.path(day)
        part = target.with_name(f'{target.name}.part')
        started = time.monotonic()
        if deadline is None:
            deadline = started + FETCH_DEADLINE_SECONDS
        last_failure = ''
        for attempt in range(1, FETCH_ATTEMPTS + 1):
            try:
                size = self._download(key, part, deadline)
                if size is None:
                    return None
                os.replace(part, target)
            except _Transient as exc:
                part.unlink(missing_ok=True)
                last_failure = str(exc)
                log.warning('fetch of %s failed on attempt %d/%d: %s', key, attempt, FETCH_ATTEMPTS, last_failure)
                continue
            except BaseException:
                part.unlink(missing_ok=True)
                raise
            self._cached.add(day)
            log.info('fetched %s: %d bytes in %.1fs', key, size, time.monotonic() - started)
            return target
        raise TapeReadError(f'{key}: fetch failed after {FETCH_ATTEMPTS} attempts ({last_failure})')

    def _download(self, key: str, part: Path, deadline: float) -> int | None:
        """One GET of `key` streamed into `part`: its byte count, or None when R2 has no such object."""
        _check_deadline(key, deadline)
        try:
            response = self._client.get_object(Bucket=self._bucket, Key=key)
        except ClientError as exc:
            code = _failure_phrase(exc)
            if code in _NO_SUCH_KEY_CODES:
                return None
            raise TapeReadError(f'{key}: R2 refused the read ({code})') from None
        except _REQUEST_ERRORS as exc:
            raise _request_failure(key, exc) from None
        body = response['Body']
        try:
            expected = response.get('ContentLength')
            if not isinstance(expected, int):
                raise TapeReadError(f'{key}: R2 sent no ContentLength')
            if expected == 0:
                raise TapeReadError(f'{key}: R2 object is empty (0 bytes)')
            needed = expected + FETCH_DISK_HEADROOM_BYTES
            free = disk_usage(self._cache_dir).free
            if free < needed:
                raise TapeReadError(
                    f'{key}: refusing to fetch {expected} bytes: {free} bytes free, {needed} needed'
                )
            written = self._stream(key, body, part, expected, deadline)
        finally:
            body.close()
        if written != expected:
            raise _Transient(f'got {written} of {expected} bytes')
        return written

    @staticmethod
    def _stream(key: str, body: Any, part: Path, expected: int, deadline: float) -> int:
        """Write `body` to `part` in FETCH_CHUNK_BYTES reads; the byte count written."""
        written = 0
        with part.open('wb') as out:
            while True:
                try:
                    chunk = body.read(FETCH_CHUNK_BYTES)
                except _REQUEST_ERRORS as exc:
                    raise _request_failure(key, exc) from None
                if not chunk:
                    return written
                out.write(chunk)
                written += len(chunk)
                _check_deadline(key, deadline, written, expected)

    def release(self, day: date) -> None:
        """Delete a day's cached file; a missing file is fine."""
        self.path(day).unlink(missing_ok=True)
        self._cached.discard(day)

    def close(self) -> None:
        """Delete every file this reader cached and close its client.

        Every file is attempted even when one fails to delete; the first failure is
        raised once all are done.
        """
        failures: list[OSError] = []
        for day in sorted(self._cached):
            try:
                self.release(day)
            except OSError as exc:
                failures.append(exc)
        self._client.close()
        if failures:
            raise failures[0]

    def __enter__(self) -> TapeReader:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
