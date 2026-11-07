"""Provenance, selection and conditional writes in enrich_lottery_outcomes.py.

The live Vercel enrich cron writes the same lottery_finder_fires rows, so
every write the script makes is conditional and tagged with where it came from
(outcome_source / inversion_source plus a version), and the set of work must
shrink to zero: a fire the tape cannot price is examined once, a fire whose
net flow does not exist yet is left alone and not selected until it does.

The Full Tape has the final say over outcomes (owner, 2026-11-06): it replaces
every outcome it can price that it has not examined (outcome_tape_version IS
NULL), crons' and untagged history included, and keeps another writer's value
for a fire it cannot price. The Bot-EOD archive only fills: it never replaces
a value and never sets the marker.

Neon is faked at the psycopg2 boundary (connect_with_retry, execute_values,
the cursor), as in test_enrich_missing_archive.py. The two parquet layouts of
the Full Tape (the legacy 42-column files with decimal numerics and the new
52-column ones) are written for real and read by the real loader. Run:

    ml/.venv/Scripts/python -m pytest -q scripts/test_enrich_provenance.py
"""

from __future__ import annotations

import os
import sqlite3
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import psycopg2
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
ALL = 'peak_ceiling_pct IS NULL AND outcome_source IS NULL'  # bot_eod: fill only
# fulltape: not examined, or examined by an older pass (%s is OUTCOME_VERSION).
ALL_TAPE = '(outcome_tape_version IS NULL OR outcome_tape_version < %s)'
INVERSION_WORK = 'realized_flow_inversion_pct IS NULL AND inversion_source IS NULL'
# The module default source is bot_eod.
PREDICATES = {'pending': PENDING, 'empty': EMPTY, 'all': ALL}
PREDICATES_BY_SOURCE = {
    'bot_eod': PREDICATES,
    'fulltape': {**PREDICATES, 'all': ALL_TAPE},
}

# The fulltape stamp for fires the tape cannot price. It decides per row, from
# the row's current peak_ceiling_pct, so a value written after our SELECT is
# kept: the realized columns are never in the SET, and a row with an outcome
# keeps its values, tag and version and gets the marker (plus an enriched_at
# only if it had none). The version gate comes before the ids so the ids stay
# the last parameter.
TAPE_STAMP = (
    'UPDATE lottery_finder_fires AS f '
    'SET outcome_source = CASE WHEN f.peak_ceiling_pct IS NULL '
    'THEN %s::text ELSE f.outcome_source END, '
    'outcome_version = CASE WHEN f.peak_ceiling_pct IS NULL '
    'THEN %s::smallint ELSE f.outcome_version END, '
    'enriched_at = CASE WHEN f.peak_ceiling_pct IS NULL '
    'THEN NOW() ELSE COALESCE(f.enriched_at, NOW()) END, '
    'outcome_tape_version = %s::smallint '
    'WHERE (f.outcome_tape_version IS NULL OR f.outcome_tape_version < %s) '
    'AND f.id = ANY(%s::bigint[]) '
    'RETURNING f.peak_ceiling_pct IS NOT NULL AS had_outcome'
)
# The bot_eod stamp is Task 3's, unchanged.
FILL_STAMP = (
    'UPDATE lottery_finder_fires SET enriched_at = NOW(), '
    'outcome_source = %s, outcome_version = %s '
    'WHERE id = ANY(%s::bigint[]) '
    'AND peak_ceiling_pct IS NULL AND outcome_source IS NULL'
)


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


def fire_row(fire_id: int, chain: str, had_outcome: bool = False) -> tuple:
    # entry_price is NUMERIC: psycopg2 hands back a Decimal. The fifth column
    # (peak_ceiling_pct IS NOT NULL) is selected for the fulltape source only.
    return (fire_id, chain, ENTRY, Decimal('1.0000'), had_outcome)


