"""The per-day EOD flow chains built from the UW Full Tape (scripts/_eod_flow.py)
and the analyze CLI over them (scripts/eod-flow-analysis/analyze.py).

- build_chains: side and equity type come from the print's tags, the bot-eod
  filters hold, first/last prices break ties by id, and the output has one
  pinned schema whatever layout the tape day has (new: Float64, Boolean
  `canceled`, tz-aware `executed_at`; legacy: decimal128 numerics, naive
  `executed_at`, text `canceled`).
- rollup / write_headlines: the open window is 09:30-10:00 ET on both sides of
  the November DST change, nothing depends on DuckDB's session zone, and the
  headlines print times in CT.
- analyze.py: `--tape-dir | --r2` is the source; `--r2` is tested only by
  replacing `_tape_reader.TapeReader`, the module analyze imports it from
  inside build_from_r2.

Every file a test writes is under tmp_path. The 23 tracked by-day parquets are
frozen history: one test reads a schema from one of them and nothing writes
them. Run, from the repo root:

    ml/.venv/Scripts/python -m pytest -q scripts/test_eod_flow.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import textwrap
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from types import ModuleType

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

import _eod_flow  # noqa: E402
import _tape_reader  # noqa: E402
from _eod_flow import (  # noqa: E402
    CHAINS_COLUMNS,
    CHAINS_START,
    CHAINS_VERSION,
    EQUITY_TYPE_TAGS,
    NO_SIDE,
    OPEN_WINDOW_ET_MINUTES,
    REQUIRED_TAPE_COLUMNS,
    SIDE_TAGS,
    ChainsBuildError,
    build_chains,
    rollup,
    write_headlines,
)

ANALYZE_PATH = SCRIPTS_DIR / 'eod-flow-analysis' / 'analyze.py'
TRACKED_BY_DAY = SCRIPTS_DIR / 'eod-flow-analysis' / 'output' / 'by-day' / '2026-04-13-chains.parquet'

DAY = date(2026, 6, 15)
OPEN = datetime(2026, 6, 15, 13, 35, tzinfo=UTC)  # 09:35 EDT

# The legacy by-day layout, as pyarrow names it. Written out here on purpose, so a
# slip in CHAINS_COLUMNS cannot hide behind a test that derives its expectation from it.
CHAINS_SCHEMA = [
    ('trade_date', 'string'),
    ('option_chain_id', 'string'),
    ('ticker', 'string'),
    ('underlying_symbol', 'string'),
    ('strike', 'double'),
    ('option_type', 'string'),
    ('expiry', 'date32[day]'),
    ('equity_type', 'string'),
    ('sector', 'string'),
    ('total_size', 'double'),
    ('total_premium', 'double'),
    ('day_volume', 'int64'),
    ('day_oi', 'int64'),
    ('ask_size', 'double'),
    ('bid_size', 'double'),
    ('first_ts', 'timestamp[us, tz=UTC]'),
    ('last_ts', 'timestamp[us, tz=UTC]'),
    ('first_price', 'double'),
    ('last_price', 'double'),
    ('first_underlying', 'double'),
    ('last_underlying', 'double'),
    ('trade_count', 'int64'),
]
ARROW_TYPES = {
    'VARCHAR': pa.string(),
    'DOUBLE': pa.float64(),
    'DATE': pa.date32(),
    'BIGINT': pa.int64(),
    'TIMESTAMPTZ': pa.timestamp('us', tz='UTC'),
}
REQUIRED = frozenset(
    {
        'id',
        'underlying_symbol',
        'executed_at',
        'price',
        'option_chain_id',
        'tags',
        'expiry',
        'option_type',
        'open_interest',
        'strike',
        'premium',
        'volume',
        'underlying_price',
        'size',
        'canceled',
    }
)


# ── fixtures: tape days and by-day files ───────────────────────


def trade(**over) -> dict:
    """One print that passes every filter. `id` defaults to the row's position."""
    row = {
        'option_chain_id': 'AAPL260616C00200000',
        'underlying_symbol': 'AAPL',
        'executed_at': OPEN,
        'price': 2.5,
        'underlying_price': 200.0,
        'size': 100,
        'premium': 150_000.0,
        'strike': 200.0,
        'option_type': 'call',
        'expiry': date(2026, 6, 16),
        'volume': 600,
        'open_interest': 100,
        'tags': '{ask_side,bullish}',
        'canceled': False,
    }
    row.update(over)
    return row


def write_tape(
    path: Path, rows: list[dict], *, layout: str = 'new', drop: tuple[str, ...] = ()
) -> Path:
    """A tape day of `rows`, in the new layout or the legacy one, minus the `drop` columns."""
    rows = [{'id': f't-{i:04d}', **row} for i, row in enumerate(rows)]

    def col(name: str) -> list:
        return [row[name] for row in rows]

    columns: dict[str, pa.Array] = {
        'id': pa.array(col('id'), pa.string()),
        'option_chain_id': pa.array(col('option_chain_id'), pa.string()),
        'underlying_symbol': pa.array(col('underlying_symbol'), pa.string()),
        'option_type': pa.array(col('option_type'), pa.string()),
        'tags': pa.array(col('tags'), pa.string()),
        'expiry': pa.array(col('expiry'), pa.date32()),
        'size': pa.array(col('size'), pa.int64()),
        'volume': pa.array(col('volume'), pa.int64()),
        'open_interest': pa.array(col('open_interest'), pa.int64()),
    }
    money = ('price', 'premium', 'strike', 'underlying_price')
    if layout == 'new':
        columns |= {name: pa.array(col(name), pa.float64()) for name in money}
        columns['executed_at'] = pa.array(col('executed_at'), pa.timestamp('us', tz='UTC'))
        columns['canceled'] = pa.array(col('canceled'), pa.bool_())
        columns['trading_hours'] = pa.array(['rth'] * len(rows), pa.string())
        columns['exchange_id'] = pa.array(['XCBO'] * len(rows), pa.string())
    elif layout == 'legacy':
        # The January-April files hold every numeric as decimal128.
        for name in (*money, 'size'):
            columns[name] = pa.array([Decimal(str(v)) for v in col(name)], pa.decimal128(18, 4))
        for name in ('volume', 'open_interest'):
            columns[name] = pa.array([Decimal(v) for v in col(name)], pa.decimal128(18, 0))
        # The naive timestamps hold UTC clock readings, as the old files do.
        columns['executed_at'] = pa.array(
            [v.astimezone(UTC).replace(tzinfo=None) for v in col('executed_at')], pa.timestamp('us')
        )
        columns['canceled'] = pa.array(['t' if v else 'f' for v in col('canceled')], pa.string())
    else:
        raise ValueError(layout)
    for name in drop:
        del columns[name]
    pq.write_table(pa.table(columns), path)
    return path


