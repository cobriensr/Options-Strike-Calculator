"""Per-day derive for the exit-policy and flow-timing reports.

exit_policy_search.py and flow_inversion_timing.py each split their per-day
body into `derive_day`, so the nightly can keep one small derived file per tape
day and report from those instead of re-reading every tape day. The pieces under
test, in each script:

* `derive_day`: the day's rows (`DERIVED_COLUMNS`, pinned dtypes), the same
  whatever layout the tape day has (new: Float64, Boolean `canceled`, tz-aware
  `executed_at`; legacy: decimal128 numerics, text `canceled`, naive UTC
  `executed_at`).
* `fingerprint_rows` / `DAY_FINGERPRINT_SQL` / `day_fingerprints`: the md5 of a
  day's canonical fire list, computed in Python and in SQL.
* `load_derived` and `--derived-dir`: a report built from derived files equals
  the one built from the tape, and a day with no file is named, not guessed.
* The owner ruling of 2026-11-19: both reports tier fires the way the feed does
  (qas against the active weights' feed cutoffs), and a failed weights read ends
  the run before any report is written.

Neon is faked at the module boundary (psycopg2.connect, pandas.read_sql and
`_report_weights.load_pointer`, where both scripts' active-weights read lives);
no test reaches a database. Run:

    ml/.venv/Scripts/python -m pytest -q scripts/test_policy_timing_derive.py
"""

from __future__ import annotations

import hashlib
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from types import ModuleType

import pandas as pd
import psycopg2
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import _report_weights as report_weights  # noqa: E402
import exit_policy_search as policy  # noqa: E402
import flow_inversion_timing as timing  # noqa: E402
from lottery_weights import WeightsInvalid  # noqa: E402  (_report_weights put ml/src on sys.path)

DAYS = ('2026-07-23', '2026-07-24')
VERSION = 'v-2026-11-19'
# The feed cutoffs of the active weights. 13/10 would call a qas of 14 tier 1.
WEIGHTS = {'feed_cutoffs': {'tier1_min_score': 16, 'tier2_min_score': 12}}
LOOK_AHEAD_LINE = (
    "inversion_quintile is the ticker's current value, not the value when each "
    'fire fired (look-ahead), as on the feed'
)

POLICY_COLUMNS = (
    'id',
    'at_15m',
    'at_30m',
    'at_45m',
    'at_60m',
    'at_90m',
    'at_120m',
    'at_180m',
    'trail_25_10',
    'trail_50_15',
    'trail_75_25',
    'cap25_floor10',
    'flow_inv_or_trail50_15',
)
TIMING_COLUMNS = ('id', 'minutes_to_inversion', 'realized_pct')


# ── fakes: Neon at the psycopg2 / pandas boundary ─────────────


class FlowCursor:
    """latest_fire_date's MAX(date), and net-call flow that climbs for 40
    minutes from 15:01Z on the queried day, then sells off: one clear
    inversion, 47 minutes after a 15:00Z trigger."""

    def __init__(self) -> None:
        self.params: tuple | None = None

    def execute(self, _sql: str, params: tuple | None = None) -> None:
        self.params = params

    def fetchone(self) -> tuple:
        return (date(2026, 7, 24),)

    def fetchall(self) -> list:
        if self.params is None:
            return []
        # load_matched_flow passes (ticker, 'YYYY-MM-DDT00:00:00Z', same).
        day = datetime.fromisoformat(self.params[1].replace('Z', '+00:00'))
        start = day.replace(hour=15, minute=1)
        return [
            (start + timedelta(minutes=m), 100.0 if m < 40 else -100.0)
            for m in range(90)
        ]

    def close(self) -> None:
        pass


class FlowConn:
    def cursor(self) -> FlowCursor:
        return FlowCursor()


class RowsCursor:
    """Answers one SELECT with the given rows and remembers what was asked."""

    def __init__(self, rows: list[tuple]) -> None:
        self.rows = rows
        self.sqls: list[str] = []

    def execute(self, sql: str, params: tuple | None = None) -> None:
        self.sqls.append(sql)

    def fetchall(self) -> list[tuple]:
        return self.rows

    def close(self) -> None:
        pass


class RowsConn:
    def __init__(self, rows: list[tuple]) -> None:
        self.cur = RowsCursor(rows)

    def cursor(self) -> RowsCursor:
        return self.cur


# ── fixtures: fires and tape days ─────────────────────────────

DEFAULT_FIRE = {
    'day': DAYS[0],
    'ticker': 'TSLA',
    'option_type': 'C',
    'mode': 'A_intraday_0DTE',
    'dte': 0,
    'score': 20,
    'deduct': 0,
    'gated': False,
    'quintile': 3,
    'flow_inv': 12.5,
}


def make_fires(*specs: dict) -> pd.DataFrame:
    """The rows both scripts read, one per spec, each on its own chain.

    A superset of what the two FIRES_SQL statements select, so one frame
    serves either script: it also carries `round_trip_score_deduct`, which
    neither SQL selects since the 2026-11-17 decision, so a case can show a
    report ignores it. The default fire has qas 20 (score 20, no deduct,
    quintile 3 adds nothing), which is tier 1 under the 16/12 cutoffs.
    """
    rows = []
    for i, spec in enumerate(specs, start=1):
        fire = {**DEFAULT_FIRE, **spec}
        day = fire['day']
        strike = 300_000 + 5_000 * i
        chain = f'{fire["ticker"]}{day.replace("-", "")[2:]}{fire["option_type"]}{strike:08d}'
        rows.append(
            {
                'id': fire.get('id', i),
                'date': date.fromisoformat(day),
                'option_chain_id': chain,
                'underlying_symbol': fire['ticker'],
                'option_type': fire['option_type'],
                'entry_time_ct': pd.Timestamp(f'{day}T15:00:00Z'),
                'trigger_time_ct': pd.Timestamp(f'{day}T15:00:00Z'),
                'entry_price': 1.0,
                'mode': fire['mode'],
                'tod': 'morning',
                'dte': fire['dte'],
                'score': fire['score'],
                'peak': 60.0,
                'trail': 20.0,
                'hard30': 10.0,
                'tier50': 5.0,
                'eod': -30.0,
                'flow_inv': fire['flow_inv'],
                'round_trip_score_deduct': fire['deduct'],
                'direction_gated': fire['gated'],
                'inversion_quintile': fire['quintile'],
            }
        )
    return pd.DataFrame(rows)


