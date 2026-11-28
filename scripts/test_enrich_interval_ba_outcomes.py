"""scripts/enrich_interval_ba_outcomes.py: forward SPX paths for Interval B/A alerts, from the tape.

Each test runs the script's real SQL over a small tape written in tmp_path, in both tape layouts
(2026-11-24 tape facts: before 2026-05-04 `executed_at` is a naive TIMESTAMP holding UTC and the
prices are DECIMAL(18,4); from then on TIMESTAMPTZ and DOUBLE). The DuckDB connection runs under
a non-UTC session time zone, so a naive column read through the session zone would shift.

The boundaries are patched (R3, and the scripts conftest blocks both stores):
- `fulltape_connection` returns a local DuckDB connection, `r2_url` and `export_url` the local
  files' paths;
- `psycopg2.connect` returns a fake connection whose cursor hands back the table rows;
- `load_env` does nothing and `OUT_DIR` is a folder in tmp_path;
- the day files go through a `DayWorld` (scripts/_ba_test_support.py), which patches the R2
  listing, the day files' URLs and the tool's `write_replay_days`.

The `s3://` tests below keep `r2_url` and `export_url` real. They point DuckDB's httpfs at a
fake S3 on 127.0.0.1 that a fixture starts for the test and shuts down in its teardown, so the
missing-object probe meets the HTTP statuses a bucket gives (DuckDB's glob() would not: it
answers 1 for any single s3:// key without asking). They skip when httpfs is not installed.

Run from the repo root with the ml venv:

    ml/.venv/Scripts/python -m pytest scripts/test_enrich_interval_ba_outcomes.py -q
"""

from __future__ import annotations

import csv
import sys
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import duckdb
import psycopg2
import pyarrow as pa
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _interval_ba_days as days
import enrich_interval_ba_outcomes as mod  # noqa: E402
from _ba_test_support import (  # noqa: E402
    DAY,
    DAY_ISO,
    EPOCH,
    EXPORT_SCHEMA,
    DayWorld,
    at,
    day_alert,
    export_row,
    fake_s3,  # noqa: F401  (a fixture: pytest finds it by name)
    local_connection,
    s3_connection,
    write_export,
)

CLOSE = datetime(2026, 11, 17, 21, 0, tzinfo=UTC)

SPXW_C = 'SPXW261117C06700000'
SPXW_P = 'SPXW261117P06600000'
SPX_C = 'SPX261117C06700000'  # root SPX: another product
SPY_C = 'SPY261117C00670000'

LAYOUTS = ['naive', 'tz']


# --- the tape ---------------------------------------------------------------------------------


def tick(
    clock: str,
    chain: str,
    spot: str | None,
    *,
    label: str | None = None,
    canceled: bool = False,
    day: date = DAY,
) -> dict[str, object]:
    """One tape row of `day`. The underlying_symbol label defaults to the OCC root."""
    return {
        'at': at(clock, day),
        'chain': chain,
        'label': label if label is not None else chain[:-15],
        'spot': spot,
        'canceled': canceled,
    }


_LAYOUT_SQL = {
    'naive': ('TIMESTAMP', 'DECIMAL(18,4)', 'make_timestamp($us)'),
    'tz': ('TIMESTAMPTZ', 'DOUBLE', "timezone('UTC', make_timestamp($us))"),
}


def write_tape(
    tmp_path: Path, rows: list[dict[str, object]], layout: str = 'tz', day: date = DAY
) -> str:
    """Write the rows, in list order, as `day`'s Full Tape parquet and return its path.

    The time goes in as epoch microseconds, so the stored instant is exact: make_timestamp
    gives the naive UTC wall clock, and timezone('UTC', ...) the same instant as a TIMESTAMPTZ.
    """
    time_type, number, time_sql = _LAYOUT_SQL[layout]
    path = tmp_path / f'{day.isoformat()}-fulltape.parquet'
    db = duckdb.connect()
    try:
        db.execute(
            f'CREATE TABLE tape (n INTEGER, executed_at {time_type}, option_chain_id VARCHAR,'
            f' underlying_symbol VARCHAR, underlying_price {number}, canceled BOOLEAN)'
        )
        for n, row in enumerate(rows):
            assert isinstance(row['at'], datetime)
            db.execute(
                f'INSERT INTO tape VALUES ($n, {time_sql}, $chain, $label,'
                f' CAST($spot AS {number}), $canceled)',
                {
                    'n': n,
                    'us': (row['at'] - EPOCH) // timedelta(microseconds=1),
                    'chain': row['chain'],
                    'label': row['label'],
                    'spot': row['spot'],
                    'canceled': row['canceled'],
                },
            )
        db.execute(
            f"COPY (SELECT * EXCLUDE (n) FROM tape ORDER BY n) TO '{path.as_posix()}'"
            ' (FORMAT parquet)'
        )
    finally:
        db.close()
    return path.as_posix()


@pytest.fixture
def con():
    db = local_connection()
    yield db
    db.close()


def path_for(db, tape: str, chain: str, fired_at: datetime, entry: float):
    """The forward path of an alert, from the script's own reader over the tape."""
    series = mod.load_root_spot_series(db, tape, chain[:-15])
    return mod.build_forward_path(series, fired_at, entry, CLOSE)


# --- t=0 and the forward steps ------------------------------------------------------------------


@pytest.mark.parametrize('layout', LAYOUTS)
def test_t0_is_last_print_at_or_before_fired_at(tmp_path, con, layout):
    tape = write_tape(
        tmp_path,
        [
            tick('14:30:10', SPXW_C, '6700.00'),
            tick('14:30:44.999999', SPXW_C, '6700.50'),
            tick('14:30:45', SPXW_C, '6701.00'),  # exactly at fired_at: it counts (<=)
            tick('14:30:45.000001', SPXW_C, '6702.00'),  # a microsecond later: it does not
            tick('14:30:50', SPXW_C, '6703.00'),  # last of the minute: the old t=0
        ],
        layout,
    )
    fired_at = at('14:30:45')

    first = path_for(con, tape, SPXW_C, fired_at, 6701.0)[0]

    assert first == (0, fired_at, 6701.0, 0.0)


@pytest.mark.parametrize('layout', LAYOUTS)
def test_t0_is_the_roots_last_print_not_only_the_alerts_own_contracts(tmp_path, con, layout):
    tape = write_tape(
        tmp_path,
        [
            tick('14:30:40', SPXW_C, '6700.00'),
            tick('14:30:44', SPXW_P, '6699.00'),  # a later print of another contract: it wins
            tick('14:30:44.5', SPY_C, '670.00'),  # a print of another root: never read
        ],
        layout,
    )

    first = path_for(con, tape, SPXW_C, at('14:30:45'), 6700.0)[0]

    assert first[2] == 6699.0


@pytest.mark.parametrize('layout', LAYOUTS)
def test_forward_steps_sit_k_times_five_minutes_after_the_alert(tmp_path, con, layout):
    tape = write_tape(
        tmp_path,
        [
            tick('14:30:45', SPXW_C, '6701.00'),
            tick('14:35:44', SPXW_P, '6710.00'),
            tick('14:35:45', SPXW_P, '6711.00'),  # exactly at the step: counts, and is last
            tick('14:35:45.000001', SPXW_C, '6720.00'),  # just after the step
            tick('14:36:30', SPXW_C, '6730.00'),  # the end of that minute: the old t=5
        ],
        layout,
    )

    path = path_for(con, tape, SPXW_C, at('14:30:45'), 6701.0)

    # Steps after t=0 read every contract of the root, not only the alert's own: the print
    # at the step is SPXW_P's, and SPXW_C has nothing at or before 14:35:45 but its first.
    assert path[1] == (5, at('14:35:45'), 6711.0, (6711.0 - 6701.0) / 6701.0 * 100.0)
    # Nothing prints after 14:36:30: the last print carries forward to later steps.
    assert path[2][:3] == (10, at('14:40:45'), 6730.0)