def chain_row(day: date = DAY, **over) -> dict:
    """One by-day chain row: an ask-dominant SPXW call whose first print is at OPEN."""
    row = {
        'trade_date': day.isoformat(),
        'option_chain_id': 'SPXW260615C06800000',
        'ticker': 'SPXW',
        'underlying_symbol': 'SPX',
        'strike': 6800.0,
        'option_type': 'call',
        'expiry': day,
        'equity_type': 'Index',
        'sector': None,
        'total_size': 100.0,
        'total_premium': 500_000.0,
        'day_volume': 1000,
        'day_oi': 100,
        'ask_size': 90.0,
        'bid_size': 10.0,
        'first_ts': OPEN,
        'last_ts': OPEN,
        'first_price': 10.0,
        'last_price': 10.0,
        'first_underlying': 6800.0,
        'last_underlying': 6800.0,
        'trade_count': 5,
    }
    row.update(over)
    return row


def write_by_day(
    path: Path, rows: list[dict], *, reverse_columns: bool = False, extra_column: str | None = None
) -> Path:
    """A by-day file in the pinned schema.

    `reverse_columns` writes it in the opposite order; `extra_column` adds a string column
    the pinned schema does not have, as a file from another build might.
    """
    fields = [(name, ARROW_TYPES[sql_type]) for name, sql_type in CHAINS_COLUMNS]
    if reverse_columns:
        fields.reverse()
    columns = {name: pa.array([r[name] for r in rows], typ) for name, typ in fields}
    if extra_column is not None:
        columns[extra_column] = pa.array(['x'] * len(rows), pa.string())
    pq.write_table(pa.table(columns), path)
    return path


def read_rows(path: Path) -> list[dict]:
    return pq.read_table(path).to_pylist()


def by_chain(rows: list[dict]) -> dict[str, dict]:
    return {row['option_chain_id']: row for row in rows}


def build(tmp_path: Path, rows: list[dict], **tape_kwargs) -> list[dict]:
    """Write a tape of `rows`, build its chains and read them back."""
    tape = write_tape(tmp_path / 'tape.parquet', rows, **tape_kwargs)
    out = tmp_path / 'chains.parquet'
    count = build_chains(tape, DAY, out)
    result = read_rows(out)
    assert count == len(result)
    return result


def window_counts(result: dict) -> list[int]:
    return [m['first_30min_directional'] for m in result['morning_clustering']]


def dst_by_day_files(directory: Path) -> Path:
    """Ask-dominant chains either side of the 2026-11-01 DST change.

    10-30 (EDT): 13:35Z is 09:35 ET, in the window.
    11-03 (EST): 14:35Z is 09:35 ET, in the window; 13:35Z (08:35 ET) and 15:01Z
    (10:01 ET) are not.
    """
    directory.mkdir(exist_ok=True)
    day1, day2 = date(2026, 10, 30), date(2026, 11, 3)

    def at(day: date, hour: int, minute: int, chain_id: str) -> dict:
        ts = datetime(day.year, day.month, day.day, hour, minute, tzinfo=UTC)
        return chain_row(day, option_chain_id=chain_id, first_ts=ts, last_ts=ts)

    write_by_day(directory / '2026-10-30-chains.parquet', [at(day1, 13, 35, 'A1')])
    write_by_day(
        directory / '2026-11-03-chains.parquet',
        [at(day2, 14, 35, 'B1'), at(day2, 13, 35, 'B2'), at(day2, 15, 1, 'B3')],
    )
    return directory


