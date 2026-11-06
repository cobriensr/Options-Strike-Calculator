"""Unit tests for scripts/_tape_reader.py.

The R2 client is replaced at the module boundary: boto3.client is patched to
hand back an in-memory fake. scripts/conftest.py blocks botocore's
BaseClient._make_api_call (where moto and Stubber hook in), so no test here can
reach a real store.

Run:

    ml/.venv/Scripts/python -m pytest scripts/test_tape_reader.py -q
"""

from __future__ import annotations

import logging
import sys
import threading
import warnings
from collections import namedtuple
from collections.abc import Callable
from datetime import date
from pathlib import Path
from typing import Any

import pytest
import urllib3
from botocore.exceptions import ClientError, HTTPClientError, ReadTimeoutError

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _tape_reader  # noqa: E402
from _tape_reader import TapeReader, TapeReadError  # noqa: E402

BUCKET = 'tape-test-bucket'
ENDPOINT = 'https://endpoint-sentinel.invalid'
ACCESS_KEY_ID = 'ACCESS-KEY-ID-SENTINEL'
SECRET_KEY = 'SECRET-ACCESS-KEY-SENTINEL'
SENTINELS = (ENDPOINT, 'endpoint-sentinel', ACCESS_KEY_ID, SECRET_KEY)

DAY = date(2026, 10, 27)
OTHER_DAY = date(2026, 10, 26)
KEY = f'fulltape/{DAY}-fulltape.parquet'
OTHER_KEY = f'fulltape/{OTHER_DAY}-fulltape.parquet'
BODY = b'0123456789abcdef'

Usage = namedtuple('Usage', 'total used free')


class FakeBody:
    """Stands in for botocore's StreamingBody: read(amt) and close()."""

    def __init__(
        self,
        data: bytes,
        *,
        drop_tail: int = 0,
        fail_on_read: int | None = None,
        on_read: Callable[[int], None] | None = None,
    ) -> None:
        # drop_tail bytes never arrive, and nothing raises: a silently short body.
        self._data = data[: len(data) - drop_tail]
        self._pos = 0
        self._fail_on_read = fail_on_read
        self._on_read = on_read
        self.reads = 0
        self.closed = False

    def read(self, amt: int) -> bytes:
        self.reads += 1
        if self.reads == self._fail_on_read:
            raise ReadTimeoutError(endpoint_url=ENDPOINT)
        chunk = self._data[self._pos : self._pos + amt]
        self._pos += len(chunk)
        if self._on_read is not None:
            self._on_read(self.reads)
        return chunk

    def close(self) -> None:
        self.closed = True


