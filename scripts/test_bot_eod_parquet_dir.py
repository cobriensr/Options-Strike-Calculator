"""Bot-EOD archive paths for backfill_net_flow_history.py,
exit_policy_search.py, flow_inversion_timing.py and ingest-flow.py.

The readers take the archive as `--parquet-dir` (no home-directory default;
the Makefile passes its PARQUET_DIR) and fail by name when it is missing.
The two `make update` reports skip a day whose file is missing, name it,
and exit 0 when no day had one. ingest-flow.py, the writer, takes
`--archive-dir`, defaulting to where it has always written. The enrich
scripts' tests are in test_enrich_missing_archive.py. Run:

    ml/.venv/Scripts/python -m pytest scripts/test_bot_eod_parquet_dir.py -q
"""

from __future__ import annotations

import importlib.util
import sys
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pandas as pd
import pytest

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import backfill_net_flow_history as net_flow  # noqa: E402
import exit_policy_search as policy_search  # noqa: E402
import flow_inversion_timing as timing  # noqa: E402


def _load_hyphenated(stem: str):
    """Import a script whose file name isn't a valid module name."""
    spec = importlib.util.spec_from_file_location(
        stem.replace('-', '_'), SCRIPTS / f'{stem}.py'
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ingest_flow = _load_hyphenated('ingest-flow')


def _touch(directory: Path, *names: str) -> None:
    for name in names:
        (directory / name).write_bytes(b'')


@pytest.fixture
def archive(tmp_path: Path) -> Path:
    directory = tmp_path / 'Bot-Eod-parquet'
    directory.mkdir()
    return directory


@pytest.fixture
def empty_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the .env.local loaders at an empty file and clear the
    variables it would provide."""
    env_file = tmp_path / '.env.local'
    env_file.write_text('')
    for module in (net_flow, timing, policy_search):
        monkeypatch.setattr(module, 'ENV_FILE', env_file)
    for name in ('DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'UW_API_KEY'):
        monkeypatch.delenv(name, raising=False)
    return env_file


# ── shared --parquet-dir contract ──────────────────────────────

READERS = [
    pytest.param(net_flow.parse_args, id='backfill_net_flow_history'),
    pytest.param(timing.parse_args, id='flow_inversion_timing'),
    pytest.param(policy_search.parse_args, id='exit_policy_search'),
]


@pytest.mark.parametrize(
    'parse_args',
    [
        pytest.param(timing.parse_args, id='flow_inversion_timing'),
        pytest.param(policy_search.parse_args, id='exit_policy_search'),
    ],
)
def test_update_reports_require_parquet_dir(
    parse_args, capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(SystemExit) as exc:
        parse_args([])
    assert exc.value.code == 2
    assert '--parquet-dir' in capsys.readouterr().err


@pytest.mark.parametrize('parse_args', READERS)
def test_missing_parquet_dir_fails_by_name(
    parse_args, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    missing = tmp_path / 'Desktop' / 'Bot-Eod-parquet'
    with pytest.raises(SystemExit) as exc:
        parse_args(['--parquet-dir', str(missing)])
    assert exc.value.code == 2
    err = capsys.readouterr().err
    assert '--parquet-dir' in err
    assert str(missing) in err


@pytest.mark.parametrize('parse_args', READERS)
def test_parquet_dir_parses_to_a_path(parse_args, archive: Path) -> None:
    assert parse_args(['--parquet-dir', str(archive)]).parquet_dir == archive


# ── backfill_net_flow_history ──────────────────────────────────


def test_net_flow_needs_a_date_or_a_parquet_dir(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as exc:
        net_flow.parse_args([])
    assert exc.value.code == 2
    err = capsys.readouterr().err
    assert '--date' in err
    assert '--parquet-dir' in err


def test_net_flow_date_alone_needs_no_archive() -> None:
    args = net_flow.parse_args(['--date', '2026-07-23'])
    assert args.date == '2026-07-23'
    assert args.parquet_dir is None


def test_net_flow_latest_date_comes_from_the_given_dir(archive: Path) -> None:
    _touch(
        archive,
        '2026-07-21-trades.parquet',
        '2026-07-22-trades.parquet',
        '2026-07-23-fulltape.parquet',  # other archive layout: ignored
    )
    assert net_flow.detect_latest_date(archive) == '2026-07-22'


def test_net_flow_empty_archive_fails_by_name(archive: Path) -> None:
    with pytest.raises(SystemExit) as exc:
        net_flow.detect_latest_date(archive)
    assert str(exc.value.code) == f'No *-trades.parquet files in {archive}'


def test_net_flow_main_dates_the_run_from_the_archive(
    archive: Path,
    empty_env: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _touch(archive, '2026-07-21-trades.parquet', '2026-07-22-trades.parquet')

    with pytest.raises(SystemExit, match='UW_API_KEY not set'):
        net_flow.main(['--parquet-dir', str(archive)])

    assert '[backfill-flow] target date: 2026-07-22' in capsys.readouterr().out


# ── flow_inversion_timing ──────────────────────────────────────


class _Cursor:
    """Answers latest_fire_date's MAX(date) and returns no flow rows."""

    def execute(self, _sql: str, _params: object = None) -> None:
        pass

    def fetchone(self) -> tuple:
        return (date(2026, 7, 24),)

    def fetchall(self) -> list:
        return []


class _Conn:
    def cursor(self) -> _Cursor:
        return _Cursor()


def _timing_fires(*days: str) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                'id': i + 1,
                'date': date.fromisoformat(day),
                'option_chain_id': f'TSLA{day.replace("-", "")[2:]}C00300000',
                'underlying_symbol': 'TSLA',
                'option_type': 'C',
                'trigger_time_ct': pd.Timestamp(f'{day}T15:00:00Z'),
                'entry_price': 1.0,
                'mode': 'A',
                'dte': 0,
                'score': 20,
                'flow_inv': 12.5,
            }
            for i, day in enumerate(days)
        ]
    )