@pytest.mark.parametrize('layout', LAYOUTS)
def test_the_path_ends_at_the_close_and_includes_it(tmp_path, con, layout):
    tape = write_tape(
        tmp_path,
        [
            tick('20:50:00', SPXW_C, '6701.00'),
            tick('20:54:00', SPXW_C, '6710.00'),
            tick('20:59:59.999999', SPXW_C, '6720.00'),
            tick('21:00:00', SPXW_C, '6725.00'),
            tick('21:00:00.000001', SPXW_C, '6730.00'),
        ],
        layout,
    )

    on_the_close = path_for(con, tape, SPXW_C, at('20:50:00'), 6701.0)
    past_the_close = path_for(con, tape, SPXW_C, at('20:50:01'), 6701.0)

    assert [(t, spot) for t, _, spot, _ in on_the_close] == [(0, 6701.0), (5, 6710.0), (10, 6725.0)]
    assert on_the_close[-1][1] == CLOSE
    assert [t for t, *_ in past_the_close] == [0, 5]  # 21:00:01 is after the close


@pytest.mark.parametrize('layout', LAYOUTS)
def test_a_contracts_first_print_after_the_alert_still_leaves_a_t0_from_the_root(
    tmp_path, con, layout
):
    tape = write_tape(
        tmp_path,
        [
            tick('20:49:00', SPXW_P, '6700.00'),
            tick('20:50:30', SPXW_C, '6701.00'),  # the alert's own contract prints first here
            tick('20:55:00', SPXW_P, '6710.00'),
        ],
        layout,
    )

    path = path_for(con, tape, SPXW_C, at('20:50:00'), 6700.0)

    assert [(t, spot) for t, _, spot, _ in path] == [(0, 6700.0), (5, 6710.0), (10, 6710.0)]


@pytest.mark.parametrize('layout', LAYOUTS)
def test_no_root_print_at_or_before_the_alert_leaves_no_t0_but_later_steps(
    tmp_path, con, layout
):
    tape = write_tape(
        tmp_path,
        [tick('20:50:30', SPXW_C, '6701.00'), tick('20:55:00', SPXW_P, '6710.00')],
        layout,
    )

    path = path_for(con, tape, SPXW_C, at('20:50:00'), 6700.0)

    assert [(t, spot) for t, _, spot, _ in path] == [(5, 6710.0), (10, 6710.0)]


# --- the tape's readers -------------------------------------------------------------------------


@pytest.mark.parametrize('layout', LAYOUTS)
def test_spxw_selected_by_occ_root_not_underlying_symbol(tmp_path, con, layout):
    tape = write_tape(
        tmp_path,
        [
            tick('14:30:00', SPXW_C, '6701.00', label='SPX'),  # SPXW root, labeled SPX: kept
            tick('14:31:00', SPXW_P, '6702.00'),  # SPXW root, labeled SPXW: kept
            tick('14:32:00', SPX_C, '6000.00'),  # SPX root, labeled SPX: another product
            tick('14:33:00', SPX_C, '6001.00', label='SPXW'),  # SPX root, labeled SPXW: dropped
            tick('14:34:00', SPY_C, '670.00'),
        ],
        layout,
    )

    spxw = mod.load_root_spot_series(con, tape, 'SPXW')
    spy = mod.load_root_spot_series(con, tape, 'SPY')

    assert spxw.spot.tolist() == [6701.0, 6702.0]
    assert spy.spot.tolist() == [670.0]


@pytest.mark.parametrize('layout', LAYOUTS)
def test_series_read_epoch_microseconds_whatever_the_layout_and_session_zone(
    tmp_path, con, layout
):
    tape = write_tape(tmp_path, [tick('14:30:00.123456', SPXW_C, '6701.00')], layout)
    print_us = (at('14:30:00.123456') - EPOCH) // timedelta(microseconds=1)

    series = mod.load_root_spot_series(con, tape, 'SPXW')

    assert series.us.tolist() == [print_us]
    assert series.at_or_before(print_us) == 6701.0
    assert series.at_or_before(print_us - 1) is None


def test_the_readers_skip_canceled_prints_and_prints_with_no_usable_spot(tmp_path, con):
    tape = write_tape(
        tmp_path,
        [
            tick('14:30:00', SPXW_C, '6701.00'),
            tick('14:30:01', SPXW_C, '6999.00', canceled=True),
            tick('14:30:02', SPXW_C, None),
            tick('14:30:03', SPXW_C, '0.00'),
            tick('14:30:04', SPXW_C, 'NaN'),  # DuckDB sorts NaN above every number
            tick('14:30:05', SPXW_C, 'Infinity'),
            tick('14:30:06', SPXW_C, '6702.00'),
        ],
    )

    series = mod.load_root_spot_series(con, tape, 'SPXW')

    assert series.spot.tolist() == [6701.0, 6702.0]
    # At 14:30:05 the last usable print is the 14:30:00 one.
    assert series.at_or_before(mod.epoch_us(at('14:30:05'))) == 6701.0


def test_a_text_canceled_column_reads_like_a_boolean_one(tmp_path, con):
    """Tapes uploaded from the old archive may hold 't' / 'f' text in `canceled`."""
    path = (tmp_path / 'text-canceled.parquet').as_posix()
    con.execute(
        f"""
        COPY (
            SELECT * FROM (VALUES
                (TIMESTAMP '2026-11-17 14:30:00', '{SPXW_C}', 6701.0, 'f'),
                (TIMESTAMP '2026-11-17 14:30:01', '{SPXW_C}', 6999.0, 't'),
                (TIMESTAMP '2026-11-17 14:30:02', '{SPXW_C}', 6702.0, '')
            ) AS tape(executed_at, option_chain_id, underlying_price, canceled)
        ) TO '{path}' (FORMAT parquet)
        """
    )

    assert mod.load_root_spot_series(con, path, 'SPXW').spot.tolist() == [6701.0, 6702.0]


def test_same_microsecond_prints_keep_file_order_so_the_later_row_is_last(tmp_path, con):
    tape = write_tape(
        tmp_path,
        [
            tick('14:30:00', SPXW_C, '6701.00'),
            tick('14:30:00', SPXW_C, '6702.00'),
            tick('14:30:00', SPXW_P, '6703.00'),
        ],
    )

    series = mod.load_root_spot_series(con, tape, 'SPXW')

    assert series.at_or_before(mod.epoch_us(at('14:30:00'))) == 6703.0


def test_a_root_is_not_taken_for_a_longer_root_that_starts_with_it(tmp_path, con):
    """The LIKE prefix pre-filter would also pass SPXWS and SPYG: the exact match drops them."""
    tape = write_tape(
        tmp_path,
        [
            tick('14:30:00', 'SPY261117C00670000', '670.00'),
            tick('14:30:01', 'SPYG261117C00100000', '100.00'),
            tick('14:30:02', 'SPXWS261117C06700000', '6000.00'),
            tick('14:30:03', SPXW_C, '6701.00'),
        ],
    )

    assert mod.load_root_spot_series(con, tape, 'SPY').spot.tolist() == [670.0]
    assert mod.load_root_spot_series(con, tape, 'SPXW').spot.tolist() == [6701.0]


# --- is the object there ------------------------------------------------------------------------


def test_object_exists_says_whether_a_local_file_is_there(tmp_path, con):
    tape = write_tape(tmp_path, [tick('14:30:00', SPXW_C, '6701.00')])

    assert mod.object_exists(con, tape) is True
    assert mod.object_exists(con, (tmp_path / 'missing.parquet').as_posix()) is False


def test_object_exists_does_not_take_a_corrupt_file_for_a_missing_one(tmp_path, con):
    path = tmp_path / 'corrupt.parquet'
    path.write_bytes(b'not a parquet file')

    with pytest.raises(duckdb.Error):
        mod.object_exists(con, path.as_posix())


def _http_error(status: str) -> duckdb.HTTPException:
    return duckdb.HTTPException(f"HTTP Error: HTTP GET error reading 's3://b/k' (HTTP {status})")


@pytest.mark.parametrize(
    ('error', 'missing'),
    [
        (_http_error('404 Not Found'), True),
        (duckdb.IOException('IO Error: No files found that match the pattern "/x/y"'), True),
        (_http_error('403 Forbidden'), False),
        (_http_error('503 Service Unavailable'), False),
        (duckdb.IOException('IO Error: Could not establish connection error'), False),
    ],
)
def test_object_exists_takes_only_a_404_for_missing_and_raises_every_other_failure(
    error, missing
):
    """The fallback for a machine with no httpfs: the errors the loopback tests below get."""
    con = MagicMock()
    con.execute.side_effect = error

    if missing:
        assert mod.object_exists(con, 's3://b/k') is False
    else:
        with pytest.raises(type(error)):
            mod.object_exists(con, 's3://b/k')


