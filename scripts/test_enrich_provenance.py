"""Provenance, selection and conditional writes in enrich_lottery_outcomes.py.

The live Vercel enrich cron writes the same lottery_finder_fires rows, so
every write the script makes is conditional (it only fills a row nobody has
filled) and tagged with where it came from (outcome_source / inversion_source
plus a version), and the set of work must shrink to zero: a fire the tape
cannot price is tagged once, a fire whose net flow does not exist yet is left
alone and not selected until it does.

Neon is faked at the psycopg2 boundary (connect_with_retry, execute_values,
the cursor), as in test_enrich_missing_archive.py. The two parquet layouts of
the Full Tape (the legacy 42-column files with decimal numerics and the new
52-column ones) are written for real and read by the real loader. Run:

    ml/.venv/Scripts/python -m pytest -q scripts/test_enrich_provenance.py
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import enrich_lottery_outcomes as lottery  # noqa: E402

DAY = '2026-07-22'
ENTRY = datetime(2026, 7, 22, 15, 0, tzinfo=timezone.utc)

TSLA = 'TSLA260722C00300000'  # priced; flow rises to minute 8 then falls
AAPL = 'AAPL260722C00200000'  # its only print is before the entry
NVDA = 'NVDA260722C00100000'  # not in the tape at all
QQQ = 'QQQ260722C00500000'  # priced; no net-flow rows exist for it

PENDING = 'enriched_at IS NULL'
EMPTY = 'enriched_at IS NOT NULL AND peak_ceiling_pct IS NULL AND outcome_source IS NULL'
ALL = 'peak_ceiling_pct IS NULL AND outcome_source IS NULL'
INVERSION_WORK = 'realized_flow_inversion_pct IS NULL AND inversion_source IS NULL'
PREDICATES = {'pending': PENDING, 'empty': EMPTY, 'all': ALL}


def minute(m: int) -> datetime:
    return ENTRY + timedelta(minutes=m)


def norm(sql: str) -> str:
    return ' '.join(sql.split())


# ── the day's tape, in both layouts ────────────────────────────


def _print(chain: str, at: datetime, price: Decimal, canceled: bool = False) -> dict:
    return {
        'executed_at': at,
        'option_chain_id': chain,
        'price': price,
        'canceled': canceled,
        'nbbo_bid': price - Decimal('0.05'),
        'nbbo_ask': price + Decimal('0.05'),
        'size': 1,
    }


def tape_prints() -> list[dict]:
    """One set of prints for both layouts. TSLA and QQQ trade up 0.05 a minute
    for 20 minutes from 1.05; AAPL prints once, before the entry. Two TSLA
    prints must be dropped by the loader: a canceled one at 9.00 and one at
    price 0."""
    prints = []
    for chain in (TSLA, QQQ):
        for m in range(1, 21):
            prints.append(_print(chain, minute(m), Decimal('1.00') + Decimal('0.05') * m))
    prints.append(_print(TSLA, minute(10) + timedelta(seconds=30), Decimal('9.00'), True))
    prints.append(_print(TSLA, minute(12) + timedelta(seconds=30), Decimal('0.00')))
    prints.append(_print(AAPL, minute(-5), Decimal('1.20')))
    return prints


def _legacy_table(prints: list[dict]) -> pa.Table:
    """Legacy file: core columns, decimal128 numerics, bool canceled, and
    executed_at stored naive (UTC)."""
    dec = pa.decimal128(18, 4)
    schema = pa.schema(
        [
            ('executed_at', pa.timestamp('us')),
            ('option_chain_id', pa.string()),
            ('price', dec),
            ('canceled', pa.bool_()),
            ('nbbo_bid', dec),
            ('nbbo_ask', dec),
            ('size', pa.int64()),
        ]
    )
    data = {name: [p[name] for p in prints] for name in schema.names}
    data['executed_at'] = [t.replace(tzinfo=None) for t in data['executed_at']]
    return pa.table(data, schema=schema)


def _new_table(prints: list[dict]) -> pa.Table:
    """New file: Float64 numerics, Boolean canceled, UTC timestamps and the
    columns the 52-column layout adds (the loader ignores them)."""
    schema = pa.schema(
        [
            ('executed_at', pa.timestamp('us', tz='UTC')),
            ('option_chain_id', pa.string()),
            ('price', pa.float64()),
            ('canceled', pa.bool_()),
            ('nbbo_bid', pa.float64()),
            ('nbbo_ask', pa.float64()),
            ('size', pa.int64()),
            ('trading_hours', pa.string()),
            ('exchange_id', pa.string()),
        ]
    )
    data = {name: [p.get(name) for p in prints] for name in schema.names}
    for name in ('price', 'nbbo_bid', 'nbbo_ask'):
        data[name] = [float(v) for v in data[name]]
    data['trading_hours'] = ['regular'] * len(prints)
    data['exchange_id'] = ['XCBO'] * len(prints)
    return pa.table(data, schema=schema)


def write_tape(directory: Path, parquet_format: str, layout: str = 'new') -> Path:
    path = directory / lottery.PARQUET_FORMATS[parquet_format].format(date=DAY)
    build = _legacy_table if layout == 'legacy' else _new_table
    pq.write_table(build(tape_prints()), path)
    return path


# ── fire rows and net flow, as the SELECTs return them ─────────


def fire_row(fire_id: int, chain: str) -> tuple:
    # entry_price is NUMERIC: psycopg2 hands back a Decimal.
    return (fire_id, chain, ENTRY, Decimal('1.0000'))


def flow_fire_row(fire_id: int, chain: str) -> tuple:
    symbol = chain.split('2607')[0]
    return (fire_id, chain, symbol, 'C', ENTRY, Decimal('1.0000'), date(2026, 7, 22))


def rising_then_falling_flow() -> list[tuple[datetime, Decimal]]:
    """Cumulative call premium peaks at minute 8, then falls: the inversion is
    found at minute 15, where TSLA trades at 1.75 (+75% on a 1.00 entry)."""
    return [
        (minute(m), Decimal('100.00') if m <= 8 else Decimal('-100.00'))
        for m in range(1, 21)
    ]


def flat_flow() -> list[tuple[datetime, Decimal]]:
    return [(minute(m), Decimal('0.00')) for m in range(1, 11)]


# ── Neon at the psycopg2 boundary ──────────────────────────────


@dataclass
class ValuesWrite:
    sql: str
    rows: list
    template: str | None
    kwargs: dict


class FakeCursor:
    def __init__(self, db: FakeDb) -> None:
        self.db = db
        self.rows: list = []
        self.rowcount = 0

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, *_exc: object) -> None:
        return None

    def execute(self, sql: str, params: tuple | None = None) -> None:
        sql = norm(sql)
        self.db.executed.append((sql, params))
        self.rows = self.db.answer(sql, params)
        self.rowcount = self.db.rowcount_for(sql, params)

    def fetchall(self) -> list:
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def close(self) -> None:
        pass


class FakeDb:
    """Answers the script's SELECTs and records every write."""

    def __init__(
        self,
        fires: list[tuple] | None = None,
        flow_fires: list[tuple] | None = None,
        flow: dict[tuple[str, str], list] | None = None,
        work_dates: list[str] | None = None,
        refit_rows: list[tuple] | None = None,
    ) -> None:
        self.fires = fires or []
        self.flow_fires = flow_fires or []
        self.flow = flow or {}
        self.work_dates = work_dates or []
        self.refit_rows = refit_rows or []
        self.executed: list[tuple[str, tuple | None]] = []
        self.values_writes: list[ValuesWrite] = []
        # What an UPDATE ... RETURNING hands back, as a function of the rows
        # sent; None means every row. A cron that got there first shrinks it.
        self.returning = None
        # What a plain UPDATE reports as rowcount; None means every id sent.
        self.stamp_rowcount: int | None = None

    # psycopg2 connection surface
    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def commit(self) -> None:
        pass

    def close(self) -> None:
        pass

    def answer(self, sql: str, params: tuple | None) -> list:
        if sql.startswith('SELECT DISTINCT date::text'):
            return [(d,) for d in self.work_dates]
        if sql.startswith('SELECT ts, '):
            side = 'C' if 'net_call_prem' in sql.split(' FROM ')[0] else 'P'
            return self.flow.get((params[0], side), [])
        if 'WHERE date = %s' in sql and 'entry_time_ct, entry_price' in sql:
            return self.fires
        if 'WHERE date = %s' in sql and 'trigger_time_ct' in sql:
            return self.flow_fires
        if 'GROUP BY underlying_symbol' in sql:
            return self.refit_rows
        return []

    def rowcount_for(self, sql: str, params: tuple | None) -> int:
        if sql.startswith('UPDATE') and params:
            return len(params[-1]) if self.stamp_rowcount is None else self.stamp_rowcount
        return 0

    def execute_values(self, _cur, sql, rows, template=None, **kwargs):
        rows = list(rows)
        self.values_writes.append(ValuesWrite(norm(sql), rows, template, kwargs))
        if not kwargs.get('fetch'):
            return None
        if self.returning is not None:
            return self.returning(rows)
        return [(r[0],) for r in rows]

    # what the tests ask of it
    def outcome_writes(self) -> list[ValuesWrite]:
        return [w for w in self.values_writes if 'SET realized_trail30_10_pct' in w.sql]

    def flow_writes(self) -> list[ValuesWrite]:
        return [w for w in self.values_writes if 'SET realized_flow_inversion_pct' in w.sql]

    def stamps(self, column: str) -> list[tuple[str, tuple]]:
        """Plain UPDATEs (the tag-only stamps) whose SET touches `column`."""
        return [
            (sql, params)
            for sql, params in self.executed
            if sql.startswith('UPDATE') and f'{column} = %s' in sql
        ]

    def updates_run(self) -> list[str]:
        return [sql for sql, _ in self.executed if sql.startswith('UPDATE')]