def chain_prints(chain: str, day: str) -> list[dict]:
    """One print a minute from 15:00Z for 120 minutes, priced for hand math.

    The price climbs 0.02 a minute to 2.20 at minute 60, then falls 0.035 a
    minute to 0.135 at minute 119: against an entry of 1.00 that is +120% at
    the peak. Prints a filter must drop trail the series, with quotes that
    would move a minute mid if they got through: a canceled print at 9.00 and
    a zero-priced one, once early and once inside minute 47, where the timing
    fixture's inversion lands.
    """
    start = datetime.fromisoformat(f'{day}T15:00:00+00:00')
    prints = []
    for m in range(120):
        price = round(1.0 + 0.02 * min(m, 60) - 0.035 * max(m - 60, 0), 4)
        prints.append(
            {
                'executed_at': start + timedelta(minutes=m),
                'option_chain_id': chain,
                'price': price,
                'nbbo_bid': round(price - 0.05, 4),
                'nbbo_ask': round(price + 0.05, 4),
                'size': 10,
                'canceled': False,
            }
        )
    noise = (
        (timedelta(minutes=10, seconds=30), 9.0, True),
        (timedelta(minutes=20, seconds=30), 0.0, False),
        (timedelta(minutes=47, seconds=30), 9.0, True),
        (timedelta(minutes=47, seconds=45), 0.0, False),
    )
    for offset, price, canceled in noise:
        prints.append(
            {
                'executed_at': start + offset,
                'option_chain_id': chain,
                'price': price,
                'nbbo_bid': 0.95,
                'nbbo_ask': 1.05,
                'size': 10,
                'canceled': canceled,
            }
        )
    return prints


def write_tape(path: Path, prints: list[dict], layout: str = 'new') -> Path:
    """A tape day of `prints`, in the new layout or the legacy one."""

    def col(name: str) -> list:
        return [p[name] for p in prints]

    chain = pa.array(col('option_chain_id'), pa.string())
    if layout == 'new':
        columns = {
            'executed_at': pa.array(col('executed_at'), pa.timestamp('us', tz='UTC')),
            'option_chain_id': chain,
            'price': pa.array(col('price'), pa.float64()),
            'nbbo_bid': pa.array(col('nbbo_bid'), pa.float64()),
            'nbbo_ask': pa.array(col('nbbo_ask'), pa.float64()),
            'size': pa.array(col('size'), pa.int64()),
            'canceled': pa.array(col('canceled'), pa.bool_()),
        }
    elif layout == 'legacy':
        # The January-April files hold every numeric as decimal128, the
        # timestamps naive (UTC clock readings) and `canceled` as 'f' / 't'.
        columns = {
            'executed_at': pa.array(
                [v.astimezone(UTC).replace(tzinfo=None) for v in col('executed_at')],
                pa.timestamp('us'),
            ),
            'option_chain_id': chain,
            'canceled': pa.array(['t' if v else 'f' for v in col('canceled')], pa.string()),
        }
        for name in ('price', 'nbbo_bid', 'nbbo_ask', 'size'):
            columns[name] = pa.array(
                [Decimal(str(v)) for v in col(name)], pa.decimal128(18, 4)
            )
    else:
        raise ValueError(layout)
    pq.write_table(pa.table(columns), path)
    return path


def write_archive(directory: Path, fires: pd.DataFrame, layout: str = 'new') -> Path:
    """A `{day}-trades.parquet` per fire date, holding every fired chain."""
    directory.mkdir(exist_ok=True)
    for day, sub in fires.groupby('date', sort=True):
        prints = [
            p
            for chain in sub['option_chain_id']
            for p in chain_prints(chain, day.isoformat())
        ]
        write_tape(directory / f'{day.isoformat()}-trades.parquet', prints, layout)
    return directory


# ── the two scripts, side by side ─────────────────────────────


@dataclass(frozen=True)
class Kit:
    """What differs between the two scripts, for the tests that run on both."""

    module: ModuleType
    columns: tuple[str, ...]
    report_stem: str
    order_by: str
    tag: str  # the log prefix: "[search]" / "[timing]"

    def derive(self, tape: Path, fires_for_day: pd.DataFrame, day: str) -> pd.DataFrame:
        if self.module is timing:
            return timing.derive_day(FlowConn(), date.fromisoformat(day), tape, fires_for_day)
        return policy.derive_day(tape, fires_for_day)

    def report(self, out_dir: Path, latest: str = '2026-07-24') -> str:
        return (out_dir / f'{self.report_stem}-{latest}.md').read_text(encoding='utf-8')

    def tier_counts(self, report: str) -> dict[str, int]:
        """The n of each tier section the report prints (0 for an absent one)."""
        if self.module is timing:
            pattern = r'^    (T[123])\s+n=\s*([\d,]+)'
        else:
            pattern = r'^### (T[123])  \(n=([\d,]+)\)'
        found = {t: int(n.replace(',', '')) for t, n in re.findall(pattern, report, re.M)}
        return {t: found.get(t, 0) for t in ('T1', 'T2', 'T3')}


EXIT_KIT = Kit(policy, POLICY_COLUMNS, 'lottery-exit-policy-search', 'f.id', 'search')
TIMING_KIT = Kit(timing, TIMING_COLUMNS, 'flow-inversion-timing', 'f.trigger_time_ct', 'timing')


@pytest.fixture(params=[EXIT_KIT, TIMING_KIT], ids=['exit_policy_search', 'flow_inversion_timing'])
def kit(request: pytest.FixtureRequest) -> Kit:
    return request.param