# --- the two sources ------------------------------------------------------------------------------

# The replay export's schema, export_row and write_export are in _ba_test_support (shared with the
# analyze scripts' tests). test_export_columns_match_the_replay_module holds the schema copy to
# the replay module's EXPORT_COLUMNS.

TABLE_COLUMNS = (
    'id',
    'option_chain',
    'ticker',
    'option_type',
    'strike',
    'expiry',
    'fired_at',
    'ratio_pct',
    'total_premium',
    'trade_count',
    'underlying_price',
    'top_trade_is_sweep',
    'top_trade_is_floor',
)


def table_row(
    alert_id: int,
    chain: str,
    fired_clock: str,
    spot: str | None,
    *,
    total: str = '300000.00',
) -> dict[str, object]:
    """A row as psycopg2 hands it back from interval_ba_alerts."""
    return {
        'id': alert_id,
        'option_chain': chain,
        'ticker': chain[:-15],
        'option_type': chain[-9],
        'strike': Decimal('6700.000'),
        'expiry': DAY,
        'fired_at': at(fired_clock),
        'ratio_pct': Decimal('80.00'),
        'total_premium': Decimal(total),
        'trade_count': 3,
        'underlying_price': Decimal(spot) if spot is not None else None,
        'top_trade_is_sweep': False,
        'top_trade_is_floor': False,
    }


def fake_table(monkeypatch, rows: list[dict[str, object]]) -> MagicMock:
    """psycopg2.connect returns a connection whose cursor hands back the rows. Returns the
    cursor, so a test can read the SQL it was given."""
    cur = MagicMock()
    cur.description = [SimpleNamespace(name=name) for name in TABLE_COLUMNS]
    cur.fetchall.return_value = [tuple(row[name] for name in TABLE_COLUMNS) for row in rows]
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    monkeypatch.setattr(psycopg2, 'connect', MagicMock(return_value=conn))
    monkeypatch.setenv('DATABASE_URL', 'postgresql://fake.invalid/none')
    return cur


def test_export_alerts_have_the_tables_keys_and_types(tmp_path, con, monkeypatch):
    url = write_export(tmp_path, [export_row(SPXW_C, '20:50:00', '6701.00')])
    cur = fake_table(monkeypatch, [table_row(7, SPXW_C, '20:50:00', '6701.00')])

    from_export = days.fetch_alerts(con, url, 'SPXW', None, None, None)
    from_table = mod.fetch_alerts(psycopg2.connect(), 'SPXW', None, None, None)

    assert cur.execute.called
    assert len(from_export) == len(from_table) == 1
    export_alert, table_alert = from_export[0], from_table[0]
    assert set(export_alert) == set(table_alert)
    for key, value in table_alert.items():
        if key != 'id':
            assert export_alert[key] == value, key
            assert type(export_alert[key]) is type(value), key
    assert table_alert['id'] == 7
    # The export has no ids; its key is the table's unique key, the contract and the bucket.
    bucket_s = int(at('20:50:00').timestamp()) // 300 * 300
    assert export_alert['id'] == f'{SPXW_C}@{bucket_s}'


def test_export_filters_by_ticker_expiry_and_limit_in_fired_order(tmp_path, con):
    other_day = DAY + timedelta(days=1)
    url = write_export(
        tmp_path,
        [
            export_row(SPXW_C, '20:55:00', '6710.00'),
            export_row(SPXW_P, '20:50:00', '6701.00'),
            export_row(SPY_C, '20:51:00', '670.00'),
            export_row('SPXW261118C06700000', '15:00:00', '6700.00', expiry=other_day),
        ],
    )

    both_days = days.fetch_alerts(con, url, 'SPXW', None, None, None)
    one_day = days.fetch_alerts(con, url, 'SPXW', DAY_ISO, DAY_ISO, None)
    first = days.fetch_alerts(con, url, 'SPXW', DAY_ISO, DAY_ISO, 1)

    assert [a['option_chain'] for a in both_days] == [SPXW_P, SPXW_C, 'SPXW261118C06700000']
    assert [a['option_chain'] for a in one_day] == [SPXW_P, SPXW_C]
    assert [a['option_chain'] for a in first] == [SPXW_P]


def test_export_reads_every_ticker_in_one_call_when_none_is_named(tmp_path, con):
    url = write_export(
        tmp_path,
        [
            export_row(SPXW_C, '20:55:00', '6710.00'),
            export_row(SPY_C, '20:51:00', '670.00'),
            export_row('QQQ261117P00590000', '20:52:00', '590.00'),
        ],
    )

    alerts = days.fetch_alerts(con, url, None, None, None, None)

    assert [a['ticker'] for a in alerts] == ['SPY', 'QQQ', 'SPXW']  # in fired order


def test_export_alerts_carry_both_top_trade_flags(tmp_path, con):
    url = write_export(
        tmp_path,
        [
            export_row(SPXW_C, '20:50:00', '6701.00', top_trade_is_sweep=True),
            export_row(SPXW_P, '20:51:00', '6701.00', top_trade_is_floor=True),
        ],
    )

    alerts = days.fetch_alerts(con, url, 'SPXW', None, None, None)

    assert [(a['top_trade_is_sweep'], a['top_trade_is_floor']) for a in alerts] == [
        (True, False),
        (False, True),
    ]


def test_table_fetch_does_not_drop_rows_with_a_null_spot(monkeypatch):
    cur = fake_table(monkeypatch, [table_row(1, SPXW_C, '20:50:00', None)])

    alerts = mod.fetch_alerts(psycopg2.connect(), 'SPXW', '2026-11-17', None, None)

    sql, params = cur.execute.call_args.args
    assert 'underlying_price IS NOT NULL' not in sql
    assert params == ['SPXW', '2026-11-17']
    assert alerts[0]['underlying_price'] is None


@pytest.fixture
def run(monkeypatch, tmp_path):
    """main() with the boundaries patched. Returns tmp_path, the folder the tape, the export
    and the output live in."""
    opened: list[duckdb.DuckDBPyConnection] = []

    def connect(**_limits):
        db = local_connection()
        opened.append(db)
        return db

    monkeypatch.setattr(mod, 'load_env', lambda: None)
    monkeypatch.setattr(mod, 'OUT_DIR', tmp_path / 'out')
    monkeypatch.setattr(mod, 'fulltape_connection', connect)
    monkeypatch.setattr(
        mod, 'r2_url', lambda day: (tmp_path / f'{day}-fulltape.parquet').as_posix()
    )
    monkeypatch.setattr(
        mod, 'export_url', lambda end: (tmp_path / f'replay-{end}.parquet').as_posix()
    )
    yield tmp_path
    for db in opened:
        db.close()


@pytest.fixture
def day_world(tmp_path, monkeypatch) -> DayWorld:
    return DayWorld(tmp_path / 'days', monkeypatch)


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def outcome_csv(out: Path, *, export: bool = False, days: bool = False) -> Path:
    kind = '-days' if days else '-export' if export else ''
    (path,) = out.glob(f'interval-ba-outcomes{kind}-2*.csv')
    return path


# An alert near the close, so its path is three points: t=0, 5 and 10 (21:00:00).
CLOSE_TAPE = [
    tick('20:49:30', SPXW_C, '6700.00'),
    tick('20:50:00', SPXW_C, '6701.00'),  # the crossing tick
    tick('20:55:00', SPXW_P, '6710.00'),
    tick('20:59:59', SPXW_P, '6720.00'),
    tick('21:00:00.500', SPXW_P, '6730.00'),  # after the last step
]