def flow_fire_row(
    fire_id: int, chain: str, entry_price: Decimal = Decimal('1.0000')
) -> tuple:
    symbol = chain.split('2607')[0]
    return (fire_id, chain, symbol, 'C', ENTRY, entry_price, date(2026, 7, 22))


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
        self.db.maybe_fail(sql)
        self.rows = self.db.answer(sql, params)
        if sql.startswith('UPDATE') and 'RETURNING' in sql:
            self.rowcount = len(self.rows)
        else:
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
        # What a tag-only UPDATE ... RETURNING hands back, as a function of the
        # ids sent; None means one (had_outcome,) row per id, true for the
        # fires the SELECT served with an outcome.
        self.stamp_returning = None
        # What a plain UPDATE reports as rowcount; None means every id sent.
        self.stamp_rowcount: int | None = None
        # A statement (normalized text) this returns True for is recorded and
        # then rejected, as a dropped connection would.
        self.fail_when = None
        self.commits = 0

    # psycopg2 connection surface
    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def commit(self) -> None:
        self.commits += 1

    def maybe_fail(self, sql: str) -> None:
        if self.fail_when is not None and self.fail_when(sql):
            raise psycopg2.OperationalError('server closed the connection unexpectedly')

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
        if sql.startswith('UPDATE') and 'RETURNING' in sql:
            ids = params[-1]
            if self.stamp_returning is not None:
                return self.stamp_returning(ids)
            had = self.had_outcome_ids()
            return [(i in had,) for i in ids]
        return []

    def had_outcome_ids(self) -> set[int]:
        return {r[0] for r in self.fires if len(r) > 4 and r[4]}

    def rowcount_for(self, sql: str, params: tuple | None) -> int:
        if sql.startswith('UPDATE') and params:
            return len(params[-1]) if self.stamp_rowcount is None else self.stamp_rowcount
        return 0

    def execute_values(self, _cur, sql, rows, template=None, **kwargs):
        rows = list(rows)
        self.values_writes.append(ValuesWrite(norm(sql), rows, template, kwargs))
        self.maybe_fail(norm(sql))
        if not kwargs.get('fetch'):
            return None
        if self.returning is not None:
            return self.returning(rows)
        if 'prior.peak_ceiling_pct IS NOT NULL' in sql:
            # The tape's priced UPDATE also returns the row's prior outcome.
            had = self.had_outcome_ids()
            return [(r[0], r[0] in had) for r in rows]
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

    def outcome_stamps(self) -> list[tuple[str, tuple]]:
        """The unpriced-fire stamps, whichever source wrote them: the UPDATEs
        that touch enriched_at through the cursor (priced rows go through
        execute_values)."""
        return [
            (sql, params)
            for sql, params in self.executed
            if sql.startswith('UPDATE') and 'enriched_at' in sql
        ]

    def updates_run(self) -> list[str]:
        return [sql for sql, _ in self.executed if sql.startswith('UPDATE')]

    def flow_reads(self) -> list[str]:
        """The flow pass's per-(ticker, side) net-flow SELECTs."""
        return [sql for sql, _ in self.executed if sql.startswith('SELECT ts, ')]


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


@pytest.fixture
def as_source(archive_globals: None, monkeypatch: pytest.MonkeyPatch):
    """Switch the module's source tag for one test; archive_globals puts it back."""

    def switch(source: str) -> None:
        monkeypatch.setattr(lottery, 'SOURCE_TAG', source)

    return switch


@pytest.mark.parametrize('source', PREDICATES_BY_SOURCE)
@pytest.mark.parametrize('select', PREDICATES)
def test_select_predicates(select: str, source: str, as_source) -> None:
    as_source(source)
    expected = PREDICATES_BY_SOURCE[source][select]
    db = FakeDb(work_dates=[DAY])
    lottery.fetch_unenriched(db, DAY, select)
    fetch_sql = db.executed[-1][0]
    where = fetch_sql.split('WHERE date = %s AND ', 1)[1].split(' ORDER BY')[0]
    assert where == expected

    lottery.list_work_dates(db, select)
    dates_sql = db.executed[-1][0]
    assert f'WHERE {expected}' in dates_sql
    assert dates_sql.endswith('ORDER BY 1')
    # Only 'all' also looks for inversion work (and the flow that makes it doable).
    has_inversion = INVERSION_WORK in dates_sql
    assert has_inversion is (select == 'all')
    assert ('net_flow_per_ticker_history' in dates_sql) is (select == 'all')