@pytest.fixture
def archive(tmp_path: Path) -> Path:
    directory = tmp_path / 'archive'
    directory.mkdir()
    return directory


@pytest.fixture
def archive_globals(monkeypatch: pytest.MonkeyPatch) -> None:
    """configure_archive / main() rebind these; restore them after the test."""
    monkeypatch.setattr(lottery, 'PARQUET_DIR', None)
    monkeypatch.setattr(
        lottery, 'PARQUET_FILE_PATTERN', lottery.PARQUET_FORMATS['trades']
    )
    monkeypatch.setattr(lottery, 'SOURCE_TAG', lottery.ARCHIVE_SOURCES['trades'])


@pytest.fixture
def make_db(monkeypatch: pytest.MonkeyPatch):
    def make(**kwargs) -> FakeDb:
        db = FakeDb(**kwargs)
        monkeypatch.setattr(lottery, 'execute_values', db.execute_values)
        return db

    return make


@pytest.fixture
def fulltape(archive: Path, archive_globals: None) -> Path:
    """A Full Tape archive holding the day, configured as the source."""
    write_tape(archive, 'fulltape')
    lottery.configure_archive(archive, 'fulltape')
    return archive


# ── vocabulary ─────────────────────────────────────────────────


def test_archive_sources_follow_the_check_vocabulary() -> None:
    # Migration #201's CHECKs: inversion_source takes fulltape or bot_eod only.
    assert lottery.ARCHIVE_SOURCES == {'trades': 'bot_eod', 'fulltape': 'fulltape'}
    assert set(lottery.ARCHIVE_SOURCES) == set(lottery.PARQUET_FORMATS)
    assert lottery.OUTCOME_VERSION == 1
    assert lottery.INVERSION_VERSION == 1