@pytest.mark.parametrize('layout', LAYOUTS)
def test_reads_the_table_or_the_export_schema(run, monkeypatch, layout):
    write_tape(run, CLOSE_TAPE, layout)
    write_export(run, [export_row(SPXW_C, '20:50:00', '6701.00')])
    fake_table(monkeypatch, [table_row(7, SPXW_C, '20:50:00', '6701.00')])

    assert mod.main(['--source', 'table']) == 0
    assert mod.main(['--source', 'export', '--export-end', DAY_ISO]) == 0

    assert psycopg2.connect.call_count == 1  # the export source never opens the database
    from_table = read_rows(outcome_csv(run / 'out'))
    from_export = read_rows(outcome_csv(run / 'out', export=True))
    bucket_s = int(at('20:50:00').timestamp()) // 300 * 300
    assert {r['alert_id'] for r in from_table} == {'7'}
    assert {r['alert_id'] for r in from_export} == {f'{SPXW_C}@{bucket_s}'}
    assert [{k: v for k, v in r.items() if k != 'alert_id'} for r in from_table] == [
        {k: v for k, v in r.items() if k != 'alert_id'} for r in from_export
    ]
    assert [(r['t_minutes'], r['spx_price'], r['pct_change']) for r in from_table] == [
        ('0', '6701.00', '0.0000'),
        ('5', '6710.00', '0.1343'),
        ('10', '6720.00', '0.2835'),
    ]
    assert list(from_table[0]) == [
        'alert_id',
        'option_chain',
        'option_type',
        'severity',
        'fired_at',
        't_minutes',
        'ts_utc',
        'spx_price',
        'pct_change',
    ]
    assert from_table[0]['severity'] == 'warning'
    assert from_table[0]['fired_at'] == '2026-11-17T20:50:00+00:00'
    assert from_table[2]['ts_utc'] == '2026-11-17T21:00:00+00:00'


def test_the_summary_names_its_source_and_what_it_skipped(run, monkeypatch):
    write_tape(run, CLOSE_TAPE)
    fake_table(
        monkeypatch,
        [
            table_row(1, SPXW_C, '20:50:00', '6701.00', total='1500000.00'),
            table_row(2, SPXW_P, '20:40:00', None),  # no spot, and the tape starts at 20:49:30
        ],
    )

    mod.main(['--source', 'table'])

    (summary,) = (run / 'out').glob('interval-ba-outcomes-summary-2*.md')
    text = summary.read_text(encoding='utf-8')
    assert 'Source: table' in text
    assert '1 skipped (no spot in the row or on the tape)' in text
    assert '0 fired after the close, no path' in text
    assert '| extreme | C | 1 |' in text


def test_other_tickers_read_their_own_root_and_write_their_own_file(run, monkeypatch):
    write_tape(
        run,
        [
            tick('20:50:00', SPY_C, '670.00'),
            tick('20:55:00', SPY_C, '671.00'),
            tick('20:55:00', SPXW_C, '6710.00'),
        ],
    )
    fake_table(monkeypatch, [table_row(5, SPY_C, '20:50:00', '670.00')])

    mod.main(['--source', 'table', '--ticker', 'spy'])

    (path,) = (run / 'out').glob('interval-ba-outcomes-spy-2*.csv')
    assert [(r['t_minutes'], r['spx_price']) for r in read_rows(path)] == [
        ('0', '670.00'),
        ('5', '671.00'),
        ('10', '671.00'),
    ]


def test_a_dry_run_writes_nothing(run, monkeypatch):
    write_tape(run, CLOSE_TAPE)
    fake_table(monkeypatch, [table_row(1, SPXW_C, '20:50:00', '6701.00')])

    assert mod.main(['--source', 'table', '--dry-run']) == 0

    assert not list((run / 'out').glob('*'))


def test_rows_with_null_spot_are_skipped_only_when_the_tape_has_none(run, monkeypatch, capsys):
    write_tape(run, CLOSE_TAPE)
    fake_table(
        monkeypatch,
        [
            # NULL spot, and the root printed at or before the alert: that print is the entry.
            table_row(1, SPXW_C, '20:50:00', None),
            # NULL spot, and the alert's own contract has not printed yet, but the root has:
            # the tape does have a spot, so the row stays and takes the root's.
            table_row(2, SPXW_P, '20:50:00', None),
            # A spot in the row: it is the entry, the tape's print is only t=0.
            table_row(3, SPXW_P, '20:50:00', '6705.00'),
            # NULL spot, and nothing on the root at or before the alert: the tape has none.
            table_row(4, SPXW_C, '20:40:00', None),
        ],
    )

    mod.main(['--source', 'table'])

    rows = read_rows(outcome_csv(run / 'out'))
    by_alert: dict[str, list[tuple[str, str, str]]] = {}
    for r in rows:
        by_alert.setdefault(r['alert_id'], []).append(
            (r['t_minutes'], r['spx_price'], r['pct_change'])
        )
    assert set(by_alert) == {'1', '2', '3'}
    # The entry is the root's last print at or before 20:50:00, which is t=0 too: t=0 sits at 0.
    assert by_alert['1'][:2] == [('0', '6701.00', '0.0000'), ('5', '6710.00', '0.1343')]
    assert by_alert['2'] == by_alert['1']
    # Against the row's own 6705.00, t=0 (6701.00) is below the entry.
    assert by_alert['3'][:2] == [('0', '6701.00', '-0.0597'), ('5', '6710.00', '0.0746')]
    assert '1 skipped (no spot in the row or on the tape)' in capsys.readouterr().out


@pytest.mark.parametrize('bad_spot', ['0.00', '-5.00', 'NaN'])
def test_a_row_spot_that_is_not_finite_and_above_zero_counts_as_missing(
    run, monkeypatch, bad_spot
):
    write_tape(run, CLOSE_TAPE)
    fake_table(monkeypatch, [table_row(1, SPXW_C, '20:50:00', bad_spot)])

    mod.main(['--source', 'table'])

    rows = read_rows(outcome_csv(run / 'out'))
    # The tape's 6701.00 is the entry, so t=0 sits at 0, with no ZeroDivisionError or 'nan'.
    assert [(r['t_minutes'], r['pct_change']) for r in rows] == [
        ('0', '0.0000'),
        ('5', '0.1343'),
        ('10', '0.2835'),
    ]


def test_alerts_fired_after_the_close_are_counted_apart_from_the_no_spot_skips(
    run, monkeypatch, capsys
):
    write_tape(run, [tick('20:50:00', SPY_C, '670.00'), tick('21:05:00', SPY_C, '672.00')])
    fake_table(
        monkeypatch,
        [
            table_row(1, SPY_C, '20:50:00', '670.00'),
            table_row(2, SPY_C, '21:05:00', '672.00'),  # 15:05 CT: SPY options trade to 15:15
            table_row(3, SPY_C, '20:30:00', None),  # no spot, and no print before it
        ],
    )

    mod.main(['--source', 'table', '--ticker', 'SPY'])

    (path,) = (run / 'out').glob('interval-ba-outcomes-spy-2*.csv')
    assert {r['alert_id'] for r in read_rows(path)} == {'1'}
    out = capsys.readouterr().out
    assert 'skipped=1  after_close=1' in out
    assert '1 skipped (no spot in the row or on the tape); 1 fired after the close, no path' in out


def test_a_missing_tape_day_is_skipped_by_name_and_the_other_days_still_run(
    run, monkeypatch, capsys
):
    write_tape(run, CLOSE_TAPE)
    next_day = DAY + timedelta(days=1)
    row = table_row(2, 'SPXW261118C06700000', '20:50:00', '6701.00')
    row['expiry'] = next_day
    fake_table(monkeypatch, [table_row(1, SPXW_C, '20:50:00', '6701.00'), row])

    assert mod.main(['--source', 'table']) == 0

    assert {r['alert_id'] for r in read_rows(outcome_csv(run / 'out'))} == {'1'}
    out = capsys.readouterr().out
    assert f'{next_day.isoformat()}  SKIP: tape not in R2' in out
    assert f'{DAY_ISO}  alerts=   1' in out


def test_a_day_with_no_prints_of_the_root_is_skipped_while_another_day_is_read(
    run, monkeypatch, capsys
):
    write_tape(run, CLOSE_TAPE)
    next_day = DAY + timedelta(days=1)
    write_tape(run, [tick('20:50:00', SPY_C, '670.00')], day=next_day)  # no SPXW print
    row = table_row(2, 'SPXW261118C06700000', '20:50:00', '6701.00')
    row['expiry'] = next_day
    fake_table(monkeypatch, [table_row(1, SPXW_C, '20:50:00', '6701.00'), row])

    assert mod.main(['--source', 'table']) == 0

    assert {r['alert_id'] for r in read_rows(outcome_csv(run / 'out'))} == {'1'}
    out = capsys.readouterr().out
    assert f'{next_day.isoformat()}  SKIP: no SPXW prints on the tape' in out
    assert f'{DAY_ISO}  alerts=   1' in out


