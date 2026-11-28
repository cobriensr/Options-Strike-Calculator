"""Shared by the Interval B/A script tests: a replay export on disk, a fake S3, and a day-file world.

Used by test_enrich_interval_ba_outcomes.py, test_analyze_interval_ba_cuts.py,
test_analyze_confluence_vs_solo.py and test_interval_ba_days.py, so the export's schema, the fake
bucket and the day-file world exist once. Nothing here runs on its own (pytest collects only
test_*.py).

- `EXPORT_SCHEMA`, `export_row` and `write_export` build a replay export with the export's columns
  (nightly/src/interval_ba_replay.py `EXPORT_COLUMNS`; test_export_columns_match_the_replay_module
  holds the copy to the module's own).
- `FakeS3` is a bucket on 127.0.0.1 for DuckDB's httpfs, started by the `fake_s3` fixture for one
  test and shut down in its teardown. `s3_connection` points a DuckDB connection at it and skips
  the test where httpfs is not installed.
- `DayWorld(directory, monkeypatch)` is the replay day files and their tapes: day files as local
  Parquet, an R2 listing of them and of the tapes (`FakeR2Client`, the one call the readers'
  check makes), a clock, and a stand-in for the tool's `write_replay_days` that writes the day
  files the real one would. The three boundaries are patched, so no test reaches R2. Each test
  file wraps it in a `day_world` fixture of its own.
"""

from __future__ import annotations

import http.server
import json
import re
import threading
import urllib.parse
from collections.abc import Iterator
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from unittest.mock import create_autospec

import _interval_ba_days as days
import duckdb
import interval_ba_tape as tool
import interval_ba_tape_runs as runs
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

DAY = date(2026, 11, 17)  # a Tuesday: CST, so the 15:00 CT close is 21:00 UTC
DAY_ISO = DAY.isoformat()
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def at(clock: str, day: date = DAY) -> datetime:
    """An aware UTC instant on `day` from 'HH:MM:SS[.ffffff]'."""
    return datetime.fromisoformat(f'{day.isoformat()}T{clock}+00:00')


def local_connection() -> duckdb.DuckDBPyConnection:
    """A DuckDB connection under a session zone that is not UTC."""
    db = duckdb.connect()
    db.execute("SET TimeZone='America/Chicago'")
    return db


# --- the replay export ------------------------------------------------------------------------

# The columns of the tool's export, in its order (spec 6.5).
_UTC_US = pa.timestamp('us', tz='UTC')
EXPORT_SCHEMA = pa.schema(
    [
        ('option_chain', pa.string()),
        ('ticker', pa.string()),
        ('option_type', pa.string()),
        ('strike', pa.decimal128(10, 3)),
        ('expiry', pa.date32()),
        ('bucket_start', _UTC_US),
        ('bucket_end', _UTC_US),
        ('fired_at', _UTC_US),
        ('ratio_pct', pa.decimal128(5, 2)),
        ('ask_premium', pa.decimal128(14, 2)),
        ('total_premium', pa.decimal128(14, 2)),
        ('trade_count', pa.int32()),
        ('top_trade_premium', pa.decimal128(14, 2)),
        ('top_trade_size', pa.int32()),
        ('top_trade_executed_at', _UTC_US),
        ('top_trade_is_sweep', pa.bool_()),
        ('top_trade_is_floor', pa.bool_()),
        ('underlying_price', pa.decimal128(10, 2)),
        ('confluence_tickers', pa.list_(pa.string())),
    ]
)


def export_row(
    chain: str,
    fired_clock: str,
    spot: str | None,
    *,
    total: str = '300000.00',
    expiry: date = DAY,
    **fields: object,
) -> dict[str, object]:
    """One export row. `fields` overrides any column, for example ratio_pct or the flags."""
    fired = at(fired_clock, expiry)
    bucket = fired - timedelta(seconds=fired.timestamp() % 300)
    row: dict[str, object] = {
        'option_chain': chain,
        'ticker': chain[:-15],
        'option_type': chain[-9],
        'strike': Decimal('6700.000'),
        'expiry': expiry,
        'bucket_start': bucket,
        'bucket_end': bucket + timedelta(seconds=300),
        'fired_at': fired,
        'ratio_pct': Decimal('80.00'),
        'ask_premium': Decimal(total) * Decimal('0.8'),
        'total_premium': Decimal(total),
        'trade_count': 3,
        'top_trade_premium': Decimal('100000.00'),
        'top_trade_size': 10,
        'top_trade_executed_at': fired,
        'top_trade_is_sweep': False,
        'top_trade_is_floor': False,
        'underlying_price': Decimal(spot) if spot is not None else None,
        'confluence_tickers': [],
    }
    row.update(fields)
    return row