def test_configure_archive_sets_dir_pattern_and_tag(
    archive: Path, archive_globals: None
) -> None:
    lottery.configure_archive(archive, 'fulltape')
    assert lottery.PARQUET_DIR == archive
    assert lottery.PARQUET_FILE_PATTERN == '{date}-fulltape.parquet'
    assert lottery.SOURCE_TAG == 'fulltape'

    lottery.configure_archive(archive, 'trades')
    assert lottery.PARQUET_FILE_PATTERN == '{date}-trades.parquet'
    assert lottery.SOURCE_TAG == 'bot_eod'


# ── selection ──────────────────────────────────────────────────


@pytest.mark.parametrize('select', PREDICATES)
def test_select_predicates(select: str) -> None:
    db = FakeDb(work_dates=[DAY])
    lottery.fetch_unenriched(db, DAY, select)
    fetch_sql = db.executed[-1][0]
    where = fetch_sql.split('WHERE date = %s AND ', 1)[1].split(' ORDER BY')[0]
    assert where == PREDICATES[select]

    lottery.list_work_dates(db, select)
    dates_sql = db.executed[-1][0]
    assert f'WHERE {PREDICATES[select]}' in dates_sql
    assert dates_sql.endswith('ORDER BY 1')
    # Only 'all' also looks for inversion work (and the flow that makes it doable).
    has_inversion = INVERSION_WORK in dates_sql
    assert has_inversion is (select == 'all')
    assert ('net_flow_per_ticker_history' in dates_sql) is (select == 'all')