def test_a_run_that_read_no_day_exits_non_zero_and_leaves_no_csv_or_md(run, monkeypatch):
    """A 404 also answers a wrong bucket or endpoint: all days "missing" must not look valid."""
    next_day = DAY + timedelta(days=1)
    write_tape(run, [tick('20:50:00', SPY_C, '670.00')], day=next_day)  # no SPXW print
    row = table_row(2, 'SPXW261118C06700000', '20:50:00', '6701.00')
    row['expiry'] = next_day
    fake_table(monkeypatch, [table_row(1, SPXW_C, '20:50:00', '6701.00'), row])  # DAY: no tape

    with pytest.raises(SystemExit, match=r'No day read: all 2 day\(s\) were skipped'):
        mod.main(['--source', 'table'])

    out = run / 'out'
    assert not list(out.glob('*.csv'))
    assert not list(out.glob('*.md'))
    assert len(list(out.glob('interval-ba-outcomes-2*.csv.partial'))) == 1


@pytest.mark.parametrize('days', [1, 3])
def test_a_run_whose_every_day_is_missing_from_the_bucket_exits_non_zero(
    run, monkeypatch, days
):
    rows = []
    for n in range(days):
        day = DAY + timedelta(days=n)
        row = table_row(n + 1, f'SPXW{day:%y%m%d}C06700000', '20:50:00', '6701.00')
        row['expiry'] = day
        rows.append(row)
    fake_table(monkeypatch, rows)

    with pytest.raises(SystemExit, match=rf'No day read: all {days} day\(s\) were skipped'):
        mod.main(['--source', 'table'])

    assert not list((run / 'out').glob('*.csv'))
    assert not list((run / 'out').glob('*.md'))


def test_an_unreadable_tape_stops_the_run_instead_of_reading_as_a_missing_day(
    run, monkeypatch
):
    (run / f'{DAY_ISO}-fulltape.parquet').write_bytes(b'not a parquet file')
    fake_table(monkeypatch, [table_row(1, SPXW_C, '20:50:00', '6701.00')])

    with pytest.raises(duckdb.Error):
        mod.main(['--source', 'table'])

    # The run died with its CSV open: it is under a .partial name, so no `*.csv` is left for
    # the analyze_* scripts' newest-file discovery to pick up.
    out = run / 'out'
    assert not list(out.glob('*.csv'))
    assert len(list(out.glob('interval-ba-outcomes-2*.csv.partial'))) == 1


def test_a_finished_run_leaves_a_csv_and_an_md_and_no_partial_file(run, monkeypatch):
    write_tape(run, CLOSE_TAPE)
    fake_table(monkeypatch, [table_row(1, SPXW_C, '20:50:00', '6701.00')])

    mod.main(['--source', 'table'])

    assert sorted(p.suffix for p in (run / 'out').iterdir()) == ['.csv', '.md']


def test_a_run_that_dies_building_the_summary_leaves_neither_file_for_discovery(
    run, monkeypatch
):
    write_tape(run, CLOSE_TAPE)
    fake_table(monkeypatch, [table_row(1, SPXW_C, '20:50:00', '6701.00')])
    monkeypatch.setattr(mod, 'median', MagicMock(side_effect=RuntimeError('boom')))

    with pytest.raises(RuntimeError, match='boom'):
        mod.main(['--source', 'table'])

    out = run / 'out'
    assert not list(out.glob('*.md'))
    assert not list(out.glob('*.csv'))
    assert len(list(out.glob('*.csv.partial'))) == 1  # the finished rows, kept for a look


def test_no_matching_alerts_exits_with_a_message(run, monkeypatch):
    fake_table(monkeypatch, [])

    with pytest.raises(SystemExit, match='No alerts matched the filter'):
        mod.main(['--source', 'table'])


@pytest.mark.parametrize(
    'argv',
    [
        ['--source', 'table', '--export-end', DAY_ISO],  # an end date the table ignores
        ['--source', 'days', '--export-end', DAY_ISO],  # nor do the day files
        ['--source', 'export', '--export-end', '2026-13-45'],  # not a date
        ['--from-date', '2026-13-45'],  # not a date
        ['--to-date', 'yesterday'],
        ['--source', 'files'],
    ],
)
def test_bad_source_flags_are_refused_before_anything_runs(run, argv):
    with pytest.raises(SystemExit) as stopped:
        mod.main(argv)

    assert stopped.value.code == 2
    assert not (run / 'out').exists()


def test_a_missing_export_names_the_key_it_looked_for(run):
    with pytest.raises(SystemExit, match='research/interval-ba/replay-2026-11-17.parquet'):
        mod.main(['--source', 'export', '--export-end', DAY_ISO])


def test_export_end_with_table_source_exits_2(run):
    with pytest.raises(SystemExit) as stopped:
        mod.main(['--source', 'table', '--export-end', DAY_ISO])

    assert stopped.value.code == 2
    assert not (run / 'out').exists()


def never_open_the_database(monkeypatch) -> MagicMock:
    """psycopg2.connect raises: an export-mode run must read R2 only."""
    opened = MagicMock(side_effect=AssertionError('the database was opened'))
    monkeypatch.setattr(psycopg2, 'connect', opened)
    return opened


def test_the_snapshot_source_never_opens_the_database(run, monkeypatch):
    write_tape(run, CLOSE_TAPE)
    write_export(run, [export_row(SPXW_C, '20:50:00', '6701.00')])
    opened = never_open_the_database(monkeypatch)

    assert mod.parse_args(['--source', 'export']).source == 'export'
    assert mod.main(['--source', 'export']) == 0

    opened.assert_not_called()
    assert {r['alert_id'] for r in read_rows(outcome_csv(run / 'out', export=True))} == {
        f'{SPXW_C}@{int(at("20:50:00").timestamp()) // 300 * 300}'
    }


def test_export_end_still_reads_the_snapshot(run, monkeypatch, day_world):
    """The date alone means the snapshot, as it did before the day files were the default, and
    the day files are not listed or read."""
    write_tape(run, CLOSE_TAPE)
    write_export(run, [export_row(SPXW_C, '20:50:00', '6701.00')])
    day_world.file(DAY, [day_alert(DAY, '20:55:00')])  # another alert, in the day file: not read
    opened = never_open_the_database(monkeypatch)

    assert mod.parse_args(['--export-end', DAY_ISO]).source == 'export'
    assert mod.main(['--export-end', DAY_ISO]) == 0

    opened.assert_not_called()
    assert day_world.client.listed == []
    (path,) = (run / 'out').glob('interval-ba-outcomes-export-2*.csv')
    assert {r['option_chain'] for r in read_rows(path)} == {SPXW_C}
    assert not list((run / 'out').glob('interval-ba-outcomes-days-*'))


def test_export_end_defaults_to_the_newest_replay_object(run, con, capsys):
    write_tape(run, CLOSE_TAPE)
    write_export(run, [export_row(SPXW_P, '20:50:00', '6701.00')], end='2026-11-16')
    write_export(run, [export_row(SPXW_C, '20:50:00', '6701.00')], end='2026-11-17')
    # Names that are not a replay date: never the newest.
    (run / 'replay-latest.parquet').write_bytes(b'x')
    (run / 'replay-2026-11-30.parquet.bak').write_bytes(b'x')

    assert mod.newest_export_end(con) == '2026-11-17'
    assert mod.main(['--source', 'export']) == 0

    out = capsys.readouterr().out
    assert 'Export: research/interval-ba/replay-2026-11-17.parquet (the newest)' in out
    assert {r['option_chain'] for r in read_rows(outcome_csv(run / 'out', export=True))} == {
        SPXW_C
    }
    (summary,) = (run / 'out').glob('interval-ba-outcomes-summary-export-2*.md')
    assert 'research/interval-ba/replay-2026-11-17.parquet' in summary.read_text('utf-8')


def test_a_named_export_end_is_taken_even_when_a_newer_one_exists(run, con, capsys):
    write_tape(run, CLOSE_TAPE)
    write_export(run, [export_row(SPXW_P, '20:50:00', '6701.00')], end='2026-11-16')
    write_export(run, [export_row(SPXW_C, '20:50:00', '6701.00')], end='2026-11-17')

    assert mod.main(['--export-end', '2026-11-16']) == 0

    out = capsys.readouterr().out
    assert 'Export: research/interval-ba/replay-2026-11-16.parquet\n' in out
    assert {r['option_chain'] for r in read_rows(outcome_csv(run / 'out', export=True))} == {
        SPXW_P
    }