class FakeR2:
    """An in-memory boto3 S3 client over one bucket, with the failure knobs the tests need."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.client_calls: list[dict[str, Any]] = []
        self.get_calls: list[str] = []
        self.bodies: list[FakeBody] = []
        self.transfer_calls: list[str] = []
        self.closed = False
        self.page_size = 2
        self.list_error: Exception | None = None
        self.get_error: Exception | None = None
        self.omit_content_length = False
        # (attempt number starting at 1, object bytes) -> the body that attempt streams.
        self.make_body: Callable[[int, bytes], FakeBody] = lambda _attempt, data: FakeBody(data)

    def client_factory(self, *args: Any, **kwargs: Any) -> FakeR2:
        self.client_calls.append({'args': args, 'kwargs': kwargs})
        return self

    def get_paginator(self, name: str) -> FakePaginator:
        assert name == 'list_objects_v2'
        return FakePaginator(self)

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        self.get_calls.append(Key)
        if self.get_error is not None:
            raise self.get_error
        if Bucket != BUCKET or Key not in self.objects:
            raise ClientError(
                {'Error': {'Code': 'NoSuchKey', 'Message': 'The specified key does not exist.'}},
                'GetObject',
            )
        data = self.objects[Key]
        body = self.make_body(len(self.get_calls), data)
        self.bodies.append(body)
        response: dict[str, Any] = {'Body': body}
        if not self.omit_content_length:
            response['ContentLength'] = len(data)
        return response

    def close(self) -> None:
        self.closed = True

    # The multi-threaded transfer helpers the reader must never call.
    def download_file(self, *args: Any, **kwargs: Any) -> None:
        self.transfer_calls.append('download_file')
        raise AssertionError('download_file runs its own thread pool over one client')

    def download_fileobj(self, *args: Any, **kwargs: Any) -> None:
        self.transfer_calls.append('download_fileobj')
        raise AssertionError('download_fileobj runs its own thread pool over one client')

    def upload_file(self, *args: Any, **kwargs: Any) -> None:
        self.transfer_calls.append('upload_file')
        raise AssertionError('the reader never writes to R2')


class FakePaginator:
    def __init__(self, client: FakeR2) -> None:
        self._client = client

    def paginate(self, *, Bucket: str, Prefix: str = '') -> Any:
        if self._client.list_error is not None:
            raise self._client.list_error
        assert Bucket == BUCKET
        keys = sorted(key for key in self._client.objects if key.startswith(Prefix))
        size = self._client.page_size
        for start in range(0, len(keys), size):
            yield {'Contents': [{'Key': key} for key in keys[start : start + size]]}
        if not keys:
            yield {}


@pytest.fixture
def r2(monkeypatch: pytest.MonkeyPatch) -> FakeR2:
    fake = FakeR2()
    monkeypatch.setattr(_tape_reader.boto3, 'client', fake.client_factory)
    return fake


@pytest.fixture(autouse=True)
def _plenty_of_disk(monkeypatch: pytest.MonkeyPatch) -> None:
    """Report a huge free disk, so no test depends on the machine's real free space."""
    monkeypatch.setattr(_tape_reader, 'disk_usage', lambda _path: Usage(2**50, 0, 2**50))


@pytest.fixture
def reader(r2: FakeR2, tmp_path: Path) -> TapeReader:
    return make_reader(tmp_path)


def make_reader(tmp_path: Path) -> TapeReader:
    return TapeReader(
        endpoint_url=ENDPOINT,
        access_key_id=ACCESS_KEY_ID,
        secret_access_key=SECRET_KEY,
        bucket=BUCKET,
        cache_dir=tmp_path / 'cache',
    )


def part_of(path: Path) -> Path:
    return path.with_name(f'{path.name}.part')


def assert_nothing_cached(reader: TapeReader, day: date) -> None:
    assert not reader.path(day).exists()
    assert not part_of(reader.path(day)).exists()


def assert_no_secrets(text: str) -> None:
    for sentinel in SENTINELS:
        assert sentinel not in text


def test_landed_days_reads_only_tape_keys(r2: FakeR2, reader: TapeReader) -> None:
    r2.objects.update(
        {
            KEY: b'nightly day, with user metadata on R2',
            # An upload-script object carries no metadata but is still a landed day.
            'fulltape/2026-03-16-fulltape.parquet': b'legacy day',
            'gexbot-eod/SPX/2026-10-28.zip': b'zip',
            'fulltape/_unavailable/2026-05-29.json': b'{}',
            'fulltape/_superseded/2026-10-20-x.parquet': b'old',
            'fulltape/notes.txt': b'notes',
            # Near misses each name a day of their own, so one that slipped through would show.
            'fulltape/2026-10-21.parquet': b'not a tape name',
            'fulltape/2026-10-22-fulltape.parquet.part': b'half an upload',
            # Shaped like a tape key but not a calendar date.
            'fulltape/2026-13-45-fulltape.parquet': b'impossible date',
            # Sorts after the near misses, so it lands on a later listing page.
            'fulltape/2026-10-30-fulltape.parquet': b'newest day',
        }
    )

    assert r2.page_size < len(r2.objects)  # the listing spans several pages
    assert reader.landed_days() == {date(2026, 3, 16), DAY, date(2026, 10, 30)}


def test_landed_days_is_empty_for_an_empty_prefix(reader: TapeReader) -> None:
    assert reader.landed_days() == set()


def test_landed_days_names_a_listing_failure(r2: FakeR2, reader: TapeReader) -> None:
    r2.list_error = ClientError({'Error': {'Code': 'AccessDenied', 'Message': 'no'}}, 'ListObjectsV2')

    with pytest.raises(TapeReadError, match='listing fulltape/ failed .*AccessDenied') as caught:
        reader.landed_days()

    assert_no_secrets(str(caught.value))