@pytest.fixture
def analyze() -> ModuleType:
    spec = importlib.util.spec_from_file_location('eod_flow_analyze', ANALYZE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def host_zone(monkeypatch: pytest.MonkeyPatch):
    """Makes every new DuckDB connection start in `zone`, as if the host were there.

    The patch is on duckdb.connect, so what `_eod_flow.connect` does after it
    (its own SET TimeZone) is what the tests then exercise.
    """

    def install(zone: str) -> None:
        real_connect = duckdb.connect

        def connect_in_zone(*args, **kwargs):
            con = real_connect(*args, **kwargs)
            con.execute(f"SET TimeZone = '{zone}'")
            return con

        monkeypatch.setattr(duckdb, 'connect', connect_in_zone)

    return install


# ── the pinned constants ───────────────────────────────────────


def test_constants_are_the_pinned_ones():
    assert dict(SIDE_TAGS) == {'ask_side': 'ask', 'bid_side': 'bid', 'mid_side': 'mid'}
    assert NO_SIDE == 'no_side'
    assert EQUITY_TYPE_TAGS == (('index', 'Index'), ('etf', 'ETF'))
    assert CHAINS_VERSION == 1
    assert CHAINS_START == date(2026, 4, 13)
    assert OPEN_WINDOW_ET_MINUTES == (570, 600)
    assert REQUIRED_TAPE_COLUMNS == REQUIRED


def test_chains_columns_are_the_legacy_layout():
    assert [(name, str(ARROW_TYPES[sql])) for name, sql in CHAINS_COLUMNS] == CHAINS_SCHEMA


def test_chains_columns_match_a_tracked_legacy_by_day_file(tmp_path):
    """The seeded days and the tape-built days must have one schema (strict pl.concat)."""
    legacy = [(f.name, str(f.type)) for f in pq.read_schema(TRACKED_BY_DAY)]
    assert legacy == CHAINS_SCHEMA
    out = tmp_path / 'chains.parquet'
    build_chains(write_tape(tmp_path / 'tape.parquet', [trade()]), DAY, out)
    assert [(f.name, str(f.type)) for f in pq.read_schema(out)] == legacy


# ── build_chains ───────────────────────────────────────────────


def test_side_and_equity_type_come_from_tags(tmp_path):
    rows = [
        trade(option_chain_id='ASK', size=100, tags='{ask_side,bullish,etf}'),
        trade(option_chain_id='BID', size=200, tags='{bid_side,index}'),
        trade(option_chain_id='MID', size=300, tags='{mid_side}'),
        trade(option_chain_id='NOSIDE', size=400, tags='{no_side,bearish}'),
        trade(option_chain_id='EMPTY', size=500, tags='{}'),
        trade(option_chain_id='NULLTAGS', size=600, tags=None),
        trade(option_chain_id='BOTH', size=700, tags='{no_side,etf,index}'),
        # One chain, every side: ask and bid sum only their own side.
        trade(option_chain_id='MIXED', size=100, tags='{ask_side,etf}'),
        trade(option_chain_id='MIXED', size=50, tags='{ask_side,etf}'),
        trade(option_chain_id='MIXED', size=30, tags='{bid_side,etf}'),
        trade(option_chain_id='MIXED', size=7, tags='{mid_side,etf}'),
        trade(option_chain_id='MIXED', size=3, tags='{no_side,etf}'),
    ]
    chains = by_chain(build(tmp_path, rows))
    sides = {k: (v['ask_size'], v['bid_size'], v['total_size']) for k, v in chains.items()}
    assert sides == {
        'ASK': (100.0, 0.0, 100.0),
        'BID': (0.0, 200.0, 200.0),
        'MID': (0.0, 0.0, 300.0),
        'NOSIDE': (0.0, 0.0, 400.0),
        'EMPTY': (0.0, 0.0, 500.0),
        'NULLTAGS': (0.0, 0.0, 600.0),
        'BOTH': (0.0, 0.0, 700.0),
        'MIXED': (150.0, 30.0, 190.0),
    }
    equity = {k: v['equity_type'] for k, v in chains.items()}
    assert equity == {
        'ASK': 'ETF',
        'BID': 'Index',
        'MID': None,
        'NOSIDE': None,
        'EMPTY': None,
        'NULLTAGS': None,
        'BOTH': 'Index',  # first match wins
        'MIXED': 'ETF',
    }
    assert {v['sector'] for v in chains.values()} == {None}


def test_a_tag_must_match_whole_not_as_a_substring(tmp_path):
    chains = build(tmp_path, [trade(tags='{ask_side_x,etfs,indexed}')])
    assert chains[0]['ask_size'] == 0.0
    assert chains[0]['equity_type'] is None


def test_the_side_and_equity_case_sql_is_pinned():
    """The CASE text built from SIDE_TAGS and EQUITY_TYPE_TAGS, character for character."""
    sql = _eod_flow._chains_sql(Path('tape.parquet'), DAY, Path('out.tmp'))
    side = (
        "CASE WHEN list_contains(tag_list, 'ask_side') THEN 'ask' "
        "WHEN list_contains(tag_list, 'bid_side') THEN 'bid' "
        "WHEN list_contains(tag_list, 'mid_side') THEN 'mid' ELSE 'no_side' END"
    )
    equity_type = (
        "CASE WHEN list_contains(tag_list, 'index') THEN 'Index' "
        "WHEN list_contains(tag_list, 'etf') THEN 'ETF' ELSE NULL END"
    )
    assert f'SELECT *, {side} AS side, {equity_type} AS equity_type' in sql


def test_build_chains_layouts_agree_and_match_the_pinned_schema(tmp_path):
    rows = [
        trade(option_chain_id='AAPL260616C00200000', price=0.0125, underlying_price=199.99),
        trade(
            option_chain_id='AAPL260616C00200000',
            executed_at=datetime(2026, 6, 15, 14, 2, 3, 456789, tzinfo=UTC),
            price=2.5,
            underlying_price=200.25,
            size=40,
            premium=100_000.5,
            volume=900,
            tags='{bid_side,etf}',
        ),
        trade(
            option_chain_id='SPXW260615P06750000',
            underlying_symbol='SPX',
            strike=6750.0,
            option_type='put',
            price=12.35,
            underlying_price=6801.5,
            premium=250_000.25,
            tags='{ask_side,index}',
        ),
        trade(option_chain_id='DROPPED', canceled=True),
    ]
    outs = {}
    for layout in ('new', 'legacy'):
        directory = tmp_path / layout
        directory.mkdir()
        tape = write_tape(directory / 'tape.parquet', rows, layout=layout)
        out = directory / 'chains.parquet'
        assert build_chains(tape, DAY, out) == 2
        outs[layout] = out

    assert [(f.name, str(f.type)) for f in pq.read_schema(outs['new'])] == CHAINS_SCHEMA
    assert pq.read_schema(outs['legacy']).equals(pq.read_schema(outs['new']))
    assert read_rows(outs['new']) == read_rows(outs['legacy'])

    first = by_chain(read_rows(outs['legacy']))['AAPL260616C00200000']
    # The legacy naive reading is UTC, not the host's zone.
    assert first['first_ts'] == OPEN
    assert first['last_ts'] == datetime(2026, 6, 15, 14, 2, 3, 456789, tzinfo=UTC)
    assert first['first_price'] == 0.0125
    assert first['last_price'] == 2.5
    assert first['total_premium'] == 250_000.5
    assert first['day_volume'] == 900
    assert first['trade_count'] == 2
    assert first['trade_date'] == '2026-06-15'


def test_filters_match_the_bot_eod_rules(tmp_path):
    late = datetime(2026, 6, 15, 20, 30, tzinfo=UTC)  # 16:30 EDT: no time cutoff
    rows = [
        trade(option_chain_id='CANCELED', canceled=True),
        trade(option_chain_id='OI0', open_interest=0, volume=1000),
        trade(option_chain_id='RATIO499', volume=499, open_interest=100),
        trade(option_chain_id='PREM9999', premium=99_999.99),
        trade(option_chain_id='RATIO5', volume=500, open_interest=100),
        trade(option_chain_id='PREM100K', premium=100_000.0),
        trade(option_chain_id='LATE', executed_at=late),
        # A canceled print is not counted among a chain's kept prints.
        trade(option_chain_id='PARTLY', canceled=True, size=999),
        trade(option_chain_id='PARTLY', size=11),
    ]
    chains = by_chain(build(tmp_path, rows))
    assert sorted(chains) == ['LATE', 'PARTLY', 'PREM100K', 'RATIO5']
    assert chains['LATE']['first_ts'] == late
    assert chains['PARTLY']['trade_count'] == 1
    assert chains['PARTLY']['total_size'] == 11.0


def test_filters_match_the_bot_eod_rules_on_the_legacy_text_canceled(tmp_path):
    rows = [trade(option_chain_id='CANCELED', canceled=True), trade(option_chain_id='KEPT')]
    assert sorted(by_chain(build(tmp_path, rows, layout='legacy'))) == ['KEPT']


def test_first_and_last_price_break_ties_by_id(tmp_path):
    tie = datetime(2026, 6, 15, 14, 0, tzinfo=UTC)
    small = trade(id='a-1', executed_at=tie, price=1.0, underlying_price=100.0)
    big = trade(id='b-2', executed_at=tie, price=2.0, underlying_price=200.0)
    earlier = trade(id='z-9', executed_at=datetime(2026, 6, 15, 13, 50, tzinfo=UTC), price=4.0)
    later = trade(id='a-0', executed_at=datetime(2026, 6, 15, 14, 10, tzinfo=UTC), price=5.0)
    results = []
    for name, tied in (('asc', [small, big]), ('desc', [big, small]), ('again', [big, small])):
        directory = tmp_path / name
        directory.mkdir()
        rows = [{**row, 'option_chain_id': 'TIE'} for row in tied]
        rows += [{**later, 'option_chain_id': 'ORDER'}, {**earlier, 'option_chain_id': 'ORDER'}]
        results.append(by_chain(build(directory, rows)))
    for chains in results:
        tie_row = chains['TIE']
        assert (tie_row['first_price'], tie_row['last_price']) == (1.0, 2.0)
        assert (tie_row['first_underlying'], tie_row['last_underlying']) == (100.0, 200.0)
        order_row = chains['ORDER']
        assert (order_row['first_price'], order_row['last_price']) == (4.0, 5.0)
    assert results[0] == results[1] == results[2]


def test_spxw_ndxp_ticker_override(tmp_path):
    rows = [
        trade(option_chain_id='SPXW260615C06800000', underlying_symbol='SPX'),
        trade(option_chain_id='NDXP260615C25000000', underlying_symbol='NDX'),
        trade(option_chain_id='SPX260619C06800000', underlying_symbol='SPX'),
        trade(option_chain_id='AAPL260616C00200000', underlying_symbol='AAPL'),
    ]
    chains = by_chain(build(tmp_path, rows))
    assert {k: (v['ticker'], v['underlying_symbol']) for k, v in chains.items()} == {
        'SPXW260615C06800000': ('SPXW', 'SPX'),
        'NDXP260615C25000000': ('NDXP', 'NDX'),
        'SPX260619C06800000': ('SPX', 'SPX'),
        'AAPL260616C00200000': ('AAPL', 'AAPL'),
    }


def test_chain_descriptors_come_from_the_chain(tmp_path):
    rows = [trade(option_type='put', strike=195.0, expiry=date(2026, 6, 19))]
    row = build(tmp_path, rows)[0]
    assert (row['option_type'], row['strike'], row['expiry']) == ('put', 195.0, date(2026, 6, 19))
    assert (row['day_oi'], row['first_underlying']) == (100, 200.0)


def test_missing_required_column_fails_by_name(tmp_path):
    tape = write_tape(tmp_path / 'tape.parquet', [trade()], drop=('tags',))
    out = tmp_path / 'chains.parquet'
    with pytest.raises(ChainsBuildError, match='tags'):
        build_chains(tape, DAY, out)
    assert not out.exists()
    assert not out.with_name(out.name + '.tmp').exists()


def test_every_missing_column_is_named_and_a_prior_output_survives(tmp_path):
    out = tmp_path / 'chains.parquet'
    build_chains(write_tape(tmp_path / 'good.parquet', [trade()]), DAY, out)
    before = out.read_bytes()
    bad = write_tape(tmp_path / 'bad.parquet', [trade()], drop=('size', 'canceled'))
    with pytest.raises(ChainsBuildError) as raised:
        build_chains(bad, DAY, out)
    assert 'size' in str(raised.value) and 'canceled' in str(raised.value)
    assert out.read_bytes() == before
    assert not out.with_name(out.name + '.tmp').exists()


def test_a_bad_value_fails_without_echoing_it_and_leaves_no_file(tmp_path):
    tape = tmp_path / 'tape.parquet'
    write_tape(tape, [trade()])
    table = pq.read_table(tape)
    index = table.schema.get_field_index('strike')
    pq.write_table(table.set_column(index, 'strike', pa.array(['SECRET-VALUE'])), tape)
    out = tmp_path / 'chains.parquet'
    with pytest.raises(ChainsBuildError) as raised:
        build_chains(tape, DAY, out)
    assert 'SECRET-VALUE' not in str(raised.value)
    assert raised.value.__cause__ is None
    assert not out.exists()
    assert not out.with_name(out.name + '.tmp').exists()


def test_an_unreadable_tape_fails_as_a_build_error(tmp_path):
    out = tmp_path / 'chains.parquet'
    with pytest.raises(ChainsBuildError):
        build_chains(tmp_path / 'absent.parquet', DAY, out)
    assert not out.exists()


def test_a_day_with_no_kept_rows_writes_an_empty_file_with_the_schema(tmp_path):
    tape = write_tape(tmp_path / 'tape.parquet', [trade(canceled=True)])
    out = tmp_path / 'chains.parquet'
    assert build_chains(tape, DAY, out) == 0
    assert [(f.name, str(f.type)) for f in pq.read_schema(out)] == CHAINS_SCHEMA
    assert pq.read_table(out).num_rows == 0


# ── the session: connect ───────────────────────────────────────


def test_connect_pins_zone_threads_memory_and_spill(tmp_path):
    with duckdb.connect() as reference:
        reference.execute("SET memory_limit = '4GB'")
        four_gb = reference.execute("SELECT current_setting('memory_limit')").fetchone()[0]

    with _eod_flow.connect() as con:
        zone, threads, memory = con.execute(
            "SELECT current_setting('TimeZone'), current_setting('threads'), "
            "current_setting('memory_limit')"
        ).fetchone()
    assert (zone, threads, memory) == ('UTC', 4, four_gb)

    with _eod_flow.connect(tmp_path) as spilling:
        spill = spilling.execute("SELECT current_setting('temp_directory')").fetchone()[0]
    assert Path(spill).resolve() == tmp_path.resolve()


@pytest.mark.parametrize('zone', ['America/Chicago', 'Asia/Tokyo'])
def test_connect_overrides_the_host_zone(host_zone, zone):
    host_zone(zone)
    with _eod_flow.connect() as con:
        assert con.execute("SELECT current_setting('TimeZone')").fetchone()[0] == 'UTC'


# ── rollup and the headlines ───────────────────────────────────


def test_open_window_counts_0930_et_on_both_sides_of_dst(tmp_path):
    by_day = dst_by_day_files(tmp_path / 'by-day')
    result = rollup(by_day)
    assert window_counts(result) == [1, 1]
    morning = {m['trade_date']: m for m in result['morning_clustering']}
    assert morning['2026-10-30']['total_chains'] == 1
    assert morning['2026-11-03']['total_chains'] == 3
    assert morning['2026-11-03']['first_30min'] == 1


def test_open_window_edges_are_whole_minutes_inclusive(tmp_path):
    by_day = tmp_path / 'by-day'
    by_day.mkdir()
    day = date(2026, 11, 3)

    def at(hour: int, minute: int, second: int, chain_id: str) -> dict:
        ts = datetime(2026, 11, 3, hour, minute, second, tzinfo=UTC)
        return chain_row(day, option_chain_id=chain_id, first_ts=ts, last_ts=ts)

    rows = [
        at(14, 29, 59, 'before'),  # 09:29:59 ET
        at(14, 30, 0, 'open'),  # 09:30:00 ET
        at(15, 0, 59, 'last-second'),  # 10:00:59 ET: still the 10:00 minute
        at(15, 1, 0, 'after'),  # 10:01:00 ET
    ]
    write_by_day(by_day / '2026-11-03-chains.parquet', rows)
    assert window_counts(rollup(by_day)) == [2]


def test_results_do_not_depend_on_the_host_timezone(tmp_path, monkeypatch):
    by_day = dst_by_day_files(tmp_path / 'by-day')
    real_connect = _eod_flow.connect

    def connect_in_chicago(temp_dir=None):
        con = real_connect(temp_dir)
        con.execute("SET TimeZone = 'America/Chicago'")
        return con

    monkeypatch.setattr(_eod_flow, 'connect', connect_in_chicago)
    assert window_counts(rollup(by_day)) == [1, 1]


@pytest.mark.parametrize('zone', ['America/Chicago', 'Asia/Tokyo'])
def test_a_host_in_another_zone_changes_nothing(tmp_path, host_zone, zone):
    """Naive legacy timestamps are UTC, and the window is ET, whatever the host says."""
    by_day = tmp_path / 'by-day'
    by_day.mkdir()
    # 14:35Z on 2026-11-03 is 09:35 ET: in the window. Written as a naive legacy print.
    ts = datetime(2026, 11, 3, 14, 35, tzinfo=UTC)
    tape = write_tape(tmp_path / 'tape.parquet', [trade(executed_at=ts)], layout='legacy')
    host_zone(zone)
    build_chains(tape, date(2026, 11, 3), by_day / '2026-11-03-chains.parquet')
    built = read_rows(by_day / '2026-11-03-chains.parquet')[0]
    assert built['first_ts'] == ts
    assert window_counts(rollup(by_day)) == [1]


def headline_days(directory: Path) -> Path:
    """Two by-day files whose rollup has a watchlist winner, a loser and a single name.

    The winner (strike 6810.5, 11-03 14:35Z = 09:35 EST = 08:35 CST) and the loser
    (strike 6720.5, 10-30 13:35Z = 09:35 EDT = 08:35 CDT) both first printed at 08:35 CT.
    The strikes are distinct from every other number the headlines print.
    """
    directory.mkdir(exist_ok=True)
    winner_at = datetime(2026, 11, 3, 14, 35, tzinfo=UTC)
    loser_at = datetime(2026, 10, 30, 13, 35, tzinfo=UTC)
    winner = chain_row(
        date(2026, 11, 3),
        option_chain_id='WIN',
        strike=6810.5,
        first_ts=winner_at,
        last_ts=winner_at,
        first_price=10.0,
        last_price=15.0,
    )
    single_name = chain_row(
        date(2026, 11, 3),
        option_chain_id='AMD',
        ticker='AMD',
        underlying_symbol='AMD',
        equity_type=None,
        total_premium=2_000_000.0,
    )
    loser = chain_row(
        date(2026, 10, 30),
        option_chain_id='LOSE',
        strike=6720.5,
        first_ts=loser_at,
        last_ts=loser_at,
        first_price=10.0,
        last_price=5.0,
    )
    write_by_day(directory / '2026-11-03-chains.parquet', [winner, single_name])
    write_by_day(directory / '2026-10-30-chains.parquet', [loser])
    return directory


def test_headline_first_time_is_ct(tmp_path):
    text = write_headlines(rollup(headline_days(tmp_path / 'by-day')))
    assert '## 9:30-10:00 ET (8:30-9:00 CT) open-auction window directional flow %' in text
    assert '## 8:30-9:00 CT (open-auction window)' not in text
    assert 'First CT' in text
    (winner_line,) = [line for line in text.splitlines() if '6810.5' in line]
    (loser_line,) = [line for line in text.splitlines() if '6720.5' in line]
    for line in (winner_line, loser_line):
        assert line.rstrip().endswith('08:35')


def test_a_naive_first_ts_in_a_hand_built_rollup_is_read_as_utc():
    """write_headlines must not fall back to the host zone for a naive datetime."""
    rolled = {
        'days': ['2026-11-03'],
        'watchlist_winners': [
            {
                'trade_date': '2026-11-03',
                'ticker': 'SPXW',
                'strike': 6800.0,
                'option_type': 'call',
                'expiry': date(2026, 11, 3),
                'vol_oi_ratio': 10.0,
                'total_premium': 500_000.0,
                'ask_pct': 0.9,
                'opt_return': 0.5,
                'und_return': 0.001,
                'first_ts': datetime(2026, 11, 3, 14, 35),
            }
        ],
    }
    (line,) = [x for x in write_headlines(rolled).splitlines() if '6800.0' in x]
    assert line.rstrip().endswith('08:35')


def test_rollup_reads_mixed_seed_and_tape_days(tmp_path):
    by_day = tmp_path / 'by-day'
    by_day.mkdir()
    # A seeded-style day: Common Stock with a sector, the columns in the other order and
    # one the tape-built day lacks. Files with different column sets need union_by_name.
    write_by_day(
        by_day / '2026-05-15-chains.parquet',
        [
            chain_row(
                date(2026, 5, 15),
                option_chain_id='NVDA260515C00200000',
                ticker='NVDA',
                underlying_symbol='NVDA',
                equity_type='Common Stock',
                sector='Tech',
                total_premium=2_000_000.0,
            )
        ],
        reverse_columns=True,
        extra_column='source_csv',
    )
    tape = write_tape(
        tmp_path / 'tape.parquet',
        [
            trade(option_chain_id='AMD260616C00200000', underlying_symbol='AMD', premium=1_500_000.0),
            trade(
                option_chain_id='SPY260616C00500000',
                underlying_symbol='SPY',
                premium=3_000_000.0,
                tags='{ask_side,etf}',
            ),
        ],
    )
    build_chains(tape, DAY, by_day / '2026-06-15-chains.parquet')

    result = rollup(by_day)
    assert result['days'] == ['2026-05-15', '2026-06-15']
    assert len(result['days']) == 2
    assert {row['ticker'] for row in result['single_names']} == {'NVDA', 'AMD'}
    assert set(result) == {
        'days',
        'daily_stats',
        'tickers',
        'repeat_strikes',
        'single_names',
        'watchlist_winners',
        'watchlist_losers',
        'out_of_watchlist_candidates',
        'morning_clustering',
    }
    assert 'EOD Option-Flow Multi-Day Rollup (2 days)' in write_headlines(result)


def test_rollup_of_an_empty_directory_has_no_days(tmp_path):
    result = rollup(tmp_path)
    assert result['days'] == []
    assert 'Rollup (0 days)' in write_headlines(result)


def test_rollup_rows_carry_a_utc_first_ts(tmp_path):
    by_day = tmp_path / 'by-day'
    by_day.mkdir()
    ts = datetime(2026, 11, 3, 14, 35, 7, 123456, tzinfo=UTC)
    write_by_day(
        by_day / '2026-11-03-chains.parquet',
        [chain_row(date(2026, 11, 3), first_ts=ts, last_ts=ts, first_price=10.0, last_price=15.0)],
    )
    (winner,) = rollup(by_day)['watchlist_winners']
    assert winner['first_ts'] == ts
    assert winner['first_ts'].utcoffset().total_seconds() == 0


def test_rollup_and_headlines_need_no_pytz(tmp_path):
    """DuckDB imports pytz to hand a TIMESTAMPTZ to Python; the nightly image has none.

    A fresh interpreter with pytz blocked, so DuckDB's import cache cannot hide it. The
    rollup has a winner, a loser and a single name: the rows that carry a first_ts.
    """
    by_day = headline_days(tmp_path / 'by-day')
    code = textwrap.dedent(
        """
        import sys
        sys.modules['pytz'] = None
        sys.path.insert(0, sys.argv[1])
        from pathlib import Path
        import _eod_flow
        result = _eod_flow.rollup(Path(sys.argv[2]))
        counts = [len(result[k]) for k in ('watchlist_winners', 'watchlist_losers', 'single_names')]
        assert '08:35' in _eod_flow.write_headlines(result)
        print(len(result['days']), *counts)
        """
    )
    done = subprocess.run(
        [sys.executable, '-I', '-c', code, str(SCRIPTS_DIR), str(by_day)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == '2 1 1 1'


def test_paths_with_a_quote_are_quoted(tmp_path):
    folder = tmp_path / "o'clock"
    folder.mkdir()
    tape = write_tape(folder / 'tape.parquet', [trade()])
    out = folder / '2026-06-15-chains.parquet'
    assert build_chains(tape, DAY, out, temp_dir=folder) == 1
    assert rollup(folder)['days'] == ['2026-06-15']


# ── the analyze CLI ────────────────────────────────────────────


TITLE = 'EOD Option-Flow Multi-Day Rollup (1 days)'


def tape_print(day: str) -> dict:
    """The one print of a CLI tape day: a chain named for the day, at 09:35 ET."""
    when = datetime.fromisoformat(day).replace(hour=13, minute=35, tzinfo=UTC)
    return trade(executed_at=when, option_chain_id=f'AAPL{day.replace("-", "")}C00200000')


def tape_dir_with(tmp_path: Path, *days: str) -> Path:
    directory = tmp_path / 'tape'
    directory.mkdir(exist_ok=True)
    for day in days:
        write_tape(directory / f'{day}-fulltape.parquet', [tape_print(day)])
    return directory


def cli(tmp_path: Path, *args: str) -> list[str]:
    """`args`, with the run's outputs sent under tmp_path."""
    return [*args, '--out-dir', str(tmp_path / 'out'), '--by-day-dir', str(tmp_path / 'by-day')]


def seed_by_day(tmp_path: Path, day: str) -> Path:
    """A by-day file standing in for a seeded day: one chain, named SEED."""
    directory = tmp_path / 'by-day'
    directory.mkdir(exist_ok=True)
    row = chain_row(date.fromisoformat(day), option_chain_id='SEED')
    return write_by_day(directory / f'{day}-chains.parquet', [row])


def built_chain_ids(tmp_path: Path, day: str) -> list[str]:
    return [r['option_chain_id'] for r in read_rows(tmp_path / 'by-day' / f'{day}-chains.parquet')]


def test_analyze_cli_requires_a_source_for_day_processing(analyze, tmp_path, capsys):
    for extra in (['--day', '2026-06-15'], []):
        with pytest.raises(SystemExit) as raised:
            analyze.main(cli(tmp_path, *extra))
        assert raised.value.code == 2
        # The last line is the error itself; the usage lines above it list the flags anyway.
        error = capsys.readouterr().err.strip().splitlines()[-1]
        assert 'error:' in error and '--tape-dir' in error and '--r2' in error
    assert not (tmp_path / 'out').exists()
    assert not (tmp_path / 'by-day').exists()

    seed_by_day(tmp_path, '2026-06-15')
    assert analyze.main(cli(tmp_path, '--rollup-only')) == 0
    rolled = json.loads((tmp_path / 'out' / 'cumulative-rollup.json').read_text(encoding='utf-8'))
    assert rolled['days'] == ['2026-06-15']


def test_analyze_cli_takes_one_source_not_two(analyze, tmp_path, capsys):
    with pytest.raises(SystemExit) as raised:
        analyze.main(cli(tmp_path, '--day', '2026-06-15', '--tape-dir', str(tmp_path), '--r2'))
    assert raised.value.code == 2
    assert 'not allowed with' in capsys.readouterr().err


@pytest.mark.parametrize('day', ['15-06-2026', '2026-13-01', 'yesterday', ''])
def test_analyze_cli_rejects_a_malformed_day(analyze, tmp_path, capsys, day):
    with pytest.raises(SystemExit) as raised:
        analyze.main(cli(tmp_path, '--day', day, '--tape-dir', str(tmp_path)))
    assert raised.value.code == 2
    assert '--day' in capsys.readouterr().err


def test_analyze_cli_builds_a_day_from_a_tape_dir(analyze, tmp_path, capsys):
    tapes = tape_dir_with(tmp_path, '2026-06-15')
    assert analyze.main(cli(tmp_path, '--day', '2026-06-15', '--tape-dir', str(tapes))) == 0
    assert built_chain_ids(tmp_path, '2026-06-15') == ['AAPL20260615C00200000']
    rolled = json.loads((tmp_path / 'out' / 'cumulative-rollup.json').read_text(encoding='utf-8'))
    assert rolled['days'] == ['2026-06-15']
    headlines = (tmp_path / 'out' / 'cumulative-headlines.txt').read_text(encoding='utf-8')
    assert TITLE in headlines
    assert TITLE in capsys.readouterr().out


def test_analyze_cli_by_day_dir_defaults_under_out_dir(analyze, tmp_path):
    tapes = tape_dir_with(tmp_path, '2026-06-15')
    args = ['--day', '2026-06-15', '--tape-dir', str(tapes), '--out-dir', str(tmp_path / 'out')]
    assert analyze.main(args) == 0
    assert (tmp_path / 'out' / 'by-day' / '2026-06-15-chains.parquet').exists()
    assert (tmp_path / 'out' / 'cumulative-rollup.json').exists()


def test_analyze_cli_builds_every_missing_day_from_chains_start(analyze, tmp_path):
    tapes = tape_dir_with(tmp_path, '2026-04-10', '2026-06-15', '2026-06-16')
    seed_by_day(tmp_path, '2026-06-15')
    assert analyze.main(cli(tmp_path, '--tape-dir', str(tapes))) == 0
    # 04-10 is before CHAINS_START; 06-15 has a by-day file; only 06-16 is built.
    assert not (tmp_path / 'by-day' / '2026-04-10-chains.parquet').exists()
    assert built_chain_ids(tmp_path, '2026-06-15') == ['SEED']
    assert built_chain_ids(tmp_path, '2026-06-16') == ['AAPL20260616C00200000']

    assert analyze.main(cli(tmp_path, '--tape-dir', str(tapes), '--force')) == 0
    assert built_chain_ids(tmp_path, '2026-06-15') == ['AAPL20260615C00200000']
    assert not (tmp_path / 'by-day' / '2026-04-10-chains.parquet').exists()


def test_analyze_cli_skips_an_existing_day_unless_forced(analyze, tmp_path):
    tapes = tape_dir_with(tmp_path, '2026-06-15')
    seed_by_day(tmp_path, '2026-06-15')
    args = cli(tmp_path, '--day', '2026-06-15', '--tape-dir', str(tapes))
    assert analyze.main(args) == 0
    assert built_chain_ids(tmp_path, '2026-06-15') == ['SEED']
    assert analyze.main([*args, '--force']) == 0
    assert built_chain_ids(tmp_path, '2026-06-15') == ['AAPL20260615C00200000']


def test_analyze_cli_no_rollup_writes_only_the_day(analyze, tmp_path):
    tapes = tape_dir_with(tmp_path, '2026-06-15')
    assert analyze.main(cli(tmp_path, '--day', '2026-06-15', '--tape-dir', str(tapes), '--no-rollup')) == 0
    assert built_chain_ids(tmp_path, '2026-06-15') == ['AAPL20260615C00200000']
    assert not (tmp_path / 'out').exists()


def test_analyze_cli_names_a_day_with_no_tape(analyze, tmp_path, capsys):
    tapes = tape_dir_with(tmp_path, '2026-06-15')
    code = analyze.main(cli(tmp_path, '--day', '2026-06-16', '--tape-dir', str(tapes)))
    assert code == 1
    assert '2026-06-16' in capsys.readouterr().err
    assert not (tmp_path / 'by-day' / '2026-06-16-chains.parquet').exists()


def test_analyze_cli_reports_a_failed_day_and_carries_on(analyze, tmp_path, capsys):
    tapes = tape_dir_with(tmp_path, '2026-06-15')
    write_tape(tapes / '2026-06-16-fulltape.parquet', [tape_print('2026-06-16')], drop=('tags',))
    code = analyze.main(cli(tmp_path, '--tape-dir', str(tapes)))
    assert code == 1
    err = capsys.readouterr().err
    assert '2026-06-16' in err and 'tags' in err
    assert built_chain_ids(tmp_path, '2026-06-15') == ['AAPL20260615C00200000']
    assert not (tmp_path / 'by-day' / '2026-06-16-chains.parquet').exists()
    rolled = json.loads((tmp_path / 'out' / 'cumulative-rollup.json').read_text(encoding='utf-8'))
    assert rolled['days'] == ['2026-06-15']


def test_analyze_script_runs_from_any_directory(tmp_path):
    """Run as a script, only its own folder is on sys.path: it must find _eod_flow itself."""
    seed_by_day(tmp_path, '2026-06-15')
    elsewhere = tmp_path / 'elsewhere'
    elsewhere.mkdir()
    done = subprocess.run(
        [sys.executable, str(ANALYZE_PATH), *cli(tmp_path, '--rollup-only')],
        capture_output=True,
        cwd=elsewhere,
        env={**os.environ, 'PYTHONIOENCODING': 'utf-8'},
        timeout=120,
    )
    assert done.returncode == 0, done.stderr.decode('utf-8', 'replace')
    assert TITLE in done.stdout.decode('utf-8')
    assert (tmp_path / 'out' / 'cumulative-headlines.txt').exists()


def test_importing_analyze_loads_no_boto3():
    code = textwrap.dedent(
        """
        import runpy, sys
        runpy.run_path(sys.argv[1], run_name='eod_flow_analyze')
        loaded = [m for m in ('boto3', 'botocore', '_tape_reader') if m in sys.modules]
        print(','.join(loaded) or 'none')
        """
    )
    done = subprocess.run(
        [sys.executable, '-I', '-c', code, str(ANALYZE_PATH)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == 'none'


# ── analyze --r2, through a stand-in for _tape_reader.TapeReader ──


class Lake:
    """What the fake R2 holds, and what the run did to its reader."""

    def __init__(self, tape: Path, landed: set[date], missing: set[date] | None = None) -> None:
        self.tape = tape
        self.landed = landed
        self.missing = missing or set()  # listed, but the GET finds no object
        self.fetch_error: Exception | None = None
        self.from_env_error: Exception | None = None
        self.calls: list[tuple] = []
        self.cache_dirs: list[Path] = []

    def fetched(self) -> list[date]:
        return [call[1] for call in self.calls if call[0] == 'fetch']

    def released(self) -> list[date]:
        return [call[1] for call in self.calls if call[0] == 'release']


class FakeReader:
    """The TapeReader surface analyze uses: landed_days, fetch_day, release and close."""

    def __init__(self, lake: Lake, cache_dir: Path) -> None:
        self._lake = lake
        self._cache_dir = cache_dir

    def _path(self, day: date) -> Path:
        return self._cache_dir / f'{day.isoformat()}-fulltape.parquet'

    def landed_days(self) -> set[date]:
        self._lake.calls.append(('landed_days',))
        return set(self._lake.landed)

    def fetch_day(self, day: date, deadline: float | None = None) -> Path | None:
        self._lake.calls.append(('fetch', day))
        if self._lake.fetch_error is not None:
            raise self._lake.fetch_error
        if day in self._lake.missing:
            return None
        self._path(day).write_bytes(self._lake.tape.read_bytes())
        return self._path(day)

    def release(self, day: date) -> None:
        self._lake.calls.append(('release', day))
        self._path(day).unlink(missing_ok=True)

    def close(self) -> None:
        self._lake.calls.append(('close',))
        for leftover in self._cache_dir.glob('*.parquet'):
            leftover.unlink()


class FakeTapeReader:
    """Stands in for the TapeReader class: from_env is the only constructor analyze uses."""

    def __init__(self, lake: Lake) -> None:
        self._lake = lake

    def from_env(self, cache_dir: Path) -> FakeReader:
        if self._lake.from_env_error is not None:
            raise self._lake.from_env_error
        self._lake.cache_dirs.append(Path(cache_dir))
        Path(cache_dir).mkdir(parents=True, exist_ok=True)  # as the real constructor does
        return FakeReader(self._lake, Path(cache_dir))


@pytest.fixture
def lake(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Lake:
    """analyze imports TapeReader from _tape_reader inside build_from_r2, at call time,
    so that module's attribute is the boundary to patch."""
    fixture_dir = tmp_path / 'fixture-tape'
    fixture_dir.mkdir()
    fake = Lake(
        write_tape(fixture_dir / 'tape.parquet', [tape_print('2026-06-16')]),
        {date(2026, 4, 10), date(2026, 6, 15), date(2026, 6, 16), date(2026, 6, 17)},
    )
    monkeypatch.setattr(_tape_reader, 'TapeReader', FakeTapeReader(fake))
    return fake


def test_analyze_cli_r2_fetches_each_missing_day_once_and_releases_it(analyze, tmp_path, lake):
    seed_by_day(tmp_path, '2026-06-15')
    assert analyze.main(cli(tmp_path, '--r2')) == 0
    # 04-10 predates CHAINS_START and 06-15 already has its file: neither is fetched.
    assert lake.fetched() == [date(2026, 6, 16), date(2026, 6, 17)]
    assert lake.released() == lake.fetched()
    assert lake.calls[-1] == ('close',)
    assert lake.calls.count(('close',)) == 1
    assert built_chain_ids(tmp_path, '2026-06-15') == ['SEED']
    assert [r['trade_date'] for r in read_rows(tmp_path / 'by-day' / '2026-06-17-chains.parquet')] == [
        '2026-06-17'
    ]
    assert all(not cache.exists() for cache in lake.cache_dirs)


def test_analyze_cli_r2_one_day_asks_for_just_that_day(analyze, tmp_path, lake):
    assert analyze.main(cli(tmp_path, '--day', '2026-06-16', '--r2')) == 0
    assert lake.calls == [('fetch', date(2026, 6, 16)), ('release', date(2026, 6, 16)), ('close',)]


def test_analyze_cli_r2_does_not_fetch_a_day_it_would_skip(analyze, tmp_path, lake):
    seed_by_day(tmp_path, '2026-06-16')
    assert analyze.main(cli(tmp_path, '--day', '2026-06-16', '--r2')) == 0
    assert lake.fetched() == []
    assert lake.calls == [('close',)]


def test_analyze_cli_r2_names_a_day_the_lake_lacks(analyze, tmp_path, lake, capsys):
    lake.missing = {date(2026, 6, 16)}
    assert analyze.main(cli(tmp_path, '--day', '2026-06-16', '--r2')) == 1
    assert '2026-06-16' in capsys.readouterr().err
    assert lake.calls == [('fetch', date(2026, 6, 16)), ('close',)]


@pytest.mark.parametrize('where', ['from_env', 'fetch'])
def test_analyze_cli_r2_read_error_ends_the_run_and_cleans_up(analyze, tmp_path, lake, where):
    error = _tape_reader.TapeReadError('R2 is not configured: missing R2_ENDPOINT_URL')
    if where == 'from_env':
        lake.from_env_error = error
    else:
        lake.fetch_error = error
    with pytest.raises(SystemExit) as raised:
        analyze.main(cli(tmp_path, '--day', '2026-06-16', '--r2'))
    assert 'missing R2_ENDPOINT_URL' in str(raised.value.code)
    assert not (tmp_path / 'by-day' / '2026-06-16-chains.parquet').exists()
    assert all(not cache.exists() for cache in lake.cache_dirs)
    assert lake.calls.count(('close',)) == (0 if where == 'from_env' else 1)
