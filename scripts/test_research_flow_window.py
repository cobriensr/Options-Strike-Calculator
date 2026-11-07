"""The two flow research scripts read each day's net flow through
enrich_lottery_outcomes.load_matched_flow, not their own copy of the query.

flow_inversion_timing.py and tune_flow_inversion.py each carried the query
inline with `+ INTERVAL '1 day'`: a calendar day in the session zone, 23 or 25
hours across a DST change, while the enrich script's loader (and its work-date
EXISTS) count exactly 24. Going through the loader keeps the research on the
same window the enrichment writes its values from.

Each script is driven for one day with Neon faked at the module boundary
(psycopg2.connect, pandas.read_sql) and the loader replaced by a recorder, so
the test sees which (ticker, side) pairs are loaded and which flow each fire
is simulated with. Run:

    ml/.venv/Scripts/python -m pytest -q scripts/test_research_flow_window.py
"""

from __future__ import annotations

import sys
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import flow_inversion_timing as timing  # noqa: E402
import tune_flow_inversion as tune  # noqa: E402

DAY = '2026-07-22'
ENTRY = datetime(2026, 7, 22, 15, 0, tzinfo=timezone.utc)
CALL_CHAIN = 'TSLA260722C00300000'
PUT_CHAIN = 'TSLA260722P00300000'
# Different flow per side, so a fire simulated with the wrong side shows.
CALL_FLOW = [(ENTRY + timedelta(minutes=1), 1.0)]
PUT_FLOW = [(ENTRY + timedelta(minutes=1), 2.0)]


class FakeCursor:
    def __init__(self, conn: FakeConn) -> None:
        self.conn = conn

    def execute(self, sql: str, params: tuple | None = None) -> None:
        self.conn.sqls.append(' '.join(sql.split()))

    def fetchone(self):
        return (date(2026, 7, 22),)  # latest_fire_date's MAX(date)

    def fetchall(self) -> list:
        return []

    def close(self) -> None:
        pass


class FakeConn:
    """What psycopg2.connect returns; records every statement it is sent."""

    def __init__(self) -> None:
        self.sqls: list[str] = []

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def close(self) -> None:
        pass

    def flow_sqls(self) -> list[str]:
        return [s for s in self.sqls if 'net_flow_per_ticker_history' in s]


class FlowLoader:
    """Stands in for load_matched_flow: records its calls, answers by side."""

    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def __call__(self, conn, target_date: str, ticker: str, option_type: str):
        self.calls.append((conn, target_date, ticker, option_type))
        return CALL_FLOW if option_type == 'C' else PUT_FLOW


def write_day(directory: Path) -> None:
    """One call chain and one put chain, each priced every minute after the
    entry with a quote, so both scripts build minute mids for them."""
    rows = []
    for chain in (CALL_CHAIN, PUT_CHAIN):
        for m in range(1, 6):
            rows.append(
                {
                    'executed_at': ENTRY + timedelta(minutes=m),
                    'option_chain_id': chain,
                    'price': 1.0 + 0.05 * m,
                    'canceled': False,
                    'nbbo_bid': 0.95 + 0.05 * m,
                    'nbbo_ask': 1.05 + 0.05 * m,
                    'size': 1,
                }
            )
    pd.DataFrame(rows).to_parquet(directory / f'{DAY}-trades.parquet')


def fires_frame(extra_days: tuple[str, ...] = ()) -> pd.DataFrame:
    """The lottery_finder_fires rows both scripts read: one call fire (id 1)
    and one put fire (id 2) on the same ticker and day, plus one call fire on
    each of `extra_days` (days the test gives no archive file)."""
    fires = [
        (1, CALL_CHAIN, 'C', date(2026, 7, 22)),
        (2, PUT_CHAIN, 'P', date(2026, 7, 22)),
    ]
    for i, day in enumerate(extra_days):
        chain = f'TSLA{day.replace("-", "")[2:]}C00300000'
        fires.append((10 + i, chain, 'C', date.fromisoformat(day)))
    rows = []
    for fire_id, chain, option_type, fire_date in fires:
        rows.append(
            {
                'id': fire_id,
                'date': fire_date,
                'option_chain_id': chain,
                'underlying_symbol': 'TSLA',
                'option_type': option_type,
                'trigger_time_ct': pd.Timestamp(ENTRY),
                'entry_price': Decimal('1.0000'),
                'mode': 'A_intraday_0DTE',
                'dte': 0,
                'score': 20,
                'flow_inv': 10.0,
            }
        )
    return pd.DataFrame(rows)