def test_fetch_day_writes_atomically_and_checks_size(r2: FakeR2, reader: TapeReader, monkeypatch) -> None:
    monkeypatch.setattr(_tape_reader, 'FETCH_CHUNK_BYTES', 4)
    r2.objects[KEY] = BODY
    final = reader.path(DAY)
    seen: list[tuple[bool, bool]] = []

    def watch(read_number: int) -> None:
        if read_number == 2:  # mid-stream: the partial file exists, the final one does not
            seen.append((final.exists(), part_of(final).exists()))

    r2.make_body = lambda _attempt, data: FakeBody(data, on_read=watch)

    path = reader.fetch_day(DAY)

    assert path == final == reader.cache_dir / f'{DAY}-fulltape.parquet'
    assert path.read_bytes() == BODY
    assert not part_of(path).exists()
    assert seen == [(False, True)]
    assert r2.bodies[0].reads == 5  # four 4-byte chunks, then the empty read that ends the stream
    assert r2.bodies[0].closed


def test_fetch_day_replaces_a_file_left_by_an_earlier_run(r2: FakeR2, reader: TapeReader) -> None:
    r2.objects[KEY] = BODY
    reader.cache_dir.mkdir(parents=True, exist_ok=True)
    reader.path(DAY).write_bytes(b'stale')
    part_of(reader.path(DAY)).write_bytes(b'stale part')

    assert reader.fetch_day(DAY) == reader.path(DAY)

    assert reader.path(DAY).read_bytes() == BODY
    assert not part_of(reader.path(DAY)).exists()


def test_fetch_missing_day_returns_none(r2: FakeR2, reader: TapeReader) -> None:
    assert reader.fetch_day(DAY) is None

    assert r2.get_calls == [KEY]  # a missing object is final, not retried
    assert_nothing_cached(reader, DAY)


def test_short_body_retries_then_raises_and_leaves_nothing(
    r2: FakeR2, reader: TapeReader, caplog: pytest.LogCaptureFixture, monkeypatch
) -> None:
    monkeypatch.setattr(_tape_reader, 'FETCH_CHUNK_BYTES', 4)
    r2.objects[KEY] = BODY
    r2.make_body = lambda _attempt, data: FakeBody(data, drop_tail=4)  # the last chunk never arrives

    with caplog.at_level(logging.DEBUG, logger='_tape_reader'):
        with pytest.raises(TapeReadError) as caught:
            reader.fetch_day(DAY)

    assert r2.get_calls == [KEY] * _tape_reader.FETCH_ATTEMPTS
    assert_nothing_cached(reader, DAY)
    message = str(caught.value)
    assert KEY in message
    assert '12 of 16 bytes' in message
    assert_no_secrets(message)
    assert_no_secrets(caplog.text)
    assert all(body.closed for body in r2.bodies)


def test_a_dropped_stream_is_retried_and_the_retry_can_succeed(
    r2: FakeR2, reader: TapeReader, caplog: pytest.LogCaptureFixture, monkeypatch
) -> None:
    monkeypatch.setattr(_tape_reader, 'FETCH_CHUNK_BYTES', 4)
    r2.objects[KEY] = BODY
    r2.make_body = lambda attempt, data: FakeBody(data, fail_on_read=2 if attempt == 1 else None)

    with caplog.at_level(logging.DEBUG, logger='_tape_reader'):
        path = reader.fetch_day(DAY)

    assert path is not None and path.read_bytes() == BODY
    assert r2.get_calls == [KEY, KEY]
    assert not part_of(path).exists()
    assert 'ReadTimeoutError' in caplog.text  # the failure is named...
    assert_no_secrets(caplog.text)  # ...but botocore's text, which embeds the endpoint, is not