@pytest.mark.parametrize('source', PREDICATES_BY_SOURCE)
def test_all_work_follows_the_source(source: str, as_source) -> None:
    as_source(source)
    db = FakeDb()
    lottery.fetch_unenriched(db, DAY, 'all')
    fetch_sql = db.executed[-1][0]
    lottery.list_work_dates(db, 'all')
    dates_sql = db.executed[-1][0]
    # The outcome half of the date list: between the subquery's WHERE and its UNION.
    outcome_half = dates_sql.split(
        'SELECT date FROM lottery_finder_fires WHERE ', 1
    )[1].split(' UNION ALL')[0]

    if source == 'fulltape':
        # The marker alone: every row the tape has not examined, whatever
        # another writer left in it.
        assert outcome_half == ALL_TAPE
        for sql in (fetch_sql, dates_sql):
            assert 'peak_ceiling_pct IS NULL' not in sql
            assert 'outcome_source' not in sql
    else:
        assert outcome_half == ALL
        for sql in (fetch_sql, dates_sql):
            assert 'outcome_tape_version' not in sql

    # 'pending' and 'empty' do not depend on the source.
    for select in ('pending', 'empty'):
        lottery.fetch_unenriched(db, DAY, select)
        assert PREDICATES[select] in db.executed[-1][0]
        assert 'outcome_tape_version' not in db.executed[-1][0]
        lottery.list_work_dates(db, select)
        assert f'WHERE {PREDICATES[select]}' in db.executed[-1][0]
        assert 'outcome_tape_version' not in db.executed[-1][0]


def test_work_predicates_cover_every_archive_source() -> None:
    # A source with no 'all' predicate would fail at the first run.
    assert set(lottery.OUTCOME_WORK_ALL) == set(lottery.ARCHIVE_SOURCES.values())


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

    expected = PREDICATES_BY_SOURCE['fulltape'][select]  # the fixture's source
    assert f'WHERE date = %s AND {expected} ORDER BY' in db.executed[0][0]


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


def test_tape_work_carries_the_version_gate_ahead_of_the_bounds(as_source) -> None:
    # The gate's %s sits in the outcome half of the union, before its bounds.
    as_source('fulltape')
    db = FakeDb()
    lottery.list_work_dates(db, 'all', since='2026-06-01', through='2026-06-30')
    sql, params = db.executed[-1]
    assert params == (lottery.OUTCOME_VERSION, *('2026-06-01', '2026-06-30') * 2)

    lottery.list_work_dates(db, 'all')
    assert db.executed[-1][1] == (lottery.OUTCOME_VERSION,)

    lottery.fetch_unenriched(db, DAY, 'all')
    assert db.executed[-1][1] == (DAY, lottery.OUTCOME_VERSION)
    # pending and empty carry no gate.
    lottery.fetch_unenriched(db, DAY, 'pending')
    assert db.executed[-1][1] == (DAY,)


def test_the_tape_gate_selects_unexamined_and_older_rows_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The gate is real SQL, so run it: the fake cannot evaluate a WHERE. The
    # production predicate text goes into stdlib sqlite3 in memory (it speaks
    # the same IS NULL / OR / < / AND), with sqlite's `?` as the version.
    monkeypatch.setattr(lottery, 'OUTCOME_VERSION', 2)
    gate = lottery.outcome_work_all('fulltape', '', '?')
    other_day = '2026-07-23'
    con = sqlite3.connect(':memory:')
    con.execute('CREATE TABLE fires (id INTEGER PRIMARY KEY, date TEXT, outcome_tape_version INTEGER)')
    con.executemany(
        'INSERT INTO fires VALUES (?, ?, ?)',
        [
            (1, DAY, None),  # never examined: selected
            (2, DAY, 1),  # examined at an older version: selected
            (3, DAY, 2),  # examined at this version: not
            (4, DAY, 3),  # examined at a newer version: not
            # The same markers on another day. Without the gate's parentheses
            # `date = ? AND marker IS NULL OR marker < ?` lets row 6 through.
            (5, other_day, None),
            (6, other_day, 1),
        ],
    )
    # One binding per `?` in the predicate: the day, then the version wherever
    # the gate takes it, so a gate that stops taking one fails on its rows.
    params = (DAY, *[lottery.OUTCOME_VERSION] * gate.count('?'))

    rows = con.execute(
        f'SELECT id FROM fires WHERE date = ? AND {gate} ORDER BY id', params
    ).fetchall()

    assert [row[0] for row in rows] == [1, 2]