class Harness:
    """One script's `main`, with Neon, the env file and the weights read faked."""

    def __init__(self, kit: Kit, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        self.kit = kit
        self.tmp = tmp_path
        self.monkeypatch = monkeypatch
        self.version = VERSION
        self.weights: dict = WEIGHTS
        self.failure: BaseException | None = None
        self.pointer_names: list[str] = []
        self.fire_reads = 0
        module = kit.module
        monkeypatch.setenv('DATABASE_URL', 'postgresql://test/none')
        monkeypatch.setattr(module, 'ENV_FILE', tmp_path / 'no-such.env')
        monkeypatch.setattr(module, 'ROOT', tmp_path)
        monkeypatch.setattr(module.psycopg2, 'connect', lambda _url: FlowConn())
        # The read lives in _report_weights, shared by both scripts.
        monkeypatch.setattr(report_weights, 'load_pointer', self._load_pointer)

    def _load_pointer(self, _conn: object, name: str) -> tuple[str, dict]:
        self.pointer_names.append(name)
        if self.failure is not None:
            raise self.failure
        return self.version, self.weights

    def serve(self, fires: pd.DataFrame) -> None:
        def read_sql(_sql: str, _conn: object) -> pd.DataFrame:
            self.fire_reads += 1
            return fires

        self.monkeypatch.setattr(self.kit.module.pd, 'read_sql', read_sql)

    def derive_all(self, fires: pd.DataFrame, archive: Path) -> Path:
        """The derived dir the nightly would hold for these fires."""
        derived = self.tmp / 'derived'
        derived.mkdir(exist_ok=True)
        for day, sub in fires.groupby('date', sort=True):
            tape = archive / f'{day.isoformat()}-trades.parquet'
            frame = self.kit.derive(tape, sub, day.isoformat())
            frame.to_parquet(derived / f'{day.isoformat()}.parquet', index=False)
        return derived

    def run(self, *flags: str, out: str = 'out') -> Path:
        out_dir = self.tmp / out
        self.kit.module.main([*flags, '--out-dir', str(out_dir)])
        return out_dir

    def report_of(self, fires: pd.DataFrame, *, layout: str = 'new') -> str:
        """The report main writes for `fires`, read from a fresh archive."""
        self.serve(fires)
        archive = write_archive(self.tmp / f'archive-{layout}', fires, layout)
        return self.kit.report(self.run('--parquet-dir', str(archive), out=f'out-{layout}'))


@pytest.fixture
def harness(kit: Kit, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Harness:
    return Harness(kit, tmp_path, monkeypatch)


@pytest.fixture
def timing_harness(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Harness:
    """For the tests that only the timing report can answer."""
    return Harness(TIMING_KIT, tmp_path, monkeypatch)


@pytest.fixture
def exit_harness(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Harness:
    """For the tests that only the exit-policy report can answer."""
    return Harness(EXIT_KIT, tmp_path, monkeypatch)


# ── derive_day ────────────────────────────────────────────────


def test_derived_columns_are_pinned(kit: Kit) -> None:
    assert kit.module.DERIVED_COLUMNS == kit.columns
    assert kit.module.DERIVE_VERSION == 1


def test_derive_day_matches_process_date(tmp_path: Path) -> None:
    fires = make_fires({}, {})
    archive = write_archive(tmp_path / 'archive', fires)

    from_process = policy.process_date(DAYS[0], fires, archive)
    from_derive = policy.derive_day(archive / f'{DAYS[0]}-trades.parquet', fires)

    assert from_process is not None
    assert len(from_derive) == 2
    pd.testing.assert_frame_equal(from_process, from_derive)


def test_exit_policy_values_are_the_hand_computed_ones(tmp_path: Path) -> None:
    """Pins the numbers, so a refactor that shifts one fails here: the price
    path is in `chain_prints`, the fire enters at 1.00 at 15:00Z."""
    fires = make_fires({})
    archive = write_archive(tmp_path / 'archive', fires)

    row = policy.derive_day(archive / f'{DAYS[0]}-trades.parquet', fires).iloc[0]

    assert row['id'] == 1
    expected = {
        'at_15m': 30.0,
        'at_30m': 60.0,
        'at_45m': 90.0,
        'at_60m': 120.0,
        'at_90m': 15.0,
        'at_120m': -86.5,
        'at_180m': -86.5,
        'trail_25_10': 109.5,
        'trail_50_15': 102.5,
        'trail_75_25': 92.0,
        'cap25_floor10': 109.5,
        # the existing flow-inversion exit (+12.5%) sits at minute 6 (price 1.12)
        'flow_inv_or_trail50_15': 12.0,
    }
    for column, value in expected.items():
        assert row[column] == pytest.approx(value, abs=1e-6), column


def test_timing_values_are_the_hand_computed_ones(tmp_path: Path) -> None:
    fires = make_fires({})
    archive = write_archive(tmp_path / 'archive', fires)

    rows = timing.derive_day(
        FlowConn(), date.fromisoformat(DAYS[0]), archive / f'{DAYS[0]}-trades.parquet', fires
    )

    # Net flow peaks at 15:40 and inverts at 15:47; the minute mid then is 1.94.
    assert rows['id'].tolist() == [1]
    assert rows['minutes_to_inversion'].tolist() == [47.0]
    assert rows['realized_pct'].iloc[0] == pytest.approx(94.0, abs=1e-6)


def test_derive_day_layouts_agree(kit: Kit, tmp_path: Path) -> None:
    fires = make_fires({}, {'option_type': 'P'})
    tapes = {}
    for layout in ('new', 'legacy'):
        directory = write_archive(tmp_path / layout, fires, layout)
        tapes[layout] = directory / f'{DAYS[0]}-trades.parquet'
    # The fixture really is the two layouts, or this test proves nothing.
    legacy_schema = pq.read_schema(tapes['legacy'])
    assert legacy_schema.field('price').type == pa.decimal128(18, 4)
    assert legacy_schema.field('executed_at').type.tz is None
    assert pa.types.is_string(legacy_schema.field('canceled').type)
    new_schema = pq.read_schema(tapes['new'])
    assert new_schema.field('executed_at').type.tz == 'UTC'
    assert pa.types.is_boolean(new_schema.field('canceled').type)

    new = kit.derive(tapes['new'], fires, DAYS[0])
    legacy = kit.derive(tapes['legacy'], fires, DAYS[0])

    assert len(new) == 2
    pd.testing.assert_frame_equal(new, legacy, check_exact=True)


def test_derived_frames_have_the_pinned_dtypes(kit: Kit, tmp_path: Path) -> None:
    fires = make_fires({})
    archive = write_archive(tmp_path / 'archive', fires)

    frame = kit.derive(archive / f'{DAYS[0]}-trades.parquet', fires, DAYS[0])

    assert list(frame.columns) == list(kit.columns)
    assert {c: str(t) for c, t in frame.dtypes.items()} == {
        c: ('int64' if c == 'id' else 'float64') for c in kit.columns
    }


def test_empty_derive_keeps_the_columns(kit: Kit, tmp_path: Path) -> None:
    fires = make_fires({})
    # A tape that holds none of the fired chains.
    other = write_tape(
        tmp_path / 'other.parquet', chain_prints('SPY260723C00600000', DAYS[0])
    )
    no_chain = kit.derive(other, fires, DAYS[0])
    # A day with no fires reads no tape at all.
    no_fires = kit.derive(tmp_path / 'absent.parquet', fires.iloc[0:0], DAYS[0])

    for frame in (no_chain, no_fires):
        assert len(frame) == 0
        assert list(frame.columns) == list(kit.columns)
        assert {c: str(t) for c, t in frame.dtypes.items()} == {
            c: ('int64' if c == 'id' else 'float64') for c in kit.columns
        }


def test_a_corrupt_tape_fails_rather_than_deriving_nothing(kit: Kit, tmp_path: Path) -> None:
    bad = tmp_path / 'bad.parquet'
    bad.write_bytes(b'not a parquet file')

    with pytest.raises(pa.ArrowInvalid):
        kit.derive(bad, make_fires({}), DAYS[0])


def test_a_tape_without_a_needed_column_fails_by_name(kit: Kit, tmp_path: Path) -> None:
    fires = make_fires({})
    full = write_tape(tmp_path / 'full.parquet', chain_prints(fires['option_chain_id'][0], DAYS[0]))
    short = tmp_path / 'short.parquet'
    table = pq.read_table(full)
    pq.write_table(table.select([n for n in table.column_names if n != 'canceled']), short)

    with pytest.raises(pa.ArrowInvalid, match='canceled'):
        kit.derive(short, fires, DAYS[0])


def test_a_corrupt_price_fails_rather_than_becoming_nan(kit: Kit, tmp_path: Path) -> None:
    """A value that is no number is an error: coerced to NaN it would drop its
    print (price > 0 is False) and the day would report on the rest."""
    fires = make_fires({})
    full = write_tape(tmp_path / 'full.parquet', chain_prints(fires['option_chain_id'][0], DAYS[0]))
    table = pq.read_table(full)
    prices = [str(v) for v in table['price'].to_pylist()]
    prices[3] = 'oops'
    corrupt = table.set_column(
        table.schema.get_field_index('price'), 'price', pa.array(prices, pa.string())
    )
    bad = tmp_path / 'bad.parquet'
    pq.write_table(corrupt, bad)

    with pytest.raises((ValueError, TypeError)):
        kit.derive(bad, fires, DAYS[0])


def test_derive_output_is_ordered_by_id(kit: Kit, tmp_path: Path) -> None:
    fires = make_fires({'id': 9}, {'id': 3}, {'id': 5})
    archive = write_archive(tmp_path / 'archive', fires)

    frame = kit.derive(archive / f'{DAYS[0]}-trades.parquet', fires, DAYS[0])

    assert frame['id'].tolist() == [3, 5, 9]


def test_timing_derive_keeps_only_true_inversions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Net flow that peaks and then ends before an inversion can form (5
    minutes of decline) exits at the EOD fallback: it has an exit time, and it
    is still not a timing row, as it would skew the timings toward 15:00."""
    fires = make_fires({}, {})
    archive = write_archive(tmp_path / 'archive', fires)

    class ShortCursor(FlowCursor):
        def fetchall(self) -> list:
            start = datetime(2026, 7, 23, 15, 1, tzinfo=UTC)
            return [
                (start + timedelta(minutes=m), 100.0 if m < 40 else -100.0) for m in range(45)
            ]

    class ShortConn:
        def cursor(self) -> ShortCursor:
            return ShortCursor()

    outcomes: list[tuple] = []
    real = timing.simulate_flow_inversion

    def spy(*args: object) -> tuple:
        outcomes.append(real(*args))
        return outcomes[-1]

    monkeypatch.setattr(timing, 'simulate_flow_inversion', spy)

    rows = timing.derive_day(
        ShortConn(), date.fromisoformat(DAYS[0]), archive / f'{DAYS[0]}-trades.parquet', fires
    )

    # The fixture does what it says: an exit time, and a status that is no inversion.
    assert len(outcomes) == 2
    assert all(ts is not None and status != 'inversion' for _, ts, status in outcomes)
    assert len(rows) == 0
    assert list(rows.columns) == list(TIMING_COLUMNS)


# ── fingerprints ──────────────────────────────────────────────

EXIT_EXPR = (
    "md5(string_agg(id::text || ':' || (realized_flow_inversion_pct IS NOT NULL)::int::text, "
    "',' ORDER BY id))"
)
TIMING_EXPR = "md5(string_agg(id::text, ',' ORDER BY id))"


@pytest.mark.parametrize(
    ('module', 'canonical', 'expression', 'population'),
    [
        pytest.param(
            policy,
            '1:1,2:0,10:1',
            EXIT_EXPR,
            'peak_ceiling_pct IS NOT NULL',
            id='exit_policy_search',
        ),
        pytest.param(
            timing,
            '1,2,10',
            TIMING_EXPR,
            'realized_flow_inversion_pct IS NOT NULL',
            id='flow_inversion_timing',
        ),
    ],
)
def test_fingerprint_canonical_form(
    module: ModuleType, canonical: str, expression: str, population: str
) -> None:
    # Ids out of order, and the middle fire has no inversion value.
    fires = pd.DataFrame({'id': [10, 2, 1], 'flow_inv': [3.0, None, 7.5]})

    assert module.fingerprint_rows(fires) == hashlib.md5(canonical.encode()).hexdigest()
    sql = ' '.join(module.DAY_FINGERPRINT_SQL.split())
    assert expression in sql
    assert f'WHERE {population}' in sql
    assert sql.endswith('GROUP BY date')
    assert 'JOIN' not in sql  # the fingerprint reads lottery_finder_fires alone


def test_fingerprint_ids_sort_numerically_not_as_text() -> None:
    fires = pd.DataFrame({'id': [10, 9, 100], 'flow_inv': [1.0, 1.0, 1.0]})
    assert timing.fingerprint_rows(fires) == hashlib.md5(b'9,10,100').hexdigest()
    assert policy.fingerprint_rows(fires) == hashlib.md5(b'9:1,10:1,100:1').hexdigest()


def test_fingerprint_of_no_fires_is_the_md5_of_nothing() -> None:
    empty = pd.DataFrame({'id': pd.Series([], dtype='int64'), 'flow_inv': pd.Series([], dtype='float64')})
    assert timing.fingerprint_rows(empty) == hashlib.md5(b'').hexdigest()
    assert policy.fingerprint_rows(empty) == hashlib.md5(b'').hexdigest()


def test_exit_fingerprint_changes_when_an_inversion_appears() -> None:
    before = pd.DataFrame({'id': [1, 2], 'flow_inv': [3.0, None]})
    after = pd.DataFrame({'id': [1, 2], 'flow_inv': [3.0, 4.0]})
    assert policy.fingerprint_rows(before) != policy.fingerprint_rows(after)


def test_exit_fingerprint_reads_a_decimal_inversion_as_set() -> None:
    # NUMERIC arrives from psycopg2 as Decimal in an object column.
    fires = pd.DataFrame({'id': [1, 2], 'flow_inv': [Decimal('3.5'), None]})
    assert policy.fingerprint_rows(fires) == hashlib.md5(b'1:1,2:0').hexdigest()


def test_day_fingerprints_parses_dates(kit: Kit) -> None:
    conn = RowsConn(
        [
            (date(2026, 7, 23), 'a' * 32),
            (datetime(2026, 7, 24, 0, 0), 'b' * 32),
            ('2026-07-25', 'c' * 32),
        ]
    )

    result = kit.module.day_fingerprints(conn)

    assert result == {
        date(2026, 7, 23): 'a' * 32,
        date(2026, 7, 24): 'b' * 32,
        date(2026, 7, 25): 'c' * 32,
    }
    assert all(type(day) is date for day in result)
    assert conn.cur.sqls == [kit.module.DAY_FINGERPRINT_SQL]


# ── FIRES_SQL and fires_for_day ───────────────────────────────


def test_fires_sql_reads_the_feed_columns_and_ends_at_its_where(kit: Kit) -> None:
    sql = ' '.join(kit.module.FIRES_SQL.split())
    selected = sql.split(' FROM ')[0]

    assert 'LEFT JOIN lottery_ticker_stats s ON s.ticker = f.underlying_symbol' in sql
    # In the SELECT list, not merely somewhere in the text (the join names the symbol too).
    for column in (
        'f.underlying_symbol',
        'f.direction_gated',
        's.inversion_quintile',
    ):
        assert column in selected, column
    # 2026-11-17 decision: the feed's qas leaves the round-trip deduct out, so
    # the report does not read it.
    assert 'round_trip_score_deduct' not in sql
    assert 'ORDER BY' not in sql
    population = (
        'f.peak_ceiling_pct IS NOT NULL'
        if kit.module is policy
        else 'f.realized_flow_inversion_pct IS NOT NULL'
    )
    assert sql.endswith(f'WHERE {population}')


def test_fires_for_day_adds_the_day_to_the_population_query(
    kit: Kit, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: dict = {}
    frame = make_fires({})

    def read_sql(sql: str, conn: object, **kwargs: object) -> pd.DataFrame:
        seen.update(sql=' '.join(sql.split()), conn=conn, params=kwargs.get('params'))
        return frame

    monkeypatch.setattr(kit.module.pd, 'read_sql', read_sql)
    conn = FlowConn()

    result = kit.module.fires_for_day(conn, date(2026, 7, 23))

    assert result is frame
    base = ' '.join(kit.module.FIRES_SQL.split())
    assert seen['sql'] == f'{base} AND f.date = %s ORDER BY {kit.order_by}'
    assert seen['conn'] is conn
    assert tuple(seen['params']) == (date(2026, 7, 23),)


# ── load_derived ──────────────────────────────────────────────


def derived_rows(module: ModuleType, *ids: int) -> pd.DataFrame:
    """A derived frame for `ids`, in the module's pinned columns and dtypes."""
    data = {c: [float(i) + 0.5 for i in ids] for c in module.DERIVED_COLUMNS}
    data['id'] = list(ids)
    return pd.DataFrame(data).astype(
        {c: ('int64' if c == 'id' else 'float64') for c in module.DERIVED_COLUMNS}
    )


def test_load_derived_returns_rows_and_the_days_without_a_file(kit: Kit, tmp_path: Path) -> None:
    derived_rows(kit.module, 1, 2).to_parquet(tmp_path / '2026-07-23.parquet', index=False)
    derived_rows(kit.module, 3).to_parquet(tmp_path / '2026-07-25.parquet', index=False)

    rows, missing = kit.module.load_derived(
        tmp_path, ['2026-07-23', '2026-07-24', '2026-07-25']
    )

    assert missing == ['2026-07-24']
    assert rows['id'].tolist() == [1, 2, 3]
    assert list(rows.columns) == list(kit.columns)
    assert {c: str(t) for c, t in rows.dtypes.items()} == {
        c: ('int64' if c == 'id' else 'float64') for c in kit.columns
    }


def test_load_derived_with_no_files_returns_the_pinned_empty_frame(
    kit: Kit, tmp_path: Path
) -> None:
    rows, missing = kit.module.load_derived(tmp_path, ['2026-07-23', '2026-07-24'])

    assert missing == ['2026-07-23', '2026-07-24']
    assert len(rows) == 0
    assert list(rows.columns) == list(kit.columns)


def test_load_derived_counts_an_empty_file_as_derived(kit: Kit, tmp_path: Path) -> None:
    """A day that derived 0 rows is recorded: its file exists with no rows."""
    derived_rows(kit.module).to_parquet(tmp_path / '2026-07-23.parquet', index=False)

    rows, missing = kit.module.load_derived(tmp_path, ['2026-07-23'])

    assert missing == []
    assert len(rows) == 0


def test_load_derived_fails_by_name_on_a_malformed_file(kit: Kit, tmp_path: Path) -> None:
    broken = derived_rows(kit.module, 1).drop(columns=[kit.columns[-1]])
    broken.to_parquet(tmp_path / '2026-07-23.parquet', index=False)

    with pytest.raises(ValueError, match=r'2026-07-23\.parquet.*' + kit.columns[-1]):
        kit.module.load_derived(tmp_path, ['2026-07-23'])


# ── CLI ───────────────────────────────────────────────────────


def test_one_source_flag_is_required_and_they_exclude_each_other(
    kit: Kit, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(SystemExit) as exc:
        kit.module.parse_args([])
    assert exc.value.code == 2
    err = capsys.readouterr().err
    assert '--parquet-dir' in err
    assert '--derived-dir' in err

    with pytest.raises(SystemExit) as exc:
        kit.module.parse_args(['--parquet-dir', str(tmp_path), '--derived-dir', str(tmp_path)])
    assert exc.value.code == 2
    assert 'not allowed with' in capsys.readouterr().err


@pytest.mark.parametrize('script', ['exit_policy_search.py', 'flow_inversion_timing.py'])
def test_the_scripts_start_with_only_their_own_folder_on_sys_path(
    script: str, tmp_path: Path
) -> None:
    """`make update` runs `python scripts/<script>`: ml/src, where the feed's
    tier rule lives, has to be put on the path by the script itself."""
    env = {k: v for k, v in os.environ.items() if k != 'PYTHONPATH'}
    env['PYTHONUTF8'] = '1'

    done = subprocess.run(
        [sys.executable, str(SCRIPTS / script), '--help'],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        encoding='utf-8',
        timeout=120,
        check=False,
    )

    assert done.returncode == 0, done.stderr
    assert '--derived-dir' in done.stdout


def test_derived_dir_parses_to_a_path_and_must_exist(
    kit: Kit, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    args = kit.module.parse_args(['--derived-dir', str(tmp_path)])
    assert args.derived_dir == tmp_path
    assert args.parquet_dir is None
    assert args.out_dir == kit.module.ROOT / 'docs' / 'tmp'

    missing = tmp_path / 'not-there'
    with pytest.raises(SystemExit) as exc:
        kit.module.parse_args(['--derived-dir', str(missing)])
    assert exc.value.code == 2
    err = capsys.readouterr().err
    assert '--derived-dir' in err
    assert str(missing) in err


# ── reports: derived files against the tape ───────────────────


def test_derived_dir_report_matches_parquet_dir_report(kit: Kit, harness: Harness) -> None:
    fires = make_fires(
        {},
        {'option_type': 'P', 'mode': 'B_intraday_1DTE', 'dte': 1},
        {'day': DAYS[1]},
        {'day': DAYS[1], 'score': 5},
    )
    harness.serve(fires)
    archive = write_archive(harness.tmp / 'archive', fires)

    from_tape = kit.report(harness.run('--parquet-dir', str(archive), out='from-tape'))
    derived = harness.derive_all(fires, archive)
    from_derived = kit.report(harness.run('--derived-dir', str(derived), out='from-derived'))

    assert from_derived == from_tape
    # Not a degenerate pair: the report has its tier sections and the header.
    assert f'T1 = qas ≥ 16, T2 = qas ≥ 12 (feed cutoffs of version {VERSION})' in from_tape
    assert sum(kit.tier_counts(from_tape).values()) == 4


def test_derived_dir_lists_days_not_derived(
    kit: Kit, harness: Harness, capsys: pytest.CaptureFixture[str]
) -> None:
    days = ('2026-07-22', '2026-07-23', '2026-07-24')
    fires = make_fires(*({'day': d} for d in days))
    harness.serve(fires)
    archive = write_archive(harness.tmp / 'archive', fires)
    derived = harness.derive_all(fires, archive)
    (derived / '2026-07-22.parquet').unlink()
    (derived / '2026-07-24.parquet').unlink()
    capsys.readouterr()

    out_dir = harness.run('--derived-dir', str(derived))

    out, err = capsys.readouterr()
    assert '1 day(s) read, 2 day(s) skipped, not derived yet' in out
    for stream in (out, err):
        assert 'skipped (not derived yet): 2026-07-22, 2026-07-24' in stream
        assert 'archive missing' not in stream
    report = kit.report(out_dir, latest='2026-07-24')
    assert '2 day(s) skipped (not derived yet): 2026-07-22, 2026-07-24.' in report
    assert 'archive missing' not in report


def test_derived_dir_with_no_derived_day_exits_0_and_writes_no_report(
    kit: Kit, harness: Harness, capsys: pytest.CaptureFixture[str]
) -> None:
    harness.serve(make_fires({}, {'day': DAYS[1]}))
    empty = harness.tmp / 'derived'
    empty.mkdir()

    out_dir = harness.run('--derived-dir', str(empty))  # returns: exit 0

    out, err = capsys.readouterr()
    assert '0 day(s) read, 2 day(s) skipped, not derived yet' in out
    assert 'no derived day to read — no report written' in out
    assert 'skipped (not derived yet): 2026-07-23, 2026-07-24' in err
    assert not out_dir.exists() or not any(out_dir.iterdir())


def test_timing_derived_rows_join_fire_attributes(
    timing_harness: Harness, tmp_path: Path
) -> None:
    """The derived file holds id, minutes and pct only: the ticker, mode, tier,
    dte and option type in the report follow the fire, not the file."""
    kit = TIMING_KIT
    harness = timing_harness
    before = make_fires({}, {'day': DAYS[1]}, {'day': DAYS[1]})
    harness.serve(before)
    archive = write_archive(tmp_path / 'archive', before)
    derived = harness.derive_all(before, archive)

    first = kit.report(harness.run('--derived-dir', str(derived), out='first'))

    # The same derived files, but fire 2 is now a lower tier, another mode, a
    # put on AAPL at 1 DTE.
    after = make_fires(
        {},
        {'day': DAYS[1], 'score': 5, 'mode': 'B_intraday_1DTE', 'dte': 1, 'option_type': 'P', 'ticker': 'AAPL'},
        {'day': DAYS[1]},
    )
    after['id'] = before['id']
    harness.serve(after)
    second = kit.report(harness.run('--derived-dir', str(derived), out='second'))

    assert kit.tier_counts(first) == {'T1': 3, 'T2': 0, 'T3': 0}
    assert kit.tier_counts(second) == {'T1': 2, 'T2': 0, 'T3': 1}
    assert f'    {"A_intraday_0DTE":<22} n=2 (insufficient)' in second
    assert f'    {"B_intraday_1DTE":<22} n=1 (insufficient)' in second
    assert '    DTE 1  n=1 (insufficient)' in second
    assert f'    {"P":<3} n=1 (insufficient)' in second
    assert first != second
    assert list(pd.read_parquet(derived / f'{DAYS[1]}.parquet').columns) == list(TIMING_COLUMNS)


def test_a_derived_row_without_a_fire_is_left_out_of_the_report(
    kit: Kit, harness: Harness
) -> None:
    fires = make_fires({}, {'day': DAYS[1]})
    harness.serve(fires)
    archive = write_archive(harness.tmp / 'archive', fires)
    derived = harness.derive_all(fires, archive)
    plain = kit.report(harness.run('--derived-dir', str(derived), out='plain'))

    # A fire that lost its inversion value is no longer in the population, but
    # its derived row is still in the day's file.
    stale = pd.read_parquet(derived / f'{DAYS[0]}.parquet')
    extra = stale.iloc[[0]].assign(id=99)
    pd.concat([stale, extra], ignore_index=True).astype(stale.dtypes.to_dict()).to_parquet(
        derived / f'{DAYS[0]}.parquet', index=False
    )
    with_stale = kit.report(harness.run('--derived-dir', str(derived), out='stale'))

    assert with_stale == plain


def test_a_fire_without_derived_values_stays_in_the_exit_report(exit_harness: Harness) -> None:
    """The existing policies (and the tier counts) cover every enriched fire;
    only the derived candidates are missing for a fire with no post-entry
    print."""
    harness = exit_harness
    fires = make_fires({}, {})
    harness.serve(fires)
    archive = harness.tmp / 'archive'
    archive.mkdir()
    # The tape holds the first fire's chain only.
    write_tape(
        archive / f'{DAYS[0]}-trades.parquet',
        chain_prints(fires['option_chain_id'][0], DAYS[0]),
    )

    report = EXIT_KIT.report(harness.run('--parquet-dir', str(archive)))

    assert EXIT_KIT.tier_counts(report)['T1'] == 2
    assert re.search(r'flow_inv \(existing\)\s+2\s', report)
    assert re.search(r'exit at 30 min\s+1\s', report)


def test_exit_report_counts_the_tickers_in_its_dataset_line(exit_harness: Harness) -> None:
    fires = make_fires(
        {'ticker': 'TSLA'},
        {'ticker': 'AAPL'},
        {'ticker': 'TSLA', 'day': DAYS[1]},
    )

    report = exit_harness.report_of(fires)

    assert (
        'Dataset: 3 enriched fires across 2 trading days '
        '(2026-07-23 → 2026-07-24), 2 tickers.'
    ) in report
    assert '?' not in report.split('## Aggregate')[0]


def test_the_same_id_in_two_derived_days_fails_the_report(kit: Kit, harness: Harness) -> None:
    """Derived rows are one per fire: a duplicate id is a corrupt derived dir,
    and the report must not average it in twice."""
    fires = make_fires({}, {'day': DAYS[1]})
    harness.serve(fires)
    archive = write_archive(harness.tmp / 'archive', fires)
    derived = harness.derive_all(fires, archive)
    pd.read_parquet(derived / f'{DAYS[0]}.parquet').to_parquet(
        derived / f'{DAYS[1]}.parquet', index=False
    )

    with pytest.raises(pd.errors.MergeError):
        harness.run('--derived-dir', str(derived))

    assert not list(harness.tmp.rglob('*.md'))


def test_missing_env_file_is_not_fatal(kit: Kit, harness: Harness) -> None:
    fires = make_fires({})
    assert not kit.module.ENV_FILE.exists()

    report = harness.report_of(fires)

    assert report.startswith('# ')


def test_reports_write_utf8(
    kit: Kit, harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The reports hold → and ≥. A host whose default text encoding is a legacy
    code page must not decide how they are written."""
    real = Path.write_text

    def legacy_default(self: Path, data: str, encoding: str | None = None, **kwargs: object):
        return real(self, data, encoding=encoding or 'cp1252', **kwargs)

    monkeypatch.setattr(Path, 'write_text', legacy_default)
    fires = make_fires({})
    harness.serve(fires)
    archive = write_archive(harness.tmp / 'archive', fires)

    out_dir = harness.run('--parquet-dir', str(archive))

    text = next(out_dir.glob(f'{kit.report_stem}-*.md')).read_bytes().decode('utf-8')
    assert '≥' in text
    if kit.module is policy:
        assert '→' in text


# ── owner ruling 2026-11-19: tier the way the feed does ───────
# The feed's tier is fixed at the fire (owner decision 2026-11-17, spec
# 2026-11-17-freeze-tier-at-fire-design.md): qas = GREATEST(0, score) + the
# inversion bonus, with no round-trip deduct and no gamma term.

TIER_CASES = [
    pytest.param({'score': 17}, 'T1', id='qas-17-is-T1'),
    pytest.param({'score': 16}, 'T1', id='qas-at-the-T1-cutoff'),
    pytest.param({'score': 14}, 'T2', id='qas-14-is-T2-where-13-10-would-say-T1'),
    pytest.param({'score': 12}, 'T2', id='qas-at-the-T2-cutoff'),
    pytest.param({'score': 11}, 'T3', id='qas-11-is-T3'),
    # 2026-11-17 decision: the -3 deduct is ignored, so qas stays 18 (T1); it
    # was 15 (T2) while the feed subtracted the deduct.
    pytest.param(
        {'score': 18, 'deduct': -3, 'quintile': 3}, 'T1', id='round-trip-deduct-is-ignored'
    ),
    # Bare 14 is T2 under 16/12; the quintile 5 bonus makes it qas 19 (T1).
    pytest.param({'score': 14, 'quintile': 5}, 'T1', id='quintile-5-bonus-takes-14-to-19'),
    pytest.param({'score': 14, 'quintile': 4}, 'T1', id='quintile-bonus-takes-14-to-17'),
    pytest.param({'score': 17, 'quintile': None}, 'T1', id='no-ticker-stats-row-adds-nothing'),
    pytest.param({'score': 20, 'quintile': 2}, 'T3', id='quintile-2-is-forced-T3'),
    pytest.param({'score': 20, 'quintile': 1}, 'T3', id='quintile-1-is-forced-T3'),
    pytest.param({'score': 20, 'gated': True}, 'T3', id='direction-gated-is-forced-T3'),
    pytest.param({'score': None}, 'T3', id='null-score-is-T3'),
]


@pytest.mark.parametrize(('spec', 'tier'), TIER_CASES)
def test_reports_tier_with_the_active_feed_cutoffs(
    kit: Kit, harness: Harness, spec: dict, tier: str
) -> None:
    report = harness.report_of(make_fires(spec))

    expected = {'T1': 0, 'T2': 0, 'T3': 0}
    expected[tier] = 1
    assert kit.tier_counts(report) == expected


def test_reports_tier_a_whole_population_with_the_active_feed_cutoffs(
    kit: Kit, harness: Harness
) -> None:
    fires = make_fires(*(case.values[0] for case in TIER_CASES))
    expected = {'T1': 0, 'T2': 0, 'T3': 0}
    for case in TIER_CASES:
        expected[case.values[1]] += 1

    report = harness.report_of(fires)

    assert kit.tier_counts(report) == expected
    assert harness.pointer_names == ['active']


@pytest.mark.parametrize(
    'failure',
    [
        pytest.param(LookupError('lottery_score_pointers has no row named active'), id='no-active-pointer'),
        pytest.param(WeightsInvalid('features.dte_weights', 'range'), id='invalid-weights'),
        pytest.param(psycopg2.OperationalError('host=db.example password=hunter2'), id='db-error'),
    ],
)
def test_reports_fail_without_active_weights(kit: Kit, harness: Harness, failure: Exception) -> None:
    fires = make_fires({})
    harness.serve(fires)
    archive = write_archive(harness.tmp / 'archive', fires)
    harness.failure = failure

    with pytest.raises(report_weights.ActiveWeightsError) as exc:
        harness.run('--parquet-dir', str(archive))

    message = str(exc.value)
    assert message.startswith(f'[{kit.tag}] cannot read the active lottery weights (')
    assert message.endswith('no report written')
    assert type(failure).__name__ in message
    assert 'hunter2' not in message  # a DB error's text can hold the DSN
    # Nothing was read or written: no fires, no report, no fallback tiers.
    assert harness.fire_reads == 0
    assert not (harness.tmp / 'out').exists()
    assert not list(harness.tmp.rglob('*.md'))


def test_report_header_names_the_active_version_and_cutoffs(kit: Kit, harness: Harness) -> None:
    harness.version = 'seed-2026-06-17'
    harness.weights = {'feed_cutoffs': {'tier1_min_score': 13, 'tier2_min_score': 10}}

    report = harness.report_of(make_fires({}))

    assert 'seed-2026-06-17' in report
    assert 'T1 = qas ≥ 13, T2 = qas ≥ 10 (feed cutoffs of version seed-2026-06-17)' in report
    assert LOOK_AHEAD_LINE in report
    # What qas is: the floored score plus the inversion bonus, with no round-trip
    # deduct (owner decision 2026-11-17).
    assert 'qas = GREATEST(0, score) + inversion bonus' in report
    assert 'deduct' not in report
    assert 'score ≥ 18' not in report
    assert 'score ≥ 12' not in report


def test_reports_have_no_bare_score_tier_cutoffs(kit: Kit) -> None:
    for module in (kit.module, report_weights):
        source = Path(module.__file__).read_text(encoding='utf-8')

        assert '>= 18' not in source, module.__name__
        assert '>= 12' not in source, module.__name__
        assert '≥ 18' not in source, module.__name__


# ── the shared module: _report_weights ────────────────────────


def test_neither_script_keeps_its_own_copy_of_the_shared_pieces(kit: Kit) -> None:
    """The read-or-exit contract, the tiers and the header text live once, in
    _report_weights: the scripts hold that module's objects, not copies."""
    for name in ('FeedCutoffs', 'load_active_weights', 'tier_labels', 'tier_header'):
        assert getattr(kit.module, name) is getattr(report_weights, name), name
    # Nothing a copy would need is left in the script.
    for name in ('load_active_cutoffs', 'LOOK_AHEAD_NOTE', 'load_pointer', 'feed_qas'):
        assert not hasattr(kit.module, name), name
    source = Path(kit.module.__file__).read_text(encoding='utf-8')
    for text in ('def load_active', 'def tier_', 'LOOK_AHEAD', 'feed_qas', 'load_pointer'):
        assert text not in source, text


def test_load_active_weights_returns_the_version_and_the_full_weights(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Task 3b's reports read more than the cutoffs: the whole object comes back."""
    weights = {**WEIGHTS, 'features': {'ticker_weights': {}}}
    asked: list[str] = []

    def load_pointer(_conn: object, name: str) -> tuple[str, dict]:
        asked.append(name)
        return 'v-shared', weights

    monkeypatch.setattr(report_weights, 'load_pointer', load_pointer)

    version, got = report_weights.load_active_weights(object(), 'anything')

    assert version == 'v-shared'
    assert got is weights
    assert asked == ['active']


@pytest.mark.parametrize(
    ('failure', 'detail'),
    [
        pytest.param(
            LookupError('lottery_score_pointers has no row named active'),
            'LookupError: lottery_score_pointers has no row named active',
            id='no-active-pointer',
        ),
        pytest.param(
            WeightsInvalid('features.dte_weights', 'range'),
            f'WeightsInvalid: {WeightsInvalid("features.dte_weights", "range")}',
            id='invalid-weights',
        ),
        pytest.param(
            psycopg2.OperationalError('host=db.example password=hunter2'),
            'OperationalError',
            id='db-error',
        ),
    ],
)
def test_load_active_weights_raises_naming_the_tag_and_the_class(
    monkeypatch: pytest.MonkeyPatch, failure: Exception, detail: str
) -> None:
    def load_pointer(_conn: object, _name: str) -> tuple[str, dict]:
        raise failure

    monkeypatch.setattr(report_weights, 'load_pointer', load_pointer)

    with pytest.raises(report_weights.ActiveWeightsError) as exc:
        report_weights.load_active_weights(object(), 'a-tag')

    # A DB error's text can hold the DSN: its class is named, its text is not.
    assert str(exc.value) == (
        f'[a-tag] cannot read the active lottery weights ({detail}); no report written'
    )
    # `from None`: the cause stays out of the traceback, whatever it says.
    assert exc.value.__cause__ is None
    assert exc.value.__suppress_context__ is True


def test_active_weights_error_is_a_named_runtime_error() -> None:
    assert issubclass(report_weights.ActiveWeightsError, RuntimeError)
    assert 'ActiveWeightsError' in report_weights.__all__
    # The nightly reads the class from a traceback's last line: it must end in Error.
    assert report_weights.ActiveWeightsError.__name__.endswith('Error')


def test_load_active_weights_does_not_swallow_a_bug(monkeypatch: pytest.MonkeyPatch) -> None:
    def load_pointer(_conn: object, _name: str) -> tuple[str, dict]:
        raise RuntimeError('a bug')

    monkeypatch.setattr(report_weights, 'load_pointer', load_pointer)

    with pytest.raises(RuntimeError, match='a bug') as exc:
        report_weights.load_active_weights(object(), 'a-tag')

    assert not isinstance(exc.value, report_weights.ActiveWeightsError)


# Runs a report script as `__main__` the way the nightly does (a subprocess), with
# the connection and the weights read faked inside it: the read fails with a DB
# error whose text holds a password.
FAILING_READ_DRIVER = """
import runpy, sys
sys.path.insert(0, sys.argv[1])
import psycopg2
import _report_weights

psycopg2.connect = lambda _url: object()


def _fail(_conn, _name):
    raise psycopg2.OperationalError('host=db.example password=hunter2')


_report_weights.load_pointer = _fail
script = sys.argv[2]
sys.argv = [script, *sys.argv[3:]]
runpy.run_path(script, run_name='__main__')
"""


@pytest.mark.parametrize(
    ('script', 'tag'),
    [
        pytest.param('exit_policy_search.py', 'search', id='exit_policy_search'),
        pytest.param('flow_inversion_timing.py', 'timing', id='flow_inversion_timing'),
    ],
)
def test_a_failed_weights_read_ends_the_script_with_a_named_error_and_no_dsn(
    script: str, tag: str, tmp_path: Path
) -> None:
    """The nightly runs these as subprocesses and reports the exception class
    from the traceback's last line: it must name ActiveWeightsError, and the
    DB error behind it (and its text) must not be in the traceback."""
    env = {k: v for k, v in os.environ.items() if k != 'PYTHONPATH'}
    env['PYTHONUTF8'] = '1'
    env['DATABASE_URL'] = 'postgresql://test/none'
    env['DATABASE_URL_UNPOOLED'] = 'postgresql://test/none'
    derived = tmp_path / 'derived'
    derived.mkdir()

    done = subprocess.run(
        [
            sys.executable,
            '-c',
            FAILING_READ_DRIVER,
            str(SCRIPTS),
            str(SCRIPTS / script),
            '--derived-dir',
            str(derived),
            '--out-dir',
            str(tmp_path / 'out'),
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        encoding='utf-8',
        timeout=120,
        check=False,
    )

    assert done.returncode == 1, done.stderr
    last_line = done.stderr.rstrip().splitlines()[-1]
    assert last_line.startswith(
        f'_report_weights.ActiveWeightsError: [{tag}] cannot read the active lottery weights '
        '(OperationalError); no report written'
    )
    for text in ('hunter2', 'During handling of the above exception', 'direct cause'):
        assert text not in done.stderr, text
    assert not (tmp_path / 'out').exists()