def write_export(
    tmp_path: Path,
    rows: list[dict[str, object]],
    schema: pa.Schema = EXPORT_SCHEMA,
    end: str = DAY_ISO,
) -> str:
    """Write the rows as `replay-<end>.parquet` in tmp_path and return its path."""
    path = tmp_path / f'replay-{end}.parquet'
    pq.write_table(pa.Table.from_pylist(rows, schema=schema), path)
    return path.as_posix()


# --- a fake S3 on loopback --------------------------------------------------------------------


class FakeS3:
    """A bucket on 127.0.0.1 for DuckDB's httpfs, started for one test and closed in its
    teardown. `objects` maps '/bucket/key' to bytes, served with HEAD, ranged GET and a
    ListObjectsV2 listing. A path in `forbidden` answers 403, every other path 404. Nothing
    leaves the loopback interface."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.forbidden: set[str] = set()
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def _send(self, status: int, body: bytes, extra: dict[str, str] | None = None):
                self.send_response(status)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Length', str(len(body)))
                for name, value in (extra or {}).items():
                    self.send_header(name, value)
                self.end_headers()
                if self.command != 'HEAD':
                    self.wfile.write(body)

            def _list(self, bucket_path: str, query: dict[str, list[str]]) -> None:
                prefix = bucket_path + query.get('prefix', [''])[0]
                contents = ''.join(
                    f'<Contents><Key>{urllib.parse.quote(key[len(bucket_path) :])}</Key>'
                    '<LastModified>2026-11-26T21:00:00.000Z</LastModified>'
                    f'<ETag>"fake"</ETag><Size>{len(data)}</Size>'
                    '<StorageClass>STANDARD</StorageClass></Contents>'
                    for key, data in sorted(outer.objects.items())
                    if key.startswith(prefix)
                )
                body = (
                    '<?xml version="1.0" encoding="UTF-8"?>'
                    '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
                    f'<Name>{bucket_path.strip("/")}</Name><IsTruncated>false</IsTruncated>'
                    f'<MaxKeys>1000</MaxKeys>{contents}</ListBucketResult>'
                ).encode()
                self._send(200, body, {'Content-Type': 'application/xml'})

            def _serve(self) -> None:
                parts = urllib.parse.urlsplit(self.path)
                query = urllib.parse.parse_qs(parts.query)
                if 'list-type' in query:
                    self._list(parts.path if parts.path.endswith('/') else parts.path + '/', query)
                    return
                path = parts.path
                if path in outer.forbidden:
                    self._send(403, b'<Error><Code>AccessDenied</Code></Error>')
                    return
                data = outer.objects.get(path)
                if data is None:
                    self._send(404, b'<Error><Code>NoSuchKey</Code></Error>')
                    return
                meta = {
                    'Accept-Ranges': 'bytes',
                    'ETag': '"fake"',
                    'Last-Modified': 'Tue, 17 Nov 2026 21:00:00 GMT',
                }
                span = re.match(r'bytes=(\d*)-(\d*)', self.headers.get('Range') or '')
                if span is None:
                    meta['Content-Length'] = str(len(data))
                    self._send(200, data, meta)
                    return
                if span[1] == '':  # a suffix range: the last N bytes
                    start, end = max(len(data) - int(span[2]), 0), len(data) - 1
                else:
                    start = int(span[1])
                    end = min(int(span[2]) if span[2] else len(data) - 1, len(data) - 1)
                meta['Content-Range'] = f'bytes {start}-{end}/{len(data)}'
                self._send(206, data[start : end + 1], meta)

            do_GET = do_HEAD = _serve

            def log_message(self, *_args) -> None:  # keep pytest's output clean
                pass

        self._server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=10)


@pytest.fixture
def fake_s3():
    server = FakeS3()
    try:
        yield server
    finally:
        server.close()


def s3_connection(fake: FakeS3) -> duckdb.DuckDBPyConnection:
    """A DuckDB connection whose s3:// goes to `fake`. Skips the test where httpfs is not
    installed (it LOADs, never INSTALLs, and turns autoinstall off so LOAD cannot reach out)."""
    db = local_connection()
    try:
        db.execute('SET autoinstall_known_extensions = false')
        db.execute('SET autoload_known_extensions = false')
        db.execute('LOAD httpfs')
    except duckdb.Error as exc:
        db.close()
        pytest.skip(f'httpfs is not installed here: {exc}')
    db.execute(f"SET s3_endpoint='127.0.0.1:{fake.port}'")
    db.execute('SET s3_use_ssl = false')
    db.execute("SET s3_url_style = 'path'")
    db.execute("SET s3_region = 'auto'")
    db.execute("SET s3_access_key_id = 'fake'")
    db.execute("SET s3_secret_access_key = 'fake'")
    return db


# --- the replay day files and their tapes -----------------------------------------------------


def day_alert(
    day: date,
    clock: str = '15:00:00',
    *,
    ticker: str = 'SPXW',
    cp: str = 'C',
    spot: str | None = '6700.00',
    **fields: object,
) -> dict[str, object]:
    """One export row of `day`'s session: an alert of `ticker` that fired at `clock` UTC."""
    chain = f'{ticker}{day:%y%m%d}{cp}{6700 * 1000:08d}'
    return export_row(chain, clock, spot, expiry=day, **fields)