def test_a_version_bump_reaches_every_tape_gate(
    fulltape: Path, make_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A row the tape examined at an older version is work again, and every
    # guard lets it through: the gate is the constant, read when it runs.
    monkeypatch.setattr(lottery, 'OUTCOME_VERSION', 2)
    db = make_db(fires=[fire_row(1, TSLA), fire_row(2, AAPL)])

    lottery.list_work_dates(db, 'all')
    assert db.executed[-1][1] == (2,)

    lottery.enrich_one_date(db, DAY, select='all')

    fetch_params = next(p for s, p in db.executed if 'entry_time_ct, entry_price' in s)
    assert fetch_params == (DAY, 2)
    (write,) = db.outcome_writes()
    # The priced UPDATE's gate reads the version carried in its VALUES row.
    assert 'f.outcome_tape_version < v.version' in write.sql
    assert [row[-2:] for row in write.rows] == [('fulltape', 2)]
    # (source, outcome version, marker, gate, ids)
    ((_, stamp_params),) = db.outcome_stamps()
    assert stamp_params == ('fulltape', 2, 2, 2, [2])


# ── the outcome pass: conditional, tagged, counted from the DB ──


# The guard each source's priced UPDATE carries, and what it returns.
TAPE_UPDATE_TAIL = (
    'WHERE f.id = v.id AND prior.id = f.id '
    'AND (f.outcome_tape_version IS NULL OR f.outcome_tape_version < v.version) '
    'RETURNING f.id, prior.peak_ceiling_pct IS NOT NULL AS had_outcome'
)
FILL_UPDATE_TAIL = (
    'WHERE f.id = v.id AND f.peak_ceiling_pct IS NULL AND f.outcome_source IS NULL '
    'RETURNING f.id'
)


@pytest.mark.parametrize(
    ('parquet_format', 'source', 'tail'),
    [('fulltape', 'fulltape', TAPE_UPDATE_TAIL), ('trades', 'bot_eod', FILL_UPDATE_TAIL)],
)
def test_outcome_update_is_conditional_and_tagged(
    parquet_format: str,
    source: str,
    tail: str,
    archive: Path,
    archive_globals: None,
    make_db,
) -> None:
    write_tape(archive, parquet_format)
    lottery.configure_archive(archive, parquet_format)
    db = make_db(fires=[fire_row(1, TSLA)])

    result = lottery.enrich_one_date(db, DAY)

    (write,) = db.outcome_writes()
    assert write.sql.endswith(tail)
    assert 'outcome_source = v.source' in write.sql
    assert 'outcome_version = v.version' in write.sql
    assert 'enriched_at = NOW()' in write.sql
    assert write.template == '(%s::bigint, %s, %s, %s, %s, %s, %s, %s::text, %s::smallint)'
    assert write.kwargs == {'page_size': 500, 'fetch': True}
    assert [row[-2:] for row in write.rows] == [(source, 1)]
    # Canceled (9.00) and zero-price prints are dropped: the peak is 2.00.
    (row,) = write.rows
    assert row[0] == 1
    assert row[5] == pytest.approx(100.0)
    assert result.outcomes_written == 1
    assert result.outcomes_replaced == 0  # nothing was there to replace


def test_tape_replaces_a_cron_outcome(fulltape: Path, make_db) -> None:
    # The fire already holds a value another writer left (had_outcome).
    db = make_db(fires=[fire_row(1, TSLA, had_outcome=True)])

    result = lottery.enrich_one_date(db, DAY, select='all')

    (write,) = db.outcome_writes()
    # The guard is the marker's version gate alone: no test of the prior
    # outcome or its tag.
    assert write.sql.endswith(TAPE_UPDATE_TAIL)
    where = write.sql.split(' WHERE ', 1)[1]
    assert 'peak_ceiling_pct IS NULL' not in where
    assert 'outcome_source' not in where
    # It sets the tag, the version and the marker with the six values.
    assert 'outcome_source = v.source' in write.sql
    assert 'outcome_version = v.version' in write.sql
    assert 'enriched_at = NOW()' in write.sql
    assert 'outcome_tape_version = v.version' in write.sql
    assert 'lottery_finder_fires AS prior' in write.sql
    assert [row[-2:] for row in write.rows] == [('fulltape', 1)]
    assert result.outcomes_written == 1
    assert result.outcomes_replaced == 1
    assert result.stamped_no_outcome == 0
    assert result.outcomes_kept == 0


def test_written_count_comes_from_returning(fulltape: Path, make_db) -> None:
    db = make_db(fires=[fire_row(i, TSLA) for i in (1, 2, 3)])
    # Another tape run examined fire 3 between our SELECT and our UPDATE.
    db.returning = lambda rows: [(r[0], False) for r in rows if r[0] != 3]

    result = lottery.enrich_one_date(db, DAY)

    assert result.fires_selected == 3
    assert result.outcomes_written == 2
    assert result.fires_written == 2
    assert result.stamped_no_outcome == 0


def test_replaced_count_comes_from_returning(fulltape: Path, make_db) -> None:
    db = make_db(fires=[fire_row(i, TSLA, had_outcome=True) for i in (1, 2, 3)])
    # Another tape run examined fire 3 first, so the guard dropped it.
    db.returning = lambda rows: [(r[0], True) for r in rows if r[0] != 3]

    result = lottery.enrich_one_date(db, DAY, select='all')

    assert result.fires_selected == 3
    assert result.outcomes_written == 2
    assert result.outcomes_replaced == 2  # not the three the fetch saw


def test_replaced_count_follows_the_row_not_the_fetch(fulltape: Path, make_db) -> None:
    # Fire 1 had no outcome at the SELECT but the cron wrote one before our
    # UPDATE; fire 2 is the other way round. The statement's own view of the
    # prior row decides.
    db = make_db(fires=[fire_row(1, TSLA), fire_row(2, QQQ, had_outcome=True)])
    db.returning = lambda rows: [(1, True), (2, False)]

    result = lottery.enrich_one_date(db, DAY, select='all')

    assert result.outcomes_written == 2
    assert result.outcomes_replaced == 1


def test_update_fires_returns_written_and_replaced(make_db) -> None:
    db = make_db()
    db.returning = lambda rows: [(rows[0][0], True), (rows[1][0], False)]
    updates = [(i, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0) for i in (7, 8, 9)]
    assert lottery.update_fires(db, updates, 'fulltape') == (2, 1)
    assert lottery.update_fires(db, [], 'fulltape') == (0, 0)
    assert len(db.values_writes) == 1


def test_unpriced_fires_are_tagged_once(fulltape: Path, make_db) -> None:
    # 2: its only print is before the entry; 3: its chain is not in the tape.
    db = make_db(fires=[fire_row(1, TSLA), fire_row(2, AAPL), fire_row(3, NVDA)])

    result = lottery.enrich_one_date(db, DAY)

    stamps = db.outcome_stamps()
    assert len(stamps) == 1
    # (source, version, marker, gate, ids): one statement for both fires.
    assert stamps[0][1] == ('fulltape', 1, 1, 1, [2, 3])
    assert result.fires_selected == 3
    assert result.outcomes_written == 1
    assert result.stamped_no_outcome == 2
    assert result.outcomes_kept == 0
    assert result.fires_written == 3
    assert [row[0] for write in db.outcome_writes() for row in write.rows] == [1]


def test_unpriced_fire_with_an_outcome_keeps_it(fulltape: Path, make_db) -> None:
    # AAPL's only print is before the entry, but the fire holds a cron value.
    db = make_db(fires=[fire_row(2, AAPL, had_outcome=True)])
    db.stamp_returning = lambda ids: [(True,) for _ in ids]  # the row kept its outcome

    result = lottery.enrich_one_date(db, DAY, select='all')

    ((sql, params),) = db.outcome_stamps()
    # The per-row branch is in the statement: with an outcome (peak_ceiling_pct
    # NOT NULL) the marker is set and the tag and the version stay as they
    # were. The six realized columns are not in the SET at all. enriched_at
    # stays too, unless it is NULL (see the next test).
    assert sql == TAPE_STAMP
    set_clause = sql.split(' SET ', 1)[1].split(' WHERE ', 1)[0]
    for column in ('realized_', 'peak_ceiling_pct =', 'minutes_to_peak'):
        assert column not in set_clause
    assert set_clause.count('ELSE f.outcome_source END') == 1
    assert set_clause.count('ELSE f.outcome_version END') == 1
    assert params == ('fulltape', 1, 1, 1, [2])
    assert result.outcomes_kept == 1
    assert result.stamped_no_outcome == 0
    assert result.outcomes_written == 0
    assert result.fires_written == 0


def test_a_kept_row_without_enriched_at_gets_one(fulltape: Path, make_db) -> None:
    # enriched_at is nullable and nothing in the schema forbids a row with a
    # value and a NULL enriched_at. Such a row would stay in 'pending' for
    # good, and the cron's `enriched_at IS NULL` guard would let it overwrite a
    # row the tape examined, so the keep branch fills it defensively. It fills
    # a missing enriched_at and nothing else.
    db = make_db(fires=[fire_row(2, AAPL, had_outcome=True)])

    lottery.enrich_one_date(db, DAY, select='all')

    ((sql, _),) = db.outcome_stamps()
    set_clause = sql.split(' SET ', 1)[1].split(' WHERE ', 1)[0]
    # No outcome: a fresh enriched_at. An outcome: the one it has, or now if
    # it has none. Never a bare `ELSE f.enriched_at`, which would leave NULL.
    assert (
        'enriched_at = CASE WHEN f.peak_ceiling_pct IS NULL '
        'THEN NOW() ELSE COALESCE(f.enriched_at, NOW()) END'
    ) in set_clause
    assert 'ELSE f.enriched_at END' not in set_clause
    # The values, tag and version of the kept row are still untouched.
    assert 'ELSE f.outcome_source END' in set_clause
    assert 'ELSE f.outcome_version END' in set_clause
    for column in ('realized_', 'peak_ceiling_pct =', 'minutes_to_peak'):
        assert column not in set_clause


def test_unpriced_fire_without_an_outcome_is_tagged(fulltape: Path, make_db) -> None:
    db = make_db(fires=[fire_row(2, AAPL)])
    db.stamp_returning = lambda ids: [(False,) for _ in ids]  # nothing was there

    result = lottery.enrich_one_date(db, DAY, select='all')

    ((sql, params),) = db.outcome_stamps()
    # The same statement tags 'fulltape' and sets the marker on such a row.
    assert sql == TAPE_STAMP
    assert 'THEN %s::text ELSE f.outcome_source END' in sql
    assert 'outcome_tape_version = %s::smallint' in sql
    assert params == ('fulltape', 1, 1, 1, [2])
    assert result.stamped_no_outcome == 1
    assert result.outcomes_kept == 0
    assert result.fires_written == 1


def test_kept_and_stamped_come_from_the_row_not_the_fetch(fulltape: Path, make_db) -> None:
    # The fetch saw fire 2 without an outcome and fire 3 with one. By the time
    # of the stamp the cron had written 2's too, so both rows keep an outcome.
    # The statement's RETURNING, from the row itself, decides: counting from
    # the fetch would give kept 1 and stamped 1.
    db = make_db(fires=[fire_row(2, AAPL), fire_row(3, NVDA, had_outcome=True)])
    db.stamp_returning = lambda ids: [(True,), (True,)]

    result = lottery.enrich_one_date(db, DAY, select='all')

    assert result.outcomes_kept == 2
    assert result.stamped_no_outcome == 0
    assert result.fires_written == 0


def test_stamp_no_outcome_is_conditional_per_row_and_chunked(make_db) -> None:
    db = make_db()
    ids = list(range(1, 1002))

    assert lottery.stamp_no_outcome(db, ids, 'fulltape') == (1001, 0)

    assert {sql for sql, _ in db.executed} == {TAPE_STAMP}
    # (source, outcome version, marker, gate) then the chunk of ids.
    assert [(*p[:4], len(p[4])) for _, p in db.executed] == [
        ('fulltape', 1, 1, 1, 500),
        ('fulltape', 1, 1, 1, 500),
        ('fulltape', 1, 1, 1, 1),
    ]
    assert lottery.stamp_no_outcome(db, [], 'fulltape') == (0, 0)
    assert len(db.executed) == 3


def test_bot_eod_stamp_is_conditional_and_chunked(make_db) -> None:
    db = make_db()
    ids = list(range(1, 1002))

    assert lottery.stamp_no_outcome(db, ids, 'bot_eod') == (1001, 0)

    assert {sql for sql, _ in db.executed} == {FILL_STAMP}
    assert [(p[0], p[1], len(p[2])) for _, p in db.executed] == [
        ('bot_eod', 1, 500),
        ('bot_eod', 1, 500),
        ('bot_eod', 1, 1),
    ]
    assert lottery.stamp_no_outcome(db, [], 'bot_eod') == (0, 0)
    assert len(db.executed) == 3


def test_stamp_counts_come_from_what_the_database_returned(
    make_db, capsys: pytest.CaptureFixture[str]
) -> None:
    # fulltape: one RETURNING row per row examined. Another tape run took 6.
    tape = make_db()
    tape.stamp_returning = lambda ids: [(True,), (False,)]
    assert lottery.stamp_no_outcome(tape, [5, 6, 7], 'fulltape') == (1, 1)
    # bot_eod: the statement's rowcount; the cron already filled two of three.
    fill = make_db()
    fill.stamp_rowcount = 1
    assert lottery.stamp_no_outcome(fill, [5, 6, 7], 'bot_eod') == (1, 0)
    captured = capsys.readouterr()
    assert captured.err == ''
    assert 'WARN' not in captured.out


def test_bot_eod_never_sets_the_marker_or_replaces(
    archive: Path, archive_globals: None, make_db
) -> None:
    write_tape(archive, 'trades')
    lottery.configure_archive(archive, 'trades')
    # Both fires hold an outcome; fill-only never touches such a row.
    db = make_db(
        fires=[fire_row(1, TSLA, had_outcome=True), fire_row(2, AAPL, had_outcome=True)]
    )

    result = lottery.enrich_one_date(db, DAY, select='all')

    statements = [sql for sql, _ in db.executed] + [w.sql for w in db.values_writes]
    assert statements
    assert not [s for s in statements if 'outcome_tape_version' in s]
    (write,) = db.outcome_writes()
    assert write.sql.endswith(FILL_UPDATE_TAIL)
    assert 'prior' not in write.sql
    ((stamp, params),) = db.outcome_stamps()
    assert stamp == FILL_STAMP
    assert params == ('bot_eod', 1, [2])
    assert (result.outcomes_replaced, result.outcomes_kept) == (0, 0)
    assert (result.outcomes_written, result.stamped_no_outcome) == (1, 1)


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


def test_flow_non_finite_exit_is_tagged_not_written(fulltape: Path, make_db) -> None:
    # entry_price is NUMERIC, which can hold NaN: float() makes the exit NaN.
    # Written, it would store NaN as a "value" and never be picked again.
    db = make_db(
        flow_fires=[
            flow_fire_row(1, TSLA, Decimal('NaN')),
            flow_fire_row(2, TSLA),
        ],
        flow={('TSLA', 'C'): rising_then_falling_flow()},
    )

    result = lottery.enrich_one_date(db, DAY)

    assert [row[0] for w in db.flow_writes() for row in w.rows] == [2]
    ((_, params),) = db.stamps('inversion_source')
    assert params == ('fulltape', 1, [1])
    assert result.flow_written == 1
    assert result.flow_stamped_undefined == 1


@pytest.mark.parametrize(('side', 'column'), [('C', 'net_call_prem'), ('P', 'net_put_prem')])
def test_matched_flow_window_is_exactly_24_hours(side: str, column: str) -> None:
    # '1 day' on a timestamptz is a calendar day in the session zone: 23 or 25
    # hours across a DST change, while list_work_dates' EXISTS is exactly 24.
    db = FakeDb()

    lottery.load_matched_flow(db, DAY, 'TSLA', side)

    sql, params = db.executed[-1]
    assert sql.startswith(f'SELECT ts, {column} FROM net_flow_per_ticker_history')
    assert "AND ts < %s::timestamptz + INTERVAL '24 hours'" in sql
    assert "'1 day'" not in sql
    assert params == ('TSLA', f'{DAY}T00:00:00Z', f'{DAY}T00:00:00Z')


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
            db.outcome_stamps(),
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


def test_dry_run_counts_would_replace_and_would_keep(fulltape: Path, make_db) -> None:
    # One priced and one unpriced fire, both holding an outcome the feed wrote.
    db = make_db(
        fires=[fire_row(1, TSLA, had_outcome=True), fire_row(2, AAPL, had_outcome=True)]
    )

    result = lottery.enrich_one_date(db, DAY, select='all', dry_run=True)

    # The counts come from the fetch (had_outcome), and nothing is written.
    assert result.outcomes_written == 1
    assert result.outcomes_replaced == 1
    assert result.outcomes_kept == 1
    assert result.stamped_no_outcome == 0
    assert db.values_writes == []
    assert db.updates_run() == []
    assert db.commits == 0
    # A wet run over the same rows reports the same counts.
    wet = make_db(
        fires=[fire_row(1, TSLA, had_outcome=True), fire_row(2, AAPL, had_outcome=True)]
    )
    assert lottery.enrich_one_date(wet, DAY, select='all') == result


def test_day_log_and_run_summary_report_replaced_and_kept(
    fulltape: Path, make_db, capsys: pytest.CaptureFixture[str]
) -> None:
    # 1: priced over an outcome; 2: unpriced, keeps its outcome; 3: unpriced, none.
    db = make_db(
        fires=[
            fire_row(1, TSLA, had_outcome=True),
            fire_row(2, AAPL, had_outcome=True),
            fire_row(3, NVDA),
        ]
    )

    day = lottery.enrich_one_date(db, DAY, select='all')

    out = capsys.readouterr().out
    assert (
        f'[enrich] {DAY} DB updated: 1 rows (1 replaced a prior outcome; '
        '+ 1 tagged with no outcome, 1 unpriced kept their outcome)'
    ) in out

    # The summary adds the days up, and leaves out a day skipped for its archive.
    lottery.print_run_summary(
        {
            DAY: day,
            '2026-07-23': lottery.DayResult(outcomes_replaced=2, outcomes_kept=3),
            '2026-07-24': lottery.DayResult(
                archive_missing=True, outcomes_replaced=9, outcomes_kept=9
            ),
        }
    )
    assert (
        '[enrich] summary: 3 outcome(s) replaced a prior outcome, '
        '4 unpriced fire(s) kept theirs'
    ) in capsys.readouterr().out


def test_dry_run_counts_unpriced_fires_without_an_outcome_as_tagged(
    fulltape: Path, make_db
) -> None:
    db = make_db(fires=[fire_row(2, AAPL), fire_row(3, NVDA, had_outcome=True)])

    result = lottery.enrich_one_date(db, DAY, select='all', dry_run=True)

    assert result.stamped_no_outcome == 1
    assert result.outcomes_kept == 1
    assert db.commits == 0


# ── a write that rejects ───────────────────────────────────────

# (fails_on: text that identifies the statement the database drops,
# issued_after: what must not follow it, commits: commits before it). The day
# has all four writes: outcome values, outcome stamp, inversion values,
# inversion stamp.
WRITE_FAULTS = [
    pytest.param(
        'SET realized_trail30_10_pct',
        lambda db: [
            *db.outcome_stamps(),
            *db.flow_reads(),
            *db.flow_writes(),
            *db.stamps('inversion_source'),
        ],
        0,
        id='outcome-values',
    ),
    pytest.param(
        'outcome_tape_version = %s',
        lambda db: [*db.flow_reads(), *db.flow_writes(), *db.stamps('inversion_source')],
        1,
        id='outcome-stamp',
    ),
    pytest.param(
        'SET realized_flow_inversion_pct',
        lambda db: db.stamps('inversion_source'),
        2,
        id='inversion-values',
    ),
    pytest.param('inversion_source = %s', lambda db: [], 3, id='inversion-stamp'),
]


@pytest.mark.parametrize(('fails_on', 'issued_after', 'commits'), WRITE_FAULTS)
def test_a_rejected_write_propagates_and_stops_the_day(
    fails_on: str, issued_after, commits: int, fulltape: Path, make_db
) -> None:
    db = _day_db(make_db)
    db.fail_when = lambda sql: fails_on in sql

    with pytest.raises(psycopg2.OperationalError, match='server closed'):
        lottery.enrich_one_date(db, DAY, select='all')

    # The rejected statement went out once (no retry, no swallow) ...
    sent = [s for s, _ in db.executed if fails_on in s]
    sent += [w.sql for w in db.values_writes if fails_on in w.sql]
    assert len(sent) == 1
    # ... nothing that follows it ran, in particular no flow pass after a
    # failed main pass, and no stamp after a failed value write ...
    assert issued_after(db) == []
    # ... and only the writes before it were committed.
    assert db.commits == commits


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
    assert db.outcome_stamps()[0][1] == ('fulltape', 1, 1, 1, [2])
    # WRITE_DB=1 no longer reaches the live ticker stats.
    assert not any('lottery_ticker_stats' in sql for sql, _ in db.executed)