def test_fetch_unenriched_defaults_to_pending() -> None:
    db = FakeDb()
    lottery.fetch_unenriched(db, DAY)
    assert f'WHERE date = %s AND {PENDING} ORDER BY' in db.executed[-1][0]


@pytest.mark.parametrize('select', PREDICATES)
def test_enrich_one_date_selects_what_it_is_told(
    select: str, fulltape: Path, make_db
) -> None:
    db = make_db()

    lottery.enrich_one_date(db, DAY, select=select)

    assert f'WHERE date = %s AND {PREDICATES[select]} ORDER BY' in db.executed[0][0]


def test_flow_unfilled_excludes_tagged_rows() -> None:
    db = FakeDb()
    lottery.fetch_flow_unfilled(db, DAY)
    assert f'WHERE date = %s AND {INVERSION_WORK} ORDER BY id ASC' in db.executed[-1][0]


def test_list_work_dates_bounds_are_parameters() -> None:
    db = FakeDb(work_dates=['2026-07-22', '2026-07-23'])
    got = lottery.list_work_dates(db, 'pending', since='2026-06-01', through='2026-06-30')
    assert got == ['2026-07-22', '2026-07-23']
    sql, params = db.executed[-1]
    assert 'date >= %s::date' in sql
    assert 'date <= %s::date' in sql
    assert params == ('2026-06-01', '2026-06-30')

    lottery.list_work_dates(db, 'pending', through='2026-06-30')
    sql, params = db.executed[-1]
    assert 'date >= %s::date' not in sql
    assert params == ('2026-06-30',)


def test_list_work_dates_all_bounds_both_halves_of_the_union() -> None:
    db = FakeDb()
    lottery.list_work_dates(db, 'all', since='2026-06-01', through='2026-06-30')
    sql, params = db.executed[-1]
    assert sql.count('date >= %s::date') == 2
    assert sql.count('date <= %s::date') == 2
    assert params == ('2026-06-01', '2026-06-30') * 2


def test_list_work_dates_without_bounds_has_no_parameters() -> None:
    db = FakeDb()
    lottery.list_work_dates(db, 'empty')
    assert db.executed[-1][1] == ()


# ── the outcome pass: conditional, tagged, counted from the DB ──


@pytest.mark.parametrize(
    ('parquet_format', 'source'), [('fulltape', 'fulltape'), ('trades', 'bot_eod')]
)
def test_outcome_update_is_conditional_and_tagged(
    parquet_format: str,
    source: str,
    archive: Path,
    archive_globals: None,
    make_db,
) -> None:
    write_tape(archive, parquet_format)
    lottery.configure_archive(archive, parquet_format)
    db = make_db(fires=[fire_row(1, TSLA)])

    result = lottery.enrich_one_date(db, DAY)

    (write,) = db.outcome_writes()
    assert 'WHERE f.id = v.id AND f.peak_ceiling_pct IS NULL AND f.outcome_source IS NULL' in write.sql
    assert write.sql.endswith('RETURNING f.id')
    assert 'outcome_source = v.source' in write.sql
    assert 'outcome_version = v.version' in write.sql
    assert write.template == '(%s::bigint, %s, %s, %s, %s, %s, %s, %s::text, %s::smallint)'
    assert write.kwargs == {'page_size': 500, 'fetch': True}
    assert [row[-2:] for row in write.rows] == [(source, 1)]
    # Canceled (9.00) and zero-price prints are dropped: the peak is 2.00.
    (row,) = write.rows
    assert row[0] == 1
    assert row[5] == pytest.approx(100.0)
    assert result.outcomes_written == 1


