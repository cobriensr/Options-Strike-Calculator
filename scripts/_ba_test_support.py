"""Shared by the Interval B/A script tests: a replay export on disk, and a fake S3.

Used by test_enrich_interval_ba_outcomes.py, test_analyze_interval_ba_cuts.py and
test_analyze_confluence_vs_solo.py, so the export's schema and the fake bucket exist once.
Nothing here runs on its own (pytest collects only test_*.py).

- `EXPORT_SCHEMA`, `export_row` and `write_export` build a replay export with the export's columns
  (nightly/src/interval_ba_replay.py `EXPORT_COLUMNS`; test_export_columns_match_the_replay_module
  holds the copy to the module's own).
- `FakeS3` is a bucket on 127.0.0.1 for DuckDB's httpfs, started by the `fake_s3` fixture for one
  test and shut down in its teardown. `s3_connection` points a DuckDB connection at it and skips
  the test where httpfs is not installed.
"""

from __future__ import annotations

import http.server
import re
import threading
import urllib.parse
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import duckdb
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