@pytest.fixture
def timing_db(
    empty_env: Path, monkeypatch: pytest.MonkeyPatch
) -> pd.DataFrame:
    """Stand in for Neon at the psycopg2 / pandas boundary."""
    monkeypatch.setenv('DATABASE_URL', 'postgresql://test/none')
    monkeypatch.setattr(timing.psycopg2, 'connect', lambda _url: _Conn())
    fires = _timing_fires('2026-07-22', '2026-07-23', '2026-07-24')
    monkeypatch.setattr(timing.pd, 'read_sql', lambda _sql, _conn: fires)
    return fires


def _report_path() -> Path:
    return timing.ROOT / 'docs' / 'tmp' / 'flow-inversion-timing-2026-07-24.md'


def test_timing_skips_every_missing_day_by_name_and_exits_0(
    archive: Path,
    timing_db: pd.DataFrame,
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert not _report_path().exists()

    timing.main(['--parquet-dir', str(archive)])  # returns: exit 0

    out, err = capsys.readouterr()
    for day in ('2026-07-22', '2026-07-23', '2026-07-24'):
        line = (
            f'[timing] SKIP {day}: archive file missing: '
            f'{archive / f"{day}-trades.parquet"} (1 fires not timed)'
        )
        assert line in out
        assert line in err
    assert '0 day(s) read, 3 day(s) skipped for a missing archive' in out
    assert 'skipped (archive missing): 2026-07-22, 2026-07-23, 2026-07-24' in err
    assert 'no report written' in out
    assert not _report_path().exists()


def test_timing_still_fails_when_days_were_read_but_nothing_timed(
    archive: Path,
    timing_db: pd.DataFrame,
    capsys: pytest.CaptureFixture[str],
) -> None:
    # One readable day whose fire has no flow rows, so no inversion, plus
    # two days with no file.
    chain = timing_db.loc[timing_db['date'] == date(2026, 7, 23)].iloc[0]
    pd.DataFrame(
        {
            'executed_at': [
                datetime(2026, 7, 23, 15, m, tzinfo=UTC) for m in (0, 5, 10)
            ],
            'option_chain_id': [chain['option_chain_id']] * 3,
            'price': [1.0, 1.2, 0.9],
            'canceled': [False] * 3,
            'nbbo_bid': [0.95, 1.15, 0.85],
            'nbbo_ask': [1.05, 1.25, 0.95],
            'size': [10.0, 10.0, 10.0],
        }
    ).to_parquet(archive / '2026-07-23-trades.parquet')

    with pytest.raises(SystemExit, match='no inversion timings collected'):
        timing.main(['--parquet-dir', str(archive)])

    out = capsys.readouterr().out
    assert '1 day(s) read, 2 day(s) skipped for a missing archive' in out
    assert not _report_path().exists()


# ── ingest-flow ────────────────────────────────────────────────


def test_ingest_flow_archives_where_it_always_has_by_default() -> None:
    args = ingest_flow.parse_args(['2026-07-23'])
    assert args.archive_dir == Path.home() / 'Desktop' / 'Bot-Eod-parquet'
    assert args.input_dir == Path.home() / 'Downloads' / 'EOD-OptionFlow'


def test_ingest_flow_takes_the_input_and_archive_dirs(tmp_path: Path) -> None:
    csvs = tmp_path / 'EOD-OptionFlow'
    out = tmp_path / 'Bot-Eod-parquet'
    args = ingest_flow.parse_args(
        ['2026-07-23', '--input-dir', str(csvs), '--archive-dir', str(out)]
    )
    assert args.input_dir == csvs
    assert args.archive_dir == out
    assert ingest_flow.archive_parquet_path('2026-07-23', out) == (
        out / '2026-07-23-trades.parquet'
    )


def test_ingest_flow_names_the_csv_it_looked_for(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    csvs = tmp_path / 'EOD-OptionFlow'
    csvs.mkdir()

    rc = ingest_flow.main(['2026-07-23', '--input-dir', str(csvs), '--dry-run'])

    assert rc == 2
    expected = csvs / 'bot-eod-report-2026-07-23.csv'
    assert f'CSV not found: {expected}' in capsys.readouterr().err


# ── exit_policy_search ─────────────────────────────────────────


def _policy_fires(*days: str) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                'id': i + 1,
                'date': date.fromisoformat(day),
                'option_chain_id': f'TSLA{day.replace("-", "")[2:]}C00300000',
                'entry_time_ct': pd.Timestamp(f'{day}T15:00:00Z'),
                'entry_price': 1.0,
                'mode': 'A',
                'tod': 'morning',
                'score': 20,
                'peak': 60.0,
                'trail': 20.0,
                'hard30': 10.0,
                'tier50': 5.0,
                'eod': -30.0,
                'flow_inv': 12.5,
            }
            for i, day in enumerate(days)
        ]
    )