def test_written_count_comes_from_returning(fulltape: Path, make_db) -> None:
    db = make_db(fires=[fire_row(i, TSLA) for i in (1, 2, 3)])
    # The cron filled fire 3 between our SELECT and our UPDATE.
    db.returning = lambda rows: [(r[0],) for r in rows if r[0] != 3]

    result = lottery.enrich_one_date(db, DAY)

    assert result.fires_selected == 3
    assert result.outcomes_written == 2
    assert result.fires_written == 2
    assert result.stamped_no_outcome == 0


def test_update_fires_returns_the_returned_row_count(make_db) -> None:
    db = make_db()
    db.returning = lambda rows: [(rows[0][0],)]
    updates = [(i, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0) for i in (7, 8, 9)]
    assert lottery.update_fires(db, updates, 'fulltape') == 1
    assert lottery.update_fires(db, [], 'fulltape') == 0
    assert len(db.values_writes) == 1


def test_unpriced_fires_are_tagged_once(fulltape: Path, make_db) -> None:
    # 2: its only print is before the entry; 3: its chain is not in the tape.
    db = make_db(fires=[fire_row(1, TSLA), fire_row(2, AAPL), fire_row(3, NVDA)])

    result = lottery.enrich_one_date(db, DAY)

    stamps = db.stamps('outcome_source')
    assert len(stamps) == 1
    assert stamps[0][1] == ('fulltape', 1, [2, 3])
    assert result.fires_selected == 3
    assert result.outcomes_written == 1
    assert result.stamped_no_outcome == 2
    assert result.fires_written == 3
    assert [row[0] for write in db.outcome_writes() for row in write.rows] == [1]


def test_stamp_no_outcome_is_conditional_and_chunked(make_db) -> None:
    db = make_db()
    ids = list(range(1, 1002))

    assert lottery.stamp_no_outcome(db, ids, 'bot_eod') == 1001

    sqls = {sql for sql, _ in db.executed}
    assert sqls == {
        'UPDATE lottery_finder_fires SET enriched_at = NOW(), '
        'outcome_source = %s, outcome_version = %s '
        'WHERE id = ANY(%s::bigint[]) '
        'AND peak_ceiling_pct IS NULL AND outcome_source IS NULL'
    }
    assert [(p[0], p[1], len(p[2])) for _, p in db.executed] == [
        ('bot_eod', 1, 500),
        ('bot_eod', 1, 500),
        ('bot_eod', 1, 1),
    ]
    assert lottery.stamp_no_outcome(db, [], 'bot_eod') == 0
    assert len(db.executed) == 3


def test_stamp_count_comes_from_rowcount(
    make_db, capsys: pytest.CaptureFixture[str]
) -> None:
    db = make_db()
    db.stamp_rowcount = 1  # the cron already filled two of the three
    assert lottery.stamp_no_outcome(db, [5, 6, 7], 'fulltape') == 1
    captured = capsys.readouterr()
    assert captured.err == ''
    assert 'WARN' not in captured.out


# ── the flow-inversion pass ────────────────────────────────────