def write_day_file(
    path: Path,
    day: date,
    rows: list[dict[str, object]],
    *,
    rule: dict[str, str],
    footer: bytes | bool | None = None,
    footer_rows: int | None = None,
) -> str:
    """Write `rows` as a day file, with the `interval_ba` footer the replay module writes.
    `footer=False` leaves the footer out, and bytes are written as it, for a damaged one;
    `footer_rows` overrides the footer's row count."""
    meta = {
        'day': day.isoformat(),
        'rows': len(rows) if footer_rows is None else footer_rows,
        'rule': rule,
        'created_at': '2026-11-28T07:20:00+00:00',
    }
    if footer is False:
        schema = EXPORT_SCHEMA
    else:
        body = footer if isinstance(footer, bytes) else json.dumps(meta, sort_keys=True).encode()
        schema = EXPORT_SCHEMA.with_metadata({b'interval_ba': body})
    pq.write_table(pa.Table.from_pylist(rows, schema=schema), path)
    return path.as_posix()


class FakeR2Client:
    """The one call of a boto3 S3 client the readers' check makes: a `list_objects_v2` paginator
    over `objects` (key to LastModified), in pages of `page_size` keys. Setting `fail` makes the
    listing raise it, as a list does mid-iteration. `listed` records each prefix asked."""

    def __init__(self, page_size: int = 1000) -> None:
        self.objects: dict[str, datetime] = {}
        self.page_size = page_size
        self.fail: Exception | None = None
        self.listed: list[str] = []

    def get_paginator(self, name: str) -> Any:
        assert name == 'list_objects_v2'
        outer = self

        class Paginator:
            def paginate(self, *, Bucket: str, Prefix: str) -> Iterator[dict[str, Any]]:  # noqa: N803
                assert Bucket == 'bucket'
                outer.listed.append(Prefix)
                if outer.fail is not None:
                    raise outer.fail
                keys = sorted(k for k in outer.objects if k.startswith(Prefix))
                for start in range(0, max(len(keys), 1), outer.page_size):
                    yield {
                        'Contents': [
                            {'Key': k, 'LastModified': outer.objects[k]}
                            for k in keys[start : start + outer.page_size]
                        ]
                    }

        return Paginator()