def _write_ticks(archive: Path, day: str, chain: str) -> None:
    """A day file whose fired chain trades every 10 minutes from 15:01Z."""
    pd.DataFrame(
        {
            'executed_at': [
                datetime(2026, 7, int(day[-2:]), 15 + m // 60, m % 60, tzinfo=UTC)
                for m in range(1, 200, 10)
            ],
            'option_chain_id': [chain] * 20,
            'price': [1.0 + 0.05 * k for k in range(10)]
            + [1.45 - 0.08 * k for k in range(10)],
            'canceled': [False] * 20,
        }
    ).to_parquet(archive / f'{day}-trades.parquet')


@pytest.fixture
def policy_db(
    tmp_path: Path, empty_env: Path, monkeypatch: pytest.MonkeyPatch
) -> pd.DataFrame:
    """Neon faked at the psycopg2 / pandas boundary; ROOT moved to tmp so
    the docs/tmp report lands there."""
    monkeypatch.setenv('DATABASE_URL', 'postgresql://test/none')
    monkeypatch.setattr(policy_search.psycopg2, 'connect', lambda _url: _Conn())
    monkeypatch.setattr(policy_search, 'ROOT', tmp_path)
    fires = _policy_fires('2026-07-22', '2026-07-23', '2026-07-24')
    monkeypatch.setattr(policy_search.pd, 'read_sql', lambda _sql, _conn: fires)
    return fires


def _policy_report(root: Path) -> Path:
    return root / 'docs' / 'tmp' / 'lottery-exit-policy-search-2026-07-24.md'


def test_policy_search_skips_every_missing_day_and_exits_0(
    tmp_path: Path,
    archive: Path,
    policy_db: pd.DataFrame,
    capsys: pytest.CaptureFixture[str],
) -> None:
    policy_search.main(['--parquet-dir', str(archive)])  # returns: exit 0

    out, err = capsys.readouterr()
    for day in ('2026-07-22', '2026-07-23', '2026-07-24'):
        line = (
            f'[search] SKIP {day}: archive file missing: '
            f'{archive / f"{day}-trades.parquet"} (1 fires not searched)'
        )
        assert line in out
        assert line in err
    assert '0 day(s) read, 3 day(s) skipped for a missing archive' in out
    assert 'no archive day to read — no report written' in out
    assert not _policy_report(tmp_path).exists()


def test_policy_search_reports_the_days_it_read_and_names_the_skipped(
    tmp_path: Path,
    archive: Path,
    policy_db: pd.DataFrame,
    capsys: pytest.CaptureFixture[str],
) -> None:
    for day in ('2026-07-23', '2026-07-24'):
        chain = policy_db.loc[
            policy_db['date'] == date.fromisoformat(day), 'option_chain_id'
        ].iloc[0]
        _write_ticks(archive, day, chain)

    policy_search.main(['--parquet-dir', str(archive)])

    out = capsys.readouterr().out
    assert '2 day(s) read, 1 day(s) skipped for a missing archive' in out
    report = _policy_report(tmp_path).read_text(encoding='utf-8')
    assert '1 day(s) skipped (archive missing): 2026-07-22.' in report
    assert '## Aggregate comparison (all fires)' in report
    assert 'trail 50/15' in report


def test_policy_search_fails_by_name_when_read_days_yield_nothing(
    tmp_path: Path, archive: Path, policy_db: pd.DataFrame
) -> None:
    # A file for every day, but none holds a fired chain.
    for day in ('2026-07-22', '2026-07-23', '2026-07-24'):
        _write_ticks(archive, day, 'SPY260723C00600000')

    with pytest.raises(SystemExit, match='no fire produced a policy row'):
        policy_search.main(['--parquet-dir', str(archive)])
    assert not _policy_report(tmp_path).exists()


# ── flow_inversion_timing: report header ───────────────────────


class _FlowCursor(_Cursor):
    """Net-call flow that climbs for 40 minutes, then sells off: one
    clear inversion after the 15:00Z trigger."""

    def fetchall(self) -> list:
        start = datetime(2026, 7, 23, 15, 1, tzinfo=UTC)
        return [
            (start + timedelta(minutes=m), 100.0 if m < 40 else -100.0)
            for m in range(90)
        ]


class _FlowConn:
    def cursor(self) -> _FlowCursor:
        return _FlowCursor()


def test_timing_report_names_the_skipped_days(
    tmp_path: Path,
    archive: Path,
    timing_db: pd.DataFrame,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(timing.psycopg2, 'connect', lambda _url: _FlowConn())
    monkeypatch.setattr(timing, 'ROOT', tmp_path)
    chain = timing_db.loc[timing_db['date'] == date(2026, 7, 23)].iloc[0]
    minutes = range(0, 120)
    pd.DataFrame(
        {
            'executed_at': [
                datetime(2026, 7, 23, 15, 0, tzinfo=UTC) + timedelta(minutes=m)
                for m in minutes
            ],
            'option_chain_id': [chain['option_chain_id']] * len(minutes),
            'price': [1.0 + 0.01 * m for m in minutes],
            'canceled': [False] * len(minutes),
            'nbbo_bid': [0.95 + 0.01 * m for m in minutes],
            'nbbo_ask': [1.05 + 0.01 * m for m in minutes],
            'size': [10.0] * len(minutes),
        }
    ).to_parquet(archive / '2026-07-23-trades.parquet')

    timing.main(['--parquet-dir', str(archive)])

    out = capsys.readouterr().out
    assert '1 day(s) read, 2 day(s) skipped for a missing archive' in out
    report = (
        tmp_path / 'docs' / 'tmp' / 'flow-inversion-timing-2026-07-24.md'
    ).read_text(encoding='utf-8')
    assert '2 day(s) skipped (archive missing): 2026-07-22, 2026-07-24.' in report