def test_flow_missing_is_left_and_not_selected(fulltape: Path, make_db) -> None:
    db = make_db(
        flow_fires=[flow_fire_row(4, QQQ)],
        flow={('QQQ', 'C'): []},
        work_dates=[DAY],
    )

    result = lottery.enrich_one_date(db, DAY, select='all')

    assert result.flow_selected == 1
    assert result.flow_input_missing == 1
    assert result.flow_written == 0
    assert result.flow_stamped_undefined == 0
    assert db.flow_writes() == []
    assert db.stamps('inversion_source') == []
    assert db.updates_run() == []

    # And a day is listed for inversion work only while the matched side's
    # flow exists for that UTC day.
    lottery.list_work_dates(db, 'all')
    sql = db.executed[-1][0]
    assert (
        'SELECT DISTINCT date, underlying_symbol, option_type '
        f'FROM lottery_finder_fires WHERE {INVERSION_WORK}'
    ) in sql
    assert 'EXISTS (SELECT 1 FROM net_flow_per_ticker_history n' in sql
    assert 'n.ticker = w.underlying_symbol' in sql
    assert "n.ts >= w.date::timestamp AT TIME ZONE 'UTC'" in sql
    assert "n.ts < (w.date + 1)::timestamp AT TIME ZONE 'UTC'" in sql
    assert (
        "CASE WHEN w.option_type = 'C' THEN n.net_call_prem "
        'ELSE n.net_put_prem END IS NOT NULL'
    ) in sql


def test_flow_undefined_is_tagged(fulltape: Path, make_db) -> None:
    # Ten minutes of flow, all zero: flat_flow_no_peak.
    db = make_db(flow_fires=[flow_fire_row(4, QQQ)], flow={('QQQ', 'C'): flat_flow()})

    result = lottery.enrich_one_date(db, DAY)

    assert result.flow_stamped_undefined == 1
    assert result.flow_written == 0
    assert result.flow_input_missing == 0
    assert db.flow_writes() == []
    ((sql, params),) = db.stamps('inversion_source')
    assert sql == (
        'UPDATE lottery_finder_fires SET inversion_source = %s, inversion_version = %s '
        'WHERE id = ANY(%s::bigint[]) '
        'AND realized_flow_inversion_pct IS NULL AND inversion_source IS NULL'
    )
    assert params == ('fulltape', 1, [4])


def test_flow_with_no_chain_or_no_print_after_the_trigger_is_tagged(
    fulltape: Path, make_db
) -> None:
    # NVDA is not in the tape (no_chain); AAPL's only print is before the
    # trigger (no_post_trigger_prices). Neither needs the flow to exist.
    db = make_db(
        flow_fires=[flow_fire_row(2, AAPL), flow_fire_row(3, NVDA)],
        flow={('AAPL', 'C'): flat_flow()},
    )

    result = lottery.enrich_one_date(db, DAY)

    assert result.flow_stamped_undefined == 2
    assert result.flow_input_missing == 0
    ((_, params),) = db.stamps('inversion_source')
    assert params == ('fulltape', 1, [2, 3])


def test_flow_value_written_with_tag(fulltape: Path, make_db) -> None:
    db = make_db(
        flow_fires=[flow_fire_row(1, TSLA)],
        flow={('TSLA', 'C'): rising_then_falling_flow()},
    )

    result = lottery.enrich_one_date(db, DAY)

    (write,) = db.flow_writes()
    assert 'WHERE f.id = v.id' in write.sql
    assert 'f.realized_flow_inversion_pct IS NULL AND f.inversion_source IS NULL' in write.sql
    assert write.sql.endswith('RETURNING f.id')
    assert 'inversion_source = v.source' in write.sql
    assert 'inversion_version = v.version' in write.sql
    assert write.template == '(%s::bigint, %s::numeric, %s::text, %s::smallint)'
    assert write.kwargs == {'page_size': 500, 'fetch': True}
    (row,) = write.rows
    assert row[0] == 1
    assert row[1] == pytest.approx(75.0)
    assert row[2:] == ('fulltape', 1)
    assert result.flow_written == 1
    assert result.flow_stamped_undefined == 0
    assert db.stamps('inversion_source') == []