def test_a_failed_get_that_botocore_raised_is_retried(r2: FakeR2, reader: TapeReader) -> None:
    r2.objects[KEY] = BODY
    r2.get_error = HTTPClientError(error=OSError('connection reset'))

    with pytest.raises(TapeReadError, match='after 3 attempts') as caught:
        reader.fetch_day(DAY)

    assert len(r2.get_calls) == _tape_reader.FETCH_ATTEMPTS
    assert 'HTTPClientError' in str(caught.value)
    assert_nothing_cached(reader, DAY)


def test_a_refused_read_is_not_retried(r2: FakeR2, reader: TapeReader) -> None:
    r2.objects[KEY] = BODY
    r2.get_error = ClientError({'Error': {'Code': 'AccessDenied', 'Message': 'no'}}, 'GetObject')

    with pytest.raises(TapeReadError, match='AccessDenied') as caught:
        reader.fetch_day(DAY)

    assert r2.get_calls == [KEY]
    assert KEY in str(caught.value)
    assert_nothing_cached(reader, DAY)


def test_a_skipped_tls_check_aborts_without_retrying(r2: FakeR2, reader: TapeReader) -> None:
    r2.objects[KEY] = BODY
    r2.get_error = HTTPClientError(error=urllib3.exceptions.InsecureRequestWarning('unverified'))

    with pytest.raises(TapeReadError, match='TLS verification was skipped'):
        reader.fetch_day(DAY)

    assert r2.get_calls == [KEY]
    assert_nothing_cached(reader, DAY)


def test_a_response_without_content_length_is_refused(r2: FakeR2, reader: TapeReader) -> None:
    r2.objects[KEY] = BODY
    r2.omit_content_length = True

    with pytest.raises(TapeReadError, match='no ContentLength'):
        reader.fetch_day(DAY)

    assert r2.bodies[0].reads == 0
    assert r2.bodies[0].closed
    assert_nothing_cached(reader, DAY)


def test_fetch_deadline_raises(r2: FakeR2, reader: TapeReader, monkeypatch) -> None:
    monkeypatch.setattr(_tape_reader, 'FETCH_CHUNK_BYTES', 4)
    r2.objects[KEY] = BODY
    clock = {'now': 100.0}
    monkeypatch.setattr(_tape_reader.time, 'monotonic', lambda: clock['now'])

    def jump_past_the_deadline(read_number: int) -> None:
        if read_number == 1:
            clock['now'] = 10_000.0

    r2.make_body = lambda _attempt, data: FakeBody(data, on_read=jump_past_the_deadline)

    with pytest.raises(TapeReadError, match='deadline') as caught:
        reader.fetch_day(DAY, deadline=200.0)

    assert r2.get_calls == [KEY]  # the deadline covers every attempt, so nothing is retried
    assert 'after 4 of 16 bytes' in str(caught.value)
    assert r2.bodies[0].reads == 1
    assert r2.bodies[0].closed
    assert_nothing_cached(reader, DAY)


def test_fetch_after_the_deadline_never_calls_r2(r2: FakeR2, reader: TapeReader, monkeypatch) -> None:
    r2.objects[KEY] = BODY
    monkeypatch.setattr(_tape_reader.time, 'monotonic', lambda: 500.0)

    with pytest.raises(TapeReadError, match='deadline'):
        reader.fetch_day(DAY, deadline=499.0)

    assert r2.get_calls == []
    assert_nothing_cached(reader, DAY)


def test_the_default_deadline_is_a_fixed_window_from_the_call(r2: FakeR2, reader: TapeReader, monkeypatch) -> None:
    monkeypatch.setattr(_tape_reader, 'FETCH_CHUNK_BYTES', 4)
    r2.objects[KEY] = BODY
    clock = {'now': 1_000.0}
    monkeypatch.setattr(_tape_reader.time, 'monotonic', lambda: clock['now'])

    def advance(read_number: int) -> None:
        if read_number == 2:
            clock['now'] += _tape_reader.FETCH_DEADLINE_SECONDS  # exactly on the deadline
        elif read_number == 3:
            clock['now'] += 1  # one second past it

    r2.make_body = lambda _attempt, data: FakeBody(data, on_read=advance)

    # Exactly FETCH_DEADLINE_SECONDS after the call is still inside the window; one second more is not.
    with pytest.raises(TapeReadError, match='deadline'):
        reader.fetch_day(DAY)

    assert r2.bodies[0].reads == 3


