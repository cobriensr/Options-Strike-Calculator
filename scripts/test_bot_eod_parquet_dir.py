"""Bot-EOD archive paths for backfill_net_flow_history.py,
exit_policy_search.py, flow_inversion_timing.py, tune_flow_inversion.py and
ingest-flow.py.

The readers take the archive as `--parquet-dir` (no home-directory default;
the Makefile passes its PARQUET_DIR) and fail by name when it is missing.
The two `make update` reports skip a day whose file is missing, name it,
and exit 0 when no day had one. (They also take `--derived-dir`, the per-day
derived files: test_policy_timing_derive.py.) ingest-flow.py, the writer, takes
`--archive-dir`, defaulting to where it has always written. The Makefile's
retired net-flow backfill and its R2 tape targets are checked at the end. The
enrich scripts' tests are in test_enrich_missing_archive.py. Run:

    ml/.venv/Scripts/python -m pytest scripts/test_bot_eod_parquet_dir.py -q
"""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pandas as pd
import pytest

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import _report_weights as report_weights  # noqa: E402
import backfill_net_flow_history as net_flow  # noqa: E402
import exit_policy_search as policy_search  # noqa: E402
import flow_inversion_timing as timing  # noqa: E402
import tune_flow_inversion as tuning  # noqa: E402


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
    pytest.param(tuning.parse_args, id='tune_flow_inversion'),
]


def test_tune_requires_parquet_dir(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        tuning.parse_args([])
    assert exc.value.code == 2
    assert '--parquet-dir' in capsys.readouterr().err


@pytest.mark.parametrize(
    'parse_args',
    [
        pytest.param(timing.parse_args, id='flow_inversion_timing'),
        pytest.param(policy_search.parse_args, id='exit_policy_search'),
    ],
)
def test_update_reports_require_one_source(
    parse_args, capsys: pytest.CaptureFixture[str]
) -> None:
    """These two read the tape or per-day derived files: one source is
    required, and the group message names both flags."""
    with pytest.raises(SystemExit) as exc:
        parse_args([])
    assert exc.value.code == 2
    err = capsys.readouterr().err
    assert '--parquet-dir' in err
    assert '--derived-dir' in err


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
                'round_trip_score_deduct': 0,
                'direction_gated': False,
                'inversion_quintile': 3,
            }
            for i, day in enumerate(days)
        ]
    )


# The active weights both reports tier by (owner ruling, 2026-11-19): the
# pointer read is faked at the module boundary, so no test reaches a database.
ACTIVE_WEIGHTS = (
    'v-test',
    {'feed_cutoffs': {'tier1_min_score': 16, 'tier2_min_score': 12}},
)


@pytest.fixture
def timing_db(
    empty_env: Path, monkeypatch: pytest.MonkeyPatch
) -> pd.DataFrame:
    """Stand in for Neon at the psycopg2 / pandas boundary."""
    monkeypatch.setenv('DATABASE_URL', 'postgresql://test/none')
    monkeypatch.setattr(timing.psycopg2, 'connect', lambda _url: _Conn())
    monkeypatch.setattr(report_weights, 'load_pointer', lambda _conn, _name: ACTIVE_WEIGHTS)
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

    rc = ingest_flow.main(['2026-07-23', '--input-dir', str(csvs)])

    assert rc == 2
    expected = csvs / 'bot-eod-report-2026-07-23.csv'
    assert f'CSV not found: {expected}' in capsys.readouterr().err


# ── Makefile: the retired steps and the tape targets ───────────

MAKEFILE = SCRIPTS.parent / 'Makefile'
TAPE_TARGETS = ('analyze', 'analyze-one', 'dry-run')
R2_VARS = (
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_ENDPOINT_URL',
    'R2_BUCKET_FULLTAPE',
)


def _makefile_text() -> str:
    return MAKEFILE.read_text(encoding='utf-8')