def test_flow_tag_follows_the_archive(archive: Path, archive_globals: None, make_db) -> None:
    write_tape(archive, 'trades')
    lottery.configure_archive(archive, 'trades')
    db = make_db(
        flow_fires=[flow_fire_row(1, TSLA), flow_fire_row(4, QQQ)],
        flow={('TSLA', 'C'): rising_then_falling_flow(), ('QQQ', 'C'): flat_flow()},
    )

    lottery.enrich_one_date(db, DAY)

    assert [row[2:] for w in db.flow_writes() for row in w.rows] == [('bot_eod', 1)]
    ((_, params),) = db.stamps('inversion_source')
    assert params == ('bot_eod', 1, [4])


def test_flow_written_count_comes_from_returning(fulltape: Path, make_db) -> None:
    db = make_db(
        flow_fires=[flow_fire_row(1, TSLA)],
        flow={('TSLA', 'C'): rising_then_falling_flow()},
    )
    db.returning = lambda rows: []  # the cron wrote it first

    result = lottery.enrich_one_date(db, DAY)

    assert result.flow_selected == 1
    assert result.flow_written == 0
    assert result.flow_stamped_undefined == 0


def test_inversion_stamp_is_conditional_and_chunked(make_db) -> None:
    db = make_db()
    db.stamp_rowcount = 2
    ids = list(range(1, 1002))

    assert lottery.stamp_inversion_undefined(db, ids, 'fulltape') == 6
    assert [len(p[2]) for _, p in db.executed] == [500, 500, 1]
    assert lottery.stamp_inversion_undefined(db, [], 'fulltape') == 0


def test_update_flow_inversion_returns_the_returned_row_count(make_db) -> None:
    db = make_db()
    db.returning = lambda rows: [(rows[0][0],)]
    assert lottery.update_flow_inversion(db, [(7, 1.5), (8, 2.5)], 'fulltape') == 1
    assert lottery.update_flow_inversion(db, [], 'fulltape') == 0
    assert len(db.values_writes) == 1


# ── legacy and new layouts enrich identically ──────────────────


def _day_db(make_db) -> FakeDb:
    return make_db(
        fires=[
            fire_row(1, TSLA),  # priced
            fire_row(2, AAPL),  # only print before the entry
            fire_row(3, NVDA),  # chain not in the tape
            fire_row(4, QQQ),  # priced
        ],
        flow_fires=[
            flow_fire_row(1, TSLA),  # exit written
            flow_fire_row(2, AAPL),  # no print after the trigger
            flow_fire_row(3, NVDA),  # no chain
            flow_fire_row(4, QQQ),  # no flow rows: left
        ],
        flow={
            ('TSLA', 'C'): rising_then_falling_flow(),
            ('AAPL', 'C'): flat_flow(),
            ('QQQ', 'C'): [],
        },
    )


def test_lottery_legacy_and_new_layouts_agree(
    tmp_path: Path, archive_globals: None, make_db
) -> None:
    outcomes = {}
    for layout in ('legacy', 'new'):
        directory = tmp_path / layout
        directory.mkdir()
        write_tape(directory, 'fulltape', layout)
        lottery.configure_archive(directory, 'fulltape')
        db = _day_db(make_db)
        result = lottery.enrich_one_date(db, DAY, select='all')
        outcomes[layout] = (
            [w.rows for w in db.outcome_writes()],
            [w.rows for w in db.flow_writes()],
            db.stamps('outcome_source'),
            db.stamps('inversion_source'),
            result,
        )

    assert outcomes['legacy'] == outcomes['new']
    outcome_rows, flow_rows, _, _, result = outcomes['new']
    assert [row[0] for row in outcome_rows[0]] == [1, 4]
    assert flow_rows[0][0][1] == pytest.approx(75.0)
    assert result == lottery.DayResult(
        fires_written=4,
        flow_written=1,
        fires_selected=4,
        outcomes_written=2,
        stamped_no_outcome=2,
        flow_selected=4,
        flow_stamped_undefined=2,
        flow_input_missing=1,
    )


# ── dry run ────────────────────────────────────────────────────