def test_no_replay_object_exits_with_a_message_naming_the_prefix(run):
    with pytest.raises(SystemExit, match=r'No replay object under research/interval-ba/ in R2'):
        mod.main(['--source', 'export'])

    assert not list((run / 'out').glob('*.csv'))


def test_the_outcomes_names_follow_the_source_the_script_reads(run, monkeypatch, day_world):
    """Each source writes its own names (days.outcomes_prefix, which the analyze scripts find the
    CSV by): the day files' with `-days-`, the snapshot's with `-export-`, the table's none."""
    write_tape(run, CLOSE_TAPE)
    write_export(run, [export_row(SPXW_C, '20:50:00', '6701.00')])
    day_world.full(DAY)
    fake_table(monkeypatch, [table_row(7, SPXW_C, '20:50:00', '6701.00')])

    mod.main(['--from-date', DAY_ISO, '--to-date', DAY_ISO])
    mod.main(['--export-end', DAY_ISO])
    mod.main(['--source', 'table'])

    out = run / 'out'
    assert len(list(out.glob('interval-ba-outcomes-days-2*.csv'))) == 1
    assert len(list(out.glob('interval-ba-outcomes-summary-days-2*.md'))) == 1
    assert len(list(out.glob('interval-ba-outcomes-export-2*.csv'))) == 1
    assert len(list(out.glob('interval-ba-outcomes-summary-export-2*.md'))) == 1
    assert len(list(out.glob('interval-ba-outcomes-2*.csv'))) == 1
    assert len(list(out.glob('interval-ba-outcomes-summary-2*.md'))) == 1


@pytest.mark.parametrize(
    'missing',
    [
        ('fired_at', 'underlying_price'),
        ('top_trade_is_floor',),  # which the cuts analysis reads
    ],
)
def test_an_export_without_the_columns_the_script_reads_names_them(run, missing):
    narrow = pa.schema([f for f in EXPORT_SCHEMA if f.name not in missing])
    rows = [
        {k: v for k, v in export_row(SPXW_C, '20:50:00', '6701.00').items() if k in narrow.names}
    ]
    write_export(run, rows, narrow)

    with pytest.raises(SystemExit, match=', '.join(missing)):
        mod.main(['--source', 'export', '--export-end', DAY_ISO])


def test_export_columns_match_the_replay_module():
    """The scripts copy the export's column names instead of importing the replay module (a
    production run hashes the tool's files, and the module sits in nightly/src). This holds the
    test schema to the module's EXPORT_COLUMNS, and this script's snapshot key prefix to the
    tool's. (The scripts' own copy of the names, days.ALERT_COLUMNS, is held to it in
    test_interval_ba_days.py.)"""
    import interval_ba_tape as tool

    wanted = [(name, str(kind)) for name, kind in tool.ibr.EXPORT_COLUMNS]
    assert [(f.name, str(f.type)) for f in EXPORT_SCHEMA] == wanted
    assert set(days.ALERT_COLUMNS) <= {name for name, _ in wanted}
    assert mod.EXPORT_PREFIX == tool.EXPORT_PREFIX


# --- the day files ----------------------------------------------------------------------------

DAY_ALERT = [day_alert(DAY, '20:50:00', spot='6701.00')]  # the alert CLOSE_TAPE is written for
DAY_PATH = [('0', '6701.00', '0.0000'), ('5', '6710.00', '0.1343'), ('10', '6720.00', '0.2835')]


def test_readers_default_to_the_day_files(run, monkeypatch, day_world, capsys):
    write_tape(run, CLOSE_TAPE)
    day_world.tape(DAY)
    day_world.file(DAY, DAY_ALERT)
    opened = never_open_the_database(monkeypatch)

    assert mod.parse_args([]).source == 'days'
    assert mod.main(['--from-date', DAY_ISO, '--to-date', DAY_ISO]) == 0

    opened.assert_not_called()
    assert day_world.write.call_count == 0
    rows = read_rows(outcome_csv(run / 'out', days=True))
    bucket_s = int(at('20:50:00').timestamp()) // 300 * 300
    assert {r['alert_id'] for r in rows} == {f'{SPXW_C}@{bucket_s}'}
    assert [(r['t_minutes'], r['spx_price'], r['pct_change']) for r in rows] == DAY_PATH
    (summary,) = (run / 'out').glob('interval-ba-outcomes-summary-days-2*.md')
    assert (
        'Source: the replay day files in `research/interval-ba/replay/` '
        '(1 day, 2026-11-17 to 2026-11-17; replay version'
    ) in summary.read_text('utf-8')
    out = capsys.readouterr().out
    assert 'Day files: the replay day files' in out
    assert 'from the day files → interval-ba-outcomes-days-' in out


def test_the_default_range_runs_from_2026_01_02_through_the_newest_tape(
    run, monkeypatch, day_world
):
    write_tape(run, CLOSE_TAPE)
    day_world.tape(DAY)
    day_world.file(DAY, DAY_ALERT)

    # No --from-date: every trading day from 2026-01-02 is needed, and none of them before DAY has
    # a tape or a file here. No --to-date: DAY, the newest tape, is the last.
    with pytest.raises(SystemExit) as stopped:
        mod.main([])

    assert str(stopped.value).startswith('No tape in R2 for 2026-01-02 to 2026-11-16')
    assert not list((run / 'out').glob('*.csv'))


def test_a_given_range_limits_the_days_checked_and_the_alerts_read(run, day_world):
    """DAY is the range. The day after has a tape and no file (a repair, if it were needed), and
    the day after that has a file whose alert is not DAY's."""
    after, later = DAY + timedelta(days=1), DAY + timedelta(days=2)
    write_tape(run, CLOSE_TAPE)
    day_world.full(DAY)
    day_world.tape(after)
    day_world.full(later)
    day_world.file(later, [day_alert(later, '20:50:00', spot='6701.00')])

    assert mod.main(['--from-date', DAY_ISO, '--to-date', DAY_ISO]) == 0

    assert day_world.write.call_count == 0
    rows = read_rows(outcome_csv(run / 'out', days=True))
    assert {r['option_chain'] for r in rows} == {SPXW_C}  # not the later day's alert
    assert len({r['alert_id'] for r in rows}) == 1


def test_a_missing_day_with_a_tape_is_rebuilt_written_and_read(
    run, monkeypatch, day_world, capsys
):
    write_tape(run, CLOSE_TAPE)
    day_world.tape(DAY)  # landed; its file was never written
    day_world.alerts[DAY] = DAY_ALERT
    never_open_the_database(monkeypatch)

    assert mod.main(['--from-date', DAY_ISO, '--to-date', DAY_ISO]) == 0

    assert day_world.written == [DAY]
    rows = read_rows(outcome_csv(run / 'out', days=True))
    assert [(r['t_minutes'], r['spx_price'], r['pct_change']) for r in rows] == DAY_PATH
    (summary,) = (run / 'out').glob('interval-ba-outcomes-summary-days-2*.md')
    assert 'This run repaired 2026-11-17: the nightly should have written them' in (
        summary.read_text('utf-8')
    )
    assert 'the nightly should have written it; check the interval-ba-tape step' in (
        capsys.readouterr().out
    )


def test_a_day_file_older_than_its_tape_is_repaired_before_the_run(run, day_world):
    write_tape(run, CLOSE_TAPE)
    day_world.full(DAY)
    day_world.tape(DAY, at=day_world.landed(DAY) + timedelta(days=1))  # the tape was re-landed
    day_world.alerts[DAY] = DAY_ALERT

    assert mod.main(['--from-date', DAY_ISO, '--to-date', DAY_ISO]) == 0

    assert day_world.written == [DAY]


def test_dry_run_never_writes_and_lists_the_days_to_repair(run, day_world):
    write_tape(run, CLOSE_TAPE)
    day_world.tape(DAY)
    before = dict(day_world.client.objects)

    with pytest.raises(SystemExit) as stopped:
        mod.main(['--dry-run', '--from-date', DAY_ISO, '--to-date', DAY_ISO])

    assert str(stopped.value).startswith('--dry-run: nothing was written.')
    assert '1 day file(s) would be repaired:' in str(stopped.value)
    assert '2026-11-17  missing' in str(stopped.value)
    assert day_world.write.call_count == 0
    assert day_world.client.objects == before
    assert not list((run / 'out').glob('*'))