class DayWorld:
    """The bucket the readers' check looks at, with nothing in it.

    `tape(day)` lands a tape (its LastModified the morning after, 07:45Z), `unavailable(day)`
    marks UW's not posting one, and `file(day)` writes the day's file as local Parquet and lists
    it (an hour after its tape, so it is not stale, or at `at=`). `write` stands in for the
    tool's `write_replay_days`: it writes each day's file, `alerts[day]` (default one SPXW alert)
    on the local rule, lists it at `now`, and returns the `DayFile`s the real one does; it raises
    `write_error` instead when that is set. `now` is the clock the readers' windows read,
    `guard` stands in for the deployed-code guard (it passes unless given a side effect), and
    `load_env` for the tool's env-file read, which gives `writer_env` (a copy of the reader's R2
    values, plus a DATABASE_URL, until a test changes it)."""

    def __init__(self, directory: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        self.dir = directory
        self.dir.mkdir(parents=True, exist_ok=True)
        self.client = FakeR2Client()
        self.rule = runs.ibr.rule()  # what the local replay module would write
        self.now = datetime(2026, 11, 28, 14, 0, tzinfo=UTC)  # Saturday 08:00 CT: outside both windows
        self.alerts: dict[date, list[dict[str, object]]] = {}
        self.write_error: Exception | None = None
        self.write = create_autospec(tool.write_replay_days, side_effect=self._write)
        # The deployed-code guard runs git against the real checkout: stood in for, so a test
        # makes it refuse by setting `guard.side_effect` (a RefusedError).
        self.guard = create_autospec(runs.refuse_unless_deployed_code)
        self.env = {
            'R2_BUCKET_FULLTAPE': 'bucket',
            'R2_ENDPOINT_URL': 'https://account.invalid',
            'R2_ACCESS_KEY_ID': 'key-id',
            'R2_SECRET_ACCESS_KEY': 'secret',
        }
        for name, value in self.env.items():
            monkeypatch.setenv(name, value)
        # What the tool's own `load_env` (the env file) gives the writer: the reader's values,
        # until a test changes `writer_env`. Stood in for, so no test reads a real .env.local.
        self.writer_env = {**self.env, 'DATABASE_URL': 'postgresql://user:pw@host.invalid/db'}
        self.load_env = create_autospec(
            runs.load_env, side_effect=lambda cli_path: dict(self.writer_env)
        )
        monkeypatch.setattr(runs, 'load_env', self.load_env)
        monkeypatch.setattr(days, 'day_url', self.url)
        monkeypatch.setattr(
            runs, 'r2_bucket', lambda env: runs.R2Bucket(self.client, env['R2_BUCKET_FULLTAPE'])
        )
        monkeypatch.setattr(runs, 'utc_now', lambda: self.now)
        monkeypatch.setattr(tool, 'write_replay_days', self.write)
        monkeypatch.setattr(runs, 'refuse_unless_deployed_code', self.guard)

    def url(self, day: date) -> str:
        return (self.dir / f'{day.isoformat()}.parquet').as_posix()

    @staticmethod
    def landed(day: date) -> datetime:
        """When a day's tape landed: 07:45Z the morning after."""
        return datetime.combine(day + timedelta(days=1), time(7, 45), tzinfo=UTC)

    def tape(self, *tape_days: date, at: datetime | None = None) -> None:
        for day in tape_days:
            self.client.objects[f'fulltape/{day.isoformat()}-fulltape.parquet'] = (
                at or self.landed(day)
            )

    def unavailable(self, *unposted: date) -> None:
        for day in unposted:
            self.client.objects[f'fulltape/_unavailable/{day.isoformat()}.json'] = self.landed(day)

    def file(
        self,
        day: date,
        alerts: list[dict[str, object]] | None = None,
        *,
        rule: dict[str, str] | None = None,
        at: datetime | None = None,
        **footer: Any,
    ) -> None:
        rows = [day_alert(day)] if alerts is None else alerts
        write_day_file(self.dir / f'{day.isoformat()}.parquet', day, rows, rule=rule or self.rule, **footer)
        self.client.objects[f'{days.DAYS_PREFIX}{day.isoformat()}.parquet'] = (
            at or self.landed(day) + timedelta(hours=1)
        )

    def full(self, *session_days: date) -> None:
        """Land each day's tape and write its file."""
        for day in session_days:
            self.tape(day)
            self.file(day, self.alerts.get(day))

    def _write(
        self,
        write_days: list[date],
        *,
        allow_market_hours: bool,
        env_file: str | None = None,
        out: Any = None,
    ) -> list[Any]:
        if self.write_error is not None:
            raise self.write_error
        done = []
        for day in write_days:
            rows = self.alerts.get(day, [day_alert(day)])
            self.file(day, rows, at=self.now)
            done.append(tool.DayFile(day, runs.ibr.day_key(day), len(rows), 1000, 'sha', 0))
        return done

    @property
    def written(self) -> list[date]:
        """Every day the stand-in was asked to write, in order."""
        return [day for call in self.write.call_args_list for day in call.args[0]]