def test_dry_run_writes_nothing(tmp_path: Path, archive_globals: None, make_db) -> None:
    directory = tmp_path / 'tape'
    directory.mkdir()
    write_tape(directory, 'fulltape')
    lottery.configure_archive(directory, 'fulltape')

    written = _day_db(make_db)
    real = lottery.enrich_one_date(written, DAY, select='all')
    assert written.values_writes
    assert written.updates_run()

    dry = _day_db(make_db)
    result = lottery.enrich_one_date(dry, DAY, select='all', dry_run=True)

    assert dry.values_writes == []
    assert dry.updates_run() == []
    assert result == real
    assert result.outcomes_written == 2
    assert result.flow_written == 1


# ── env file ───────────────────────────────────────────────────


def test_load_env_without_file_uses_the_process_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(lottery, 'ENV_FILE', tmp_path / 'missing.env.local')
    monkeypatch.setenv('DATABASE_URL', 'postgresql://process/env')

    lottery.load_env()  # no SystemExit

    assert os.environ['DATABASE_URL'] == 'postgresql://process/env'


def test_load_env_reads_the_module_global_at_call_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # scripts/recompute_peak_from_parquet.py assigns lottery_enrich.ENV_FILE
    # and then calls load_env().
    env_file = tmp_path / 'later.env.local'
    env_file.write_text('PROVENANCE_PROBE="from-file"\n', encoding='utf-8')
    monkeypatch.delenv('PROVENANCE_PROBE', raising=False)
    monkeypatch.setattr(lottery, 'ENV_FILE', env_file)

    lottery.load_env()

    assert os.environ['PROVENANCE_PROBE'] == 'from-file'
    monkeypatch.delenv('PROVENANCE_PROBE')


# ── pass 3 ─────────────────────────────────────────────────────


def test_pass3_never_writes_live_stats(
    monkeypatch: pytest.MonkeyPatch,
    make_db,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv('WRITE_DB', '1')
    # ticker, n_21d, w_21d, n_90d, w_90d
    db = make_db(refit_rows=[('TSLA', 12, 9, 40, 22), ('AAPL', 3, 1, 5, 2)])

    lottery.refit_ticker_inversion_stats(db)

    statements = [sql for sql, _ in db.executed]
    assert statements, 'the refit still reads lottery_finder_fires'
    assert [
        s for s in statements if 'lottery_ticker_stats' in s and not s.startswith('SELECT')
    ] == []
    assert db.values_writes == []
    out = capsys.readouterr().out
    assert '[ticker-quality] 2 tickers seen in 90d window' in out
    assert '[ticker-quality] quintile distribution:' in out
    assert 'WRITE_DB' not in out


def test_pass3_signature_has_no_write_flag() -> None:
    with pytest.raises(TypeError, match='write_db'):
        lottery.refit_ticker_inversion_stats(FakeDb(), write_db=True)


# ── main ───────────────────────────────────────────────────────


def test_main_runs_pending_dates_tagged_by_the_archive(
    archive: Path,
    archive_globals: None,
    make_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env_file = tmp_path / 'absent.env.local'
    monkeypatch.setattr(lottery, 'ENV_FILE', env_file)
    monkeypatch.setenv('DATABASE_URL', 'postgresql://test/none')
    monkeypatch.setenv('WRITE_DB', '1')
    monkeypatch.chdir(tmp_path)
    write_tape(archive, 'fulltape')
    db = make_db(
        fires=[fire_row(1, TSLA), fire_row(2, NVDA)],
        work_dates=[DAY],
    )
    monkeypatch.setattr(lottery, 'connect_with_retry', lambda _url: db)

    lottery.main(
        ['--all-unenriched', '--parquet-dir', str(archive), '--parquet-format', 'fulltape']
    )

    dates_sql = next(sql for sql, _ in db.executed if sql.startswith('SELECT DISTINCT date::text'))
    assert f'WHERE {PENDING} ORDER BY 1' in dates_sql
    assert INVERSION_WORK not in dates_sql
    assert [row[-2:] for w in db.outcome_writes() for row in w.rows] == [('fulltape', 1)]
    assert db.stamps('outcome_source')[0][1] == ('fulltape', 1, [2])
    # WRITE_DB=1 no longer reaches the live ticker stats.
    assert not any('lottery_ticker_stats' in sql for sql, _ in db.executed)