def _rule(text: str, name: str) -> tuple[list[str], list[str]]:
    """The prerequisites and the recipe lines of the first `name:` rule."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.startswith(f'{name}:'):
            recipe: list[str] = []
            for body in lines[i + 1 :]:
                if not body.startswith('\t'):
                    break
                recipe.append(body)
            return line.split(':', 1)[1].split(), recipe
    raise AssertionError(f'no `{name}:` rule in the Makefile')


def test_makefile_drops_backfill_flow_and_reads_the_tape() -> None:
    text = _makefile_text()
    assert 'backfill_net_flow_history' not in text
    assert 'backfill-flow' not in text
    assert '13 visualizations' not in text  # whale_plots writes 14 now
    for name in TAPE_TARGETS:
        _, recipe = _rule(text, name)
        day_lines = [line for line in recipe if 'analyze.py --day' in line]
        assert day_lines, f'{name} no longer runs analyze.py --day'
        for line in day_lines:
            assert line.rstrip().endswith(' --r2'), line
            assert 'source $(ENV_FILE)' in line, line


def test_makefile_never_passes_ingest_flow_a_retired_flag() -> None:
    # Join `\`-continued recipe lines so a flag on the second line is seen.
    logical = _makefile_text().replace('\\\n', ' ').splitlines()
    ingest = [
        line
        for line in logical
        if 'scripts/ingest-flow.py' in line and not line.lstrip('\t @').startswith('#')
    ]
    assert len(ingest) == 2, 'expected ingest and dry-run to run ingest-flow.py'
    for line in ingest:
        assert '--dry-run' not in line, line
        assert '--skip-archive' not in line, line
    # dry-run keeps the CSV; the real ingest is the one that deletes it.
    dry_run = _rule(_makefile_text(), 'dry-run')[1]
    assert any(
        'ingest-flow.py' in line and '--keep-csv' in line
        for line in '\n'.join(dry_run).replace('\\\n', ' ').splitlines()
    )


def test_tape_targets_gate_on_the_env_and_not_the_csv() -> None:
    text = _makefile_text()
    for name in TAPE_TARGETS:
        prerequisites, _ = _rule(text, name)
        assert prerequisites == ['check-r2-env'], name
    assert _rule(text, 'ingest')[0] == ['check']
    _, check_recipe = _rule(text, 'check')
    assert 'BLOB_READ_WRITE_TOKEN' not in '\n'.join(check_recipe)


def _check_r2_env(
    tmp_path: Path, env_lines: list[str] | None, *args: str
) -> subprocess.CompletedProcess[str]:
    """Run `make check-r2-env` against a throwaway env file (None: no file)
    and an empty CSV dir, so no real file or pending date is read."""
    env_file = tmp_path / '.env.local'
    if env_lines is not None:
        env_file.write_text('\n'.join(env_lines) + '\n')
    csvs = tmp_path / 'EOD-OptionFlow'
    csvs.mkdir(exist_ok=True)
    return subprocess.run(
        [
            'make',
            '--no-print-directory',
            'check-r2-env',
            f'ENV_FILE={env_file.as_posix()}',
            f'INPUT_DIR={csvs.as_posix()}',
            *args,
        ],
        cwd=SCRIPTS.parent,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


def _r2_env_lines(skip: str | None = None) -> list[str]:
    return [f'{name}=sentinel-{name}' for name in R2_VARS if name != skip]


needs_make = pytest.mark.skipif(
    shutil.which('make') is None, reason='GNU make is not installed'
)


@needs_make
def test_check_r2_env_passes_and_prints_no_value(tmp_path: Path) -> None:
    done = _check_r2_env(tmp_path, _r2_env_lines(), 'DATE=2026-11-04')

    assert done.returncode == 0, done.stderr
    assert 'sentinel-' not in done.stdout + done.stderr


@needs_make
@pytest.mark.parametrize('missing', R2_VARS)
def test_check_r2_env_names_the_missing_var_and_prints_no_value(
    tmp_path: Path, missing: str
) -> None:
    done = _check_r2_env(tmp_path, _r2_env_lines(skip=missing), 'DATE=2026-11-04')

    assert done.returncode == 2
    assert missing in done.stdout + done.stderr
    assert 'sentinel-' not in done.stdout + done.stderr


@needs_make
def test_check_r2_env_names_a_missing_env_file(tmp_path: Path) -> None:
    done = _check_r2_env(tmp_path, None, 'DATE=2026-11-04')

    assert done.returncode == 2
    # The gate's own message, not bash's "No such file" from sourcing it.
    missing_file = (tmp_path / '.env.local').as_posix()
    assert f'{missing_file} not found' in done.stdout + done.stderr


@needs_make
def test_check_r2_env_needs_a_date(tmp_path: Path) -> None:
    """With no pending CSV there is no default DATE to read the tape for."""
    done = _check_r2_env(tmp_path, _r2_env_lines())

    assert done.returncode == 2
    assert 'DATE' in done.stdout + done.stderr
    assert 'sentinel-' not in done.stdout + done.stderr


# ── exit_policy_search ─────────────────────────────────────────


def _policy_fires(*days: str) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                'id': i + 1,
                'date': date.fromisoformat(day),
                'option_chain_id': f'TSLA{day.replace("-", "")[2:]}C00300000',
                'underlying_symbol': 'TSLA',
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
                'round_trip_score_deduct': 0,
                'direction_gated': False,
                'inversion_quintile': 3,
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
    monkeypatch.setattr(report_weights, 'load_pointer', lambda _conn, _name: ACTIVE_WEIGHTS)
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