def test_disk_exactly_at_size_plus_headroom_is_enough(r2: FakeR2, reader: TapeReader, monkeypatch) -> None:
    r2.objects[KEY] = BODY
    needed = len(BODY) + _tape_reader.FETCH_DISK_HEADROOM_BYTES
    monkeypatch.setattr(_tape_reader, 'disk_usage', lambda _path: Usage(2**50, 0, needed))

    assert reader.fetch_day(DAY) == reader.path(DAY)


def test_low_disk_refuses_before_reading(r2: FakeR2, reader: TapeReader, monkeypatch) -> None:
    r2.objects[KEY] = BODY
    needed = len(BODY) + _tape_reader.FETCH_DISK_HEADROOM_BYTES
    seen: list[Path] = []

    def usage(path: Path) -> Usage:
        seen.append(Path(path))
        return Usage(2**50, 0, needed - 1)  # one byte short of size plus headroom

    monkeypatch.setattr(_tape_reader, 'disk_usage', usage)

    with pytest.raises(TapeReadError, match='refusing to fetch') as caught:
        reader.fetch_day(DAY)

    message = str(caught.value)
    assert KEY in message
    assert str(len(BODY)) in message
    assert str(needed - 1) in message
    assert seen == [reader.cache_dir]  # the cache directory's disk is the one measured
    assert r2.get_calls == [KEY]  # a full disk is not transient, so no second try
    assert r2.bodies[0].reads == 0  # nothing was read, so nothing was written
    assert r2.bodies[0].closed
    assert_nothing_cached(reader, DAY)


def test_release_and_close_remove_cached_files(r2: FakeR2, reader: TapeReader) -> None:
    r2.objects[KEY] = BODY
    r2.objects[OTHER_KEY] = BODY * 2
    reader.fetch_day(DAY)
    reader.fetch_day(OTHER_DAY)
    stranger = reader.cache_dir / 'not-ours.txt'
    stranger.write_text('left alone')

    reader.release(DAY)
    reader.release(DAY)  # already gone: no error
    reader.release(date(2020, 1, 1))  # never fetched: no error

    assert not reader.path(DAY).exists()
    assert reader.path(OTHER_DAY).exists()

    reader.close()

    assert not reader.path(OTHER_DAY).exists()
    assert stranger.read_text() == 'left alone'  # only files this reader cached are deleted
    assert r2.closed


def test_exiting_the_context_closes_the_reader(r2: FakeR2, tmp_path: Path) -> None:
    r2.objects[KEY] = BODY

    with make_reader(tmp_path) as reader:
        path = reader.fetch_day(DAY)
        assert path is not None and path.exists()

    assert not path.exists()
    assert r2.closed


def test_close_removes_every_file_even_when_one_release_fails(
    r2: FakeR2, reader: TapeReader, monkeypatch
) -> None:
    r2.objects[KEY] = BODY
    r2.objects[OTHER_KEY] = BODY
    reader.fetch_day(DAY)
    reader.fetch_day(OTHER_DAY)
    real_release = TapeReader.release

    def release(self: TapeReader, day: date) -> None:
        if day == OTHER_DAY:  # the earlier day sorts first and is the one that fails
            raise PermissionError('file is open elsewhere')
        real_release(self, day)

    monkeypatch.setattr(TapeReader, 'release', release)

    with pytest.raises(PermissionError):
        reader.close()

    assert not reader.path(DAY).exists()  # the later day was still removed
    assert r2.closed