def test_a_dry_run_with_nothing_to_repair_reads_the_day_files_and_writes_nothing(
    run, day_world, capsys
):
    write_tape(run, CLOSE_TAPE)
    day_world.tape(DAY)
    day_world.file(DAY, DAY_ALERT)

    assert mod.main(['--dry-run', '--from-date', DAY_ISO, '--to-date', DAY_ISO]) == 0

    assert not list((run / 'out').glob('*'))
    assert '## Median % change' in capsys.readouterr().out


def test_readers_refuse_mixed_rules_and_name_the_days(run, day_world):
    after = DAY + timedelta(days=1)
    other = {**day_world.rule, 'replay-version': '2'}
    day_world.tape(DAY, after)
    day_world.file(DAY, DAY_ALERT)
    day_world.file(after, [day_alert(after)], rule=other)

    with pytest.raises(SystemExit) as stopped:
        mod.main(['--from-date', DAY_ISO, '--to-date', after.isoformat()])

    message = str(stopped.value)
    assert message.startswith('The day files are not one study: they hold 2 different rules.')
    assert 'rule 2 (replay-version 2): 2026-11-18' in message
    assert not list((run / 'out').glob('*.csv'))


def test_a_missing_day_without_a_tape_refuses_and_names_it(run, day_world):
    day_world.file(DAY, DAY_ALERT)  # no tape for it either: fine
    after = DAY + timedelta(days=1)  # neither a file nor a tape

    with pytest.raises(SystemExit) as stopped:
        mod.main(['--from-date', DAY_ISO, '--to-date', after.isoformat()])

    assert str(stopped.value).startswith('No tape in R2 for 2026-11-18, and no unavailable marker')
    assert day_world.write.call_count == 0
    assert not list((run / 'out').glob('*.csv'))


def test_no_day_file_exits_with_the_prefix(run, day_world):
    with pytest.raises(SystemExit) as stopped:
        mod.main([])

    assert str(stopped.value).startswith('No day file under research/interval-ba/replay/ in R2')
    assert not list((run / 'out').glob('*.csv'))


def test_a_day_file_that_holds_no_alerts_is_noted_and_the_run_goes_on(run, day_world, capsys):
    write_tape(run, CLOSE_TAPE)
    after = DAY + timedelta(days=1)
    day_world.tape(DAY, after)
    day_world.file(DAY, DAY_ALERT)
    day_world.file(after, [])

    assert mod.main(['--from-date', DAY_ISO, '--to-date', after.isoformat()]) == 0

    assert 'NOTE: 2026-11-18 hold no alerts' in capsys.readouterr().out


def test_a_day_file_with_a_bad_footer_stops_the_run(run, day_world):
    day_world.tape(DAY)
    day_world.file(DAY, DAY_ALERT, footer=False)

    with pytest.raises(SystemExit, match='no readable `interval_ba` footer'):
        mod.main(['--from-date', DAY_ISO, '--to-date', DAY_ISO])

    assert not list((run / 'out').glob('*.csv'))


def test_a_listing_that_fails_stops_the_run_without_its_text(run, day_world):
    from botocore.exceptions import ClientError

    day_world.client.fail = ClientError(
        {'Error': {'Code': 'AccessDenied', 'Message': 'account-0123'}}, 'ListObjectsV2'
    )

    with pytest.raises(SystemExit) as stopped:
        mod.main(['--from-date', DAY_ISO, '--to-date', DAY_ISO])

    assert 'ClientError' in str(stopped.value)
    assert 'account-0123' not in str(stopped.value)


def test_day_files_written_by_the_nightly_step_read_as_the_tool_writes_them(run, day_world):
    """A real day file, as the replay module builds it (export_table, day_meta): the check and the
    reader take it, rule and all."""
    import interval_ba_tape as tool

    ibr = tool.ibr
    alert = ibr.TapeAlert(
        option_chain=SPXW_C,
        ticker='SPXW',
        option_type='C',
        strike=Decimal('6700.000'),
        expiry=DAY,
        bucket_start=at('20:50:00'),
        bucket_end=at('20:55:00'),
        fired_at=at('20:50:00'),
        ratio_pct=Decimal('80.00'),
        ask_premium=Decimal('240000.00'),
        total_premium=Decimal('300000.00'),
        trade_count=3,
        top_trade_premium=Decimal('100000.00'),
        top_trade_size=10,
        top_trade_executed_at=at('20:50:00'),
        top_trade_is_sweep=False,
        top_trade_is_floor=False,
        underlying_price=Decimal('6701.00'),
        confluence_tickers=(),
    )
    import pyarrow.parquet as pq

    write_tape(run, CLOSE_TAPE)
    day_world.tape(DAY)
    meta = ibr.day_meta(DAY, 1, datetime(2026, 11, 18, 7, 20, tzinfo=UTC))
    pq.write_table(ibr.export_table([alert], meta), day_world.url(DAY))
    day_world.client.objects[ibr.day_key(DAY)] = day_world.landed(DAY) + timedelta(hours=1)

    assert mod.main(['--from-date', DAY_ISO, '--to-date', DAY_ISO]) == 0

    rows = read_rows(outcome_csv(run / 'out', days=True))
    assert [(r['t_minutes'], r['spx_price']) for r in rows] == [
        (t, spot) for t, spot, _ in DAY_PATH
    ]


# --- the close of a half day ------------------------------------------------------------------

HALF = date(2026, 11, 27)  # the Friday after Thanksgiving: 13:00 ET, 12:00 CT, 18:00 UTC
SPXW_HALF_C = 'SPXW261127C06700000'


@pytest.mark.parametrize(
    ('day', 'close'),
    [
        ('2026-11-17', datetime(2026, 11, 17, 21, 0, tzinfo=UTC)),  # a full day: 15:00 CT (CST)
        ('2026-07-14', datetime(2026, 7, 14, 20, 0, tzinfo=UTC)),  # a full day in summer: 15:00 CDT
        ('2026-11-27', datetime(2026, 11, 27, 18, 0, tzinfo=UTC)),  # 12:00 CT
        ('2026-12-24', datetime(2026, 12, 24, 18, 0, tzinfo=UTC)),  # Christmas Eve, 12:00 CT
        ('2025-07-03', datetime(2025, 7, 3, 17, 0, tzinfo=UTC)),  # 13:00 EDT: 12:00 CDT
        ('2028-07-03', datetime(2028, 7, 3, 17, 0, tzinfo=UTC)),
    ],
)
def test_the_close_is_15_ct_and_on_a_half_day_13_et(day, close):
    assert mod.session_close_utc(day) == close