@pytest.fixture
def conn(monkeypatch: pytest.MonkeyPatch) -> FakeConn:
    """psycopg2.connect and pandas.read_sql faked for the test's duration."""
    fake = FakeConn()
    monkeypatch.setenv('DATABASE_URL', 'postgresql://test/none')
    monkeypatch.setattr('psycopg2.connect', lambda _url: fake)
    monkeypatch.setattr('pandas.read_sql', lambda *_args, **_kwargs: fires_frame())
    return fake


@pytest.fixture
def loader() -> FlowLoader:
    return FlowLoader()


@pytest.fixture(autouse=True)
def home_without_archives(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The tuning script used to read ~/Desktop/Bot-Eod-parquet. Point the home
    directory at an empty one, so a script that falls back to it finds nothing
    on any machine, including one that has that folder."""
    home = tmp_path / 'home'
    home.mkdir()
    monkeypatch.setattr(Path, 'home', staticmethod(lambda: home))


@pytest.fixture
def archive(tmp_path: Path) -> Path:
    """An empty Bot-EOD archive directory, under a name no default uses."""
    directory = tmp_path / 'my-archive'
    directory.mkdir()
    return directory


@pytest.fixture
def tune_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """tune.main() with an empty .env.local and its report kept under tmp_path;
    returns where the report would land."""
    env_file = tmp_path / '.env.local'
    env_file.write_text('', encoding='utf-8')
    monkeypatch.setattr(tune, 'ENV_FILE', env_file)
    monkeypatch.setattr(tune, 'ROOT', tmp_path)
    return tmp_path / 'docs' / 'tmp' / f'flow-inversion-tuning-{DAY}.md'


# ── tune_flow_inversion: --parquet-dir, as flow_inversion_timing takes it ──


def test_tune_parquet_dir_is_required(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        tune.parse_args([])
    assert exc.value.code == 2
    assert '--parquet-dir' in capsys.readouterr().err


def test_tune_missing_parquet_dir_fails_by_name(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    missing = tmp_path / 'Desktop' / 'Bot-Eod-parquet'
    with pytest.raises(SystemExit) as exc:
        tune.parse_args(['--parquet-dir', str(missing)])
    assert exc.value.code == 2
    err = capsys.readouterr().err
    assert '--parquet-dir' in err
    assert str(missing) in err


def test_tune_parquet_dir_parses_to_a_path(archive: Path) -> None:
    assert tune.parse_args(['--parquet-dir', str(archive)]).parquet_dir == archive


def test_tune_reads_each_ticker_and_side_through_the_loader(
    archive: Path, conn: FakeConn, loader: FlowLoader, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The day file exists only in the directory the caller names.
    write_day(archive)
    monkeypatch.setattr(tune, 'load_matched_flow', loader)

    inputs, days_read, missing = tune.build_fire_inputs(archive)

    assert (days_read, missing) == (1, [])
    # Once per (ticker, side), for the session date, on the script's connection.
    assert loader.calls == [(conn, DAY, 'TSLA', 'C'), (conn, DAY, 'TSLA', 'P')]
    # Each fire carries its own side's flow.
    flow_by_id = dict(zip(inputs['id'], inputs['flow'], strict=True))
    assert flow_by_id == {1: CALL_FLOW, 2: PUT_FLOW}
    # And the script sends no flow query of its own.
    assert conn.flow_sqls() == []


# ── tune_flow_inversion: a day with no archive file ──


def test_tune_skips_a_missing_day_by_name(
    archive: Path,
    conn: FakeConn,
    loader: FlowLoader,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(tune, 'load_matched_flow', loader)

    inputs, days_read, missing = tune.build_fire_inputs(archive)

    assert inputs.empty
    assert (days_read, missing) == (0, [DAY])
    assert loader.calls == []  # no file, so no flow is read for the day
    out, err = capsys.readouterr()
    line = (
        f'[load] SKIP {DAY}: archive file missing: '
        f'{archive / f"{DAY}-trades.parquet"} (2 fires not prepped)'
    )
    assert line in out
    assert line in err
    assert '0 day(s) read, 1 day(s) skipped for a missing archive' in out
    assert f'[load] skipped (archive missing): {DAY}' in err


def test_tune_with_no_archive_day_exits_0_and_writes_no_report(
    archive: Path,
    conn: FakeConn,
    tune_env: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    tune.main(['--parquet-dir', str(archive)])  # returns: exit 0

    out = capsys.readouterr().out
    assert 'no archive day to read' in out
    assert 'no report written' in out
    assert not tune_env.exists()


def test_tune_still_fails_when_days_were_read_but_nothing_prepped(
    archive: Path,
    conn: FakeConn,
    tune_env: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    # One day file exists but holds none of the fires' chains, and another day
    # has no file at all: a skipped day must not turn this into a clean exit.
    write_day(archive)
    other = fires_frame(extra_days=('2026-07-23',)).assign(
        option_chain_id='NVDA260722C00100000'
    )
    monkeypatch.setattr('pandas.read_sql', lambda *_args, **_kwargs: other)

    with pytest.raises(SystemExit, match='no fire-inputs prepared'):
        tune.main(['--parquet-dir', str(archive)])

    assert '1 day(s) read, 1 day(s) skipped for a missing archive' in capsys.readouterr().out
    assert not tune_env.exists()


def test_tune_report_names_the_days_it_skipped(
    archive: Path,
    conn: FakeConn,
    tune_env: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write_day(archive)
    with_gap = fires_frame(extra_days=('2026-07-23',))
    monkeypatch.setattr('pandas.read_sql', lambda *_args, **_kwargs: with_gap)

    tune.main(['--parquet-dir', str(archive)])

    report = tune_env.read_text(encoding='utf-8')
    assert '1 day(s) skipped (archive missing): 2026-07-23' in report


def test_timing_reads_each_ticker_and_side_through_the_loader(
    tmp_path: Path, conn: FakeConn, loader: FlowLoader, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = tmp_path / 'archive'
    archive.mkdir()
    write_day(archive)
    env_file = tmp_path / '.env.local'
    env_file.write_text('', encoding='utf-8')
    monkeypatch.setattr(timing, 'ENV_FILE', env_file)
    # The report lands under ROOT/docs/tmp: keep it out of the repo.
    monkeypatch.setattr(timing, 'ROOT', tmp_path)
    monkeypatch.setattr(timing, 'load_matched_flow', loader)
    simulated: list[tuple] = []

    def simulate(minutes, flow, entry_price, trigger_ts):
        simulated.append((flow, entry_price))
        return 10.0, trigger_ts + timedelta(minutes=10), 'inversion'

    monkeypatch.setattr(timing, 'simulate_flow_inversion', simulate)

    timing.main(['--parquet-dir', str(archive)])

    assert loader.calls == [(conn, DAY, 'TSLA', 'C'), (conn, DAY, 'TSLA', 'P')]
    # Fires run in id order: the call fire first, then the put fire.
    assert [flow for flow, _ in simulated] == [CALL_FLOW, PUT_FLOW]
    assert conn.flow_sqls() == []
    assert (tmp_path / 'docs' / 'tmp' / f'flow-inversion-timing-{DAY}.md').exists()