def test_from_env_names_the_missing_var(r2: FakeR2, monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv('R2_ENDPOINT_URL', ENDPOINT)
    monkeypatch.setenv('R2_ACCESS_KEY_ID', ACCESS_KEY_ID)
    monkeypatch.setenv('R2_SECRET_ACCESS_KEY', SECRET_KEY)
    monkeypatch.delenv('R2_BUCKET_FULLTAPE', raising=False)

    with pytest.raises(TapeReadError) as caught:
        TapeReader.from_env(tmp_path / 'cache')

    message = str(caught.value)
    assert 'R2_BUCKET_FULLTAPE' in message
    assert_no_secrets(message)
    for other in ('R2_ENDPOINT_URL', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'):
        assert other not in message
    assert r2.client_calls == []
    assert not (tmp_path / 'cache').exists()


def test_from_env_lists_every_missing_or_blank_var(r2: FakeR2, monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv('R2_ENDPOINT_URL', '   ')
    monkeypatch.delenv('R2_ACCESS_KEY_ID', raising=False)
    monkeypatch.delenv('R2_SECRET_ACCESS_KEY', raising=False)
    monkeypatch.setenv('R2_BUCKET_FULLTAPE', BUCKET)

    with pytest.raises(TapeReadError) as caught:
        TapeReader.from_env(tmp_path)

    message = str(caught.value)
    for name in ('R2_ENDPOINT_URL', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'):
        assert name in message
    assert BUCKET not in message


def test_from_env_builds_a_reader_from_the_four_vars(r2: FakeR2, monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv('R2_ENDPOINT_URL', ENDPOINT)
    monkeypatch.setenv('R2_ACCESS_KEY_ID', ACCESS_KEY_ID)
    monkeypatch.setenv('R2_SECRET_ACCESS_KEY', SECRET_KEY)
    monkeypatch.setenv('R2_BUCKET_FULLTAPE', BUCKET)
    r2.objects[KEY] = BODY

    reader = TapeReader.from_env(tmp_path / 'cache')

    kwargs = r2.client_calls[0]['kwargs']
    assert kwargs['endpoint_url'] == ENDPOINT
    assert kwargs['aws_access_key_id'] == ACCESS_KEY_ID
    assert kwargs['aws_secret_access_key'] == SECRET_KEY
    assert reader.cache_dir == tmp_path / 'cache'
    assert reader.landed_days() == {DAY}  # it reads the bucket the env names


def test_one_client_and_no_transfer_threads(r2: FakeR2, reader: TapeReader) -> None:
    r2.objects[KEY] = BODY
    r2.objects[OTHER_KEY] = BODY
    threads_before = threading.active_count()

    reader.landed_days()
    reader.fetch_day(DAY)
    reader.fetch_day(OTHER_DAY)
    reader.release(DAY)
    reader.close()

    assert len(r2.client_calls) == 1  # one boto3 client per reader
    assert r2.transfer_calls == []  # download_file and friends are never touched
    assert threading.active_count() == threads_before

    call = r2.client_calls[0]
    assert call['args'] == ('s3',)
    kwargs = call['kwargs']
    assert kwargs['verify'] is True
    assert kwargs['region_name'] == 'auto'
    assert kwargs['endpoint_url'] == ENDPOINT
    config = kwargs['config']
    assert config.signature_version == 's3v4'
    assert config.retries == {'mode': 'standard', 'max_attempts': 5}
    assert config.connect_timeout == 10
    assert config.read_timeout == 60


def test_a_second_reader_builds_its_own_client(r2: FakeR2, tmp_path: Path) -> None:
    first = make_reader(tmp_path / 'one')
    second = make_reader(tmp_path / 'two')

    assert len(r2.client_calls) == 2
    assert first.cache_dir != second.cache_dir


def test_building_a_reader_turns_the_insecure_request_warning_into_an_error(r2: FakeR2, tmp_path: Path) -> None:
    with warnings.catch_warnings():
        warnings.simplefilter('default')  # undo any filter a previous test left behind...
        make_reader(tmp_path)  # ...then the reader must put its own back
        with pytest.raises(urllib3.exceptions.InsecureRequestWarning):
            warnings.warn('unverified HTTPS request', urllib3.exceptions.InsecureRequestWarning, stacklevel=1)


def test_the_constants_match_the_design() -> None:
    assert _tape_reader.FETCH_CHUNK_BYTES == 8 * 2**20
    assert _tape_reader.FETCH_ATTEMPTS == 3
    assert _tape_reader.FETCH_DEADLINE_SECONDS == 600
    assert _tape_reader.FETCH_DISK_HEADROOM_BYTES == 2 * 2**30