def test_the_early_close_days_are_uw_streams_calendar_loaded_by_its_path():
    import importlib.util

    path = Path(__file__).resolve().parent.parent / 'uw-stream' / 'src' / 'market_calendar.py'
    spec = importlib.util.spec_from_file_location('market_calendar_for_the_test', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert path == mod.MARKET_CALENDAR_PATH
    assert dict(mod.EARLY_CLOSE_DATES) == dict(module.EARLY_CLOSE_DATES)
    assert '2026-11-27' in mod.EARLY_CLOSE_DATES


def test_a_change_to_the_market_calendar_reruns_these_tests():
    """This script loads uw-stream's calendar by path, so the ml job (which runs these tests)
    must start when that file alone changes: it is in the job's paths filter in ci.yml."""
    import yaml

    workflow = yaml.safe_load((mod.ROOT / '.github' / 'workflows' / 'ci.yml').read_text('utf-8'))
    steps = workflow['jobs']['changes']['steps']
    (filters,) = (s['with']['filters'] for s in steps if s.get('id') == 'filter')

    assert mod.MARKET_CALENDAR_PATH.relative_to(mod.ROOT).as_posix() in yaml.safe_load(filters)['ml']


def test_a_half_days_path_ends_at_the_early_close_and_a_full_days_at_15_ct(
    run, monkeypatch, capsys
):
    # A print every five minutes from 17:00 to 21:55 UTC, the spot rising 3 points each time.
    clocks = [f'{h}:{m:02d}:00' for h in range(17, 22) for m in range(0, 60, 5)]
    for day, chain in ((HALF, SPXW_HALF_C), (DAY, SPXW_C)):
        ticks = [tick(clock, chain, f'{6700 + 3 * n}.00', day=day) for n, clock in enumerate(clocks)]
        write_tape(run, ticks, day=day)
    half_early = table_row(1, SPXW_HALF_C, '17:50:00', '6700.00')
    half_after = table_row(2, SPXW_HALF_C, '18:30:00', '6700.00')  # 12:30 CT: after the close
    full = table_row(3, SPXW_C, '17:50:00', '6700.00')
    for row in (half_early, half_after):
        row['expiry'] = HALF
        row['fired_at'] = at(row['fired_at'].strftime('%H:%M:%S'), HALF)
    fake_table(monkeypatch, [half_early, half_after, full])

    assert mod.main(['--source', 'table']) == 0

    rows = read_rows(outcome_csv(run / 'out'))
    steps = {
        alert_id: [int(r['t_minutes']) for r in rows if r['alert_id'] == alert_id]
        for alert_id in ('1', '2', '3')
    }
    assert steps['1'] == [0, 5, 10]  # 17:50, 17:55 and the 18:00 close, not a step past it
    assert steps['2'] == []  # fired after the close: no path
    assert steps['3'][-1] == 190  # 17:50 to 21:00: the full day runs to 15:00 CT
    out = capsys.readouterr().out
    assert f'{HALF.isoformat()}  alerts=   2  series_prints=' in out
    assert 'after_close=1' in out


# --- export_url ---------------------------------------------------------------------------------


def test_export_url_is_the_buckets_object_for_that_end_date(monkeypatch):
    monkeypatch.setenv('R2_BUCKET_FULLTAPE', 'tape-bucket')

    assert mod.export_key('2026-11-25') == 'research/interval-ba/replay-2026-11-25.parquet'
    assert mod.export_url('2026-11-25') == (
        's3://tape-bucket/research/interval-ba/replay-2026-11-25.parquet'
    )


@pytest.mark.parametrize('value', [None, '', '   '])
def test_export_url_without_a_bucket_exits_naming_the_variable(monkeypatch, value):
    if value is not None:
        monkeypatch.setenv('R2_BUCKET_FULLTAPE', value)
    else:
        monkeypatch.delenv('R2_BUCKET_FULLTAPE', raising=False)

    with pytest.raises(SystemExit, match='R2_BUCKET_FULLTAPE'):
        mod.export_url('2026-11-25')


# --- over s3:// against a fake S3 on loopback ---------------------------------------------------


@pytest.fixture
def s3_run(monkeypatch, tmp_path, fake_s3):
    """main() reading `s3://bucket/...` from the fake S3 (in _ba_test_support). r2_url and
    export_url are the real ones (the bucket comes from the environment); only the connection is
    swapped."""
    opened: list[duckdb.DuckDBPyConnection] = []

    def connect(**_limits) -> duckdb.DuckDBPyConnection:
        db = s3_connection(fake_s3)
        opened.append(db)
        return db

    monkeypatch.setenv('R2_BUCKET_FULLTAPE', 'bucket')
    monkeypatch.setattr(mod, 'load_env', lambda: None)
    monkeypatch.setattr(mod, 'OUT_DIR', tmp_path / 'out')
    monkeypatch.setattr(mod, 'fulltape_connection', connect)
    yield SimpleNamespace(s3=fake_s3, connect=connect, dir=tmp_path)
    for db in opened:
        db.close()


def tape_key(day: str) -> str:
    return f'/bucket/fulltape/{day}-fulltape.parquet'


EXPORT_KEY = f'/bucket/research/interval-ba/replay-{DAY_ISO}.parquet'


def test_object_exists_over_s3_says_present_missing_and_forbidden(s3_run):
    s3_run.s3.objects[tape_key(DAY_ISO)] = Path(
        write_tape(s3_run.dir, CLOSE_TAPE)
    ).read_bytes()
    s3_run.s3.forbidden.add(tape_key('2026-11-18'))

    con = s3_run.connect()

    assert mod.object_exists(con, mod.r2_url(DAY_ISO)) is True
    assert mod.object_exists(con, mod.r2_url('2026-11-19')) is False
    with pytest.raises(duckdb.HTTPException, match='403'):
        mod.object_exists(con, mod.r2_url('2026-11-18'))


def test_over_s3_a_tape_day_missing_from_the_bucket_is_skipped_by_name(
    s3_run, monkeypatch, capsys
):
    s3_run.s3.objects[tape_key(DAY_ISO)] = Path(
        write_tape(s3_run.dir, CLOSE_TAPE)
    ).read_bytes()
    next_day = DAY + timedelta(days=1)
    row = table_row(2, 'SPXW261118C06700000', '20:50:00', '6701.00')
    row['expiry'] = next_day
    fake_table(monkeypatch, [table_row(1, SPXW_C, '20:50:00', '6701.00'), row])

    assert mod.main(['--source', 'table']) == 0

    assert {r['alert_id'] for r in read_rows(outcome_csv(s3_run.dir / 'out'))} == {'1'}
    assert f'{next_day.isoformat()}  SKIP: tape not in R2' in capsys.readouterr().out


def test_over_s3_a_forbidden_tape_stops_the_run_instead_of_reading_as_missing(
    s3_run, monkeypatch
):
    s3_run.s3.forbidden.add(tape_key(DAY_ISO))
    fake_table(monkeypatch, [table_row(1, SPXW_C, '20:50:00', '6701.00')])

    with pytest.raises(duckdb.HTTPException, match='403'):
        mod.main(['--source', 'table'])


def test_over_s3_the_export_is_read_and_a_missing_one_names_its_key(s3_run):
    with pytest.raises(SystemExit, match='research/interval-ba/replay-2026-11-17.parquet'):
        mod.main(['--source', 'export', '--export-end', DAY_ISO])

    s3_run.s3.objects[tape_key(DAY_ISO)] = Path(
        write_tape(s3_run.dir, CLOSE_TAPE)
    ).read_bytes()
    s3_run.s3.objects[EXPORT_KEY] = Path(
        write_export(s3_run.dir, [export_row(SPXW_C, '20:50:00', '6701.00')])
    ).read_bytes()

    assert mod.main(['--source', 'export', '--export-end', DAY_ISO]) == 0

    rows = read_rows(outcome_csv(s3_run.dir / 'out', export=True))
    assert [(r['t_minutes'], r['spx_price']) for r in rows] == [
        ('0', '6701.00'),
        ('5', '6710.00'),
        ('10', '6720.00'),
    ]


def replay_key(end: str) -> str:
    return f'/bucket/research/interval-ba/replay-{end}.parquet'


def test_over_s3_the_newest_replay_object_is_listed_and_taken(s3_run, capsys):
    """The default --export-end is a wildcard LIST of the prefix: glob() of one key would not ask
    the bucket at all."""
    objects = s3_run.s3.objects
    objects[tape_key(DAY_ISO)] = Path(write_tape(s3_run.dir, CLOSE_TAPE)).read_bytes()
    objects[replay_key('2026-11-16')] = Path(
        write_export(s3_run.dir, [export_row(SPXW_P, '20:50:00', '6701.00')], end='2026-11-16')
    ).read_bytes()
    objects[replay_key(DAY_ISO)] = Path(
        write_export(s3_run.dir, [export_row(SPXW_C, '20:50:00', '6701.00')])
    ).read_bytes()
    # Neighbours under the same prefix that are not a replay date.
    objects['/bucket/research/interval-ba/replay-2026-11-30.parquet.bak'] = b'x'
    objects['/bucket/research/interval-ba/notes.parquet'] = b'x'
    objects['/bucket/research/other/replay-2026-12-31.parquet'] = b'x'

    assert mod.newest_export_end(s3_run.connect()) == DAY_ISO
    assert mod.main(['--source', 'export']) == 0

    assert 'Export: research/interval-ba/replay-2026-11-17.parquet (the newest)' in (
        capsys.readouterr().out
    )
    assert {r['option_chain'] for r in read_rows(outcome_csv(s3_run.dir / 'out', export=True))} == {
        SPXW_C
    }


def test_over_s3_no_replay_object_exits_with_a_message_naming_the_prefix(s3_run):
    s3_run.s3.objects['/bucket/research/interval-ba/replay-2026-11-30.parquet.bak'] = b'x'

    with pytest.raises(SystemExit, match=r'No replay object under research/interval-ba/ in R2'):
        mod.main(['--source', 'export'])
