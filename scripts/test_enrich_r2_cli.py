"""The R2 source of enrich_lottery_outcomes.py and enrich_silent_boom_outcomes.py:
`--r2` (read the Full Tape lake day by day), `--select` and `--dry-run`.

- `--parquet-dir DIR | --r2` is one required, mutually exclusive choice.
- `--r2` builds a TapeReader on a fresh temp directory, points the loaders at
  it as the Full Tape, and per day does fetch_day, enrich_one_date, release.
  The reader is closed and the directory removed however the run ends.
- A TapeReadError (from_env, landed_days, fetch_day) ends the run with a
  non-zero exit and a message that holds a key, a count or a variable name,
  never a value.
- A dry run writes nothing at all, the lottery's ticker-quality refit included.

`_tape_reader.TapeReader` is replaced at the module boundary by a fake whose
fetch_day copies a fixture parquet into the cache directory. Neon is faked at
the psycopg2 boundary with test_enrich_provenance.py's FakeDb. Run:

    ml/.venv/Scripts/python -m pytest -q scripts/test_enrich_r2_cli.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from types import ModuleType

import psycopg2
import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

import _tape_reader  # noqa: E402
import enrich_lottery_outcomes as lottery  # noqa: E402
import enrich_silent_boom_outcomes as silent_boom  # noqa: E402
import test_enrich_provenance as prov  # noqa: E402

D1, D2, D3, D4 = date(2026, 7, 22), date(2026, 7, 23), date(2026, 7, 24), date(2026, 7, 25)


@dataclass(frozen=True)
class Script:
    module: ModuleType
    row: Callable[..., tuple]  # a fetched fire / alert row
    prefix: str  # the script's log prefix


LOTTERY = Script(lottery, prov.fire_row, '[enrich]')
SILENT_BOOM = Script(silent_boom, prov.alert_row, '[enrich-silent-boom]')
SCRIPTS = [pytest.param(LOTTERY, id='lottery'), pytest.param(SILENT_BOOM, id='silent-boom')]
PARSERS = [
    pytest.param(lottery.parse_args, id='lottery'),
    pytest.param(silent_boom.parse_args, id='silent-boom'),
]


# ── the fake lake ──────────────────────────────────────────────


@dataclass
class Lake:
    """What the fake R2 holds, and what the run did to its reader."""

    tape: Path  # one fixture day, copied for every fetch
    landed: set[date] = field(default_factory=set)
    missing: set[date] = field(default_factory=set)  # listed, but the GET finds no object
    fetch_errors: dict[date, Exception] = field(default_factory=dict)
    landed_error: Exception | None = None
    calls: list[tuple] = field(default_factory=list)
    cached_at_fetch: list[list[str]] = field(default_factory=list)
    cache_dirs: list[Path] = field(default_factory=list)
    bucket_seen: list[str | None] = field(default_factory=list)

    def fetched(self) -> list[date]:
        return [call[1] for call in self.calls if call[0] == 'fetch']


class FakeReader:
    """The TapeReader surface the scripts use: cache_dir, landed_days, fetch_day,
    release and close."""

    def __init__(self, lake: Lake, cache_dir: Path) -> None:
        self._lake = lake
        self._cache_dir = cache_dir

    @property
    def cache_dir(self) -> Path:
        return self._cache_dir

    def _path(self, day: date) -> Path:
        return self._cache_dir / f'{day.isoformat()}-fulltape.parquet'

    def landed_days(self) -> set[date]:
        self._lake.calls.append(('landed_days',))
        if self._lake.landed_error is not None:
            raise self._lake.landed_error
        return set(self._lake.landed)

    def fetch_day(self, day: date, deadline: float | None = None) -> Path | None:
        self._lake.calls.append(('fetch', day))
        self._lake.cached_at_fetch.append(sorted(p.name for p in self._cache_dir.glob('*.parquet')))
        if day in self._lake.fetch_errors:
            raise self._lake.fetch_errors[day]
        if day in self._lake.missing:
            return None
        shutil.copyfile(self._lake.tape, self._path(day))
        return self._path(day)

    def release(self, day: date) -> None:
        self._lake.calls.append(('release', day))
        self._path(day).unlink(missing_ok=True)

    def close(self) -> None:
        self._lake.calls.append(('close',))
        for leftover in self._cache_dir.glob('*.parquet'):
            leftover.unlink()


class FakeTapeReader:
    """Stands in for the TapeReader class: from_env is the only constructor main uses."""

    def __init__(self, lake: Lake) -> None:
        self._lake = lake

    def from_env(self, cache_dir: Path) -> FakeReader:
        self._lake.bucket_seen.append(os.environ.get('R2_BUCKET_FULLTAPE'))
        self._lake.cache_dirs.append(Path(cache_dir))
        return FakeReader(self._lake, Path(cache_dir))


@pytest.fixture
def lake(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Lake:
    """The scripts import TapeReader from _tape_reader inside main, so patching
    the attribute on that module is the boundary."""
    fixture_dir = tmp_path / 'fixture-tape'
    fixture_dir.mkdir()
    fake = Lake(tape=prov.write_tape(fixture_dir, 'fulltape'))
    monkeypatch.setattr(_tape_reader, 'TapeReader', FakeTapeReader(fake))
    return fake


@pytest.fixture
def cli_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """No .env.local, a fake DATABASE_URL, the cwd and the temp dir under tmp_path,
    and the archive globals restored after the test (main rebinds them).
    Returns the temp directory the reader's cache is made in."""
    env_file = tmp_path / 'absent.env.local'
    for module in (lottery, silent_boom):
        monkeypatch.setattr(module, 'ENV_FILE', env_file)
        monkeypatch.setattr(module, 'PARQUET_DIR', None)
        monkeypatch.setattr(module, 'PARQUET_FILE_PATTERN', module.PARQUET_FORMATS['trades'])
        monkeypatch.setattr(module, 'SOURCE_TAG', module.ARCHIVE_SOURCES['trades'])
    monkeypatch.setenv('DATABASE_URL', 'postgresql://test/none')
    monkeypatch.delenv('DATABASE_URL_UNPOOLED', raising=False)
    scratch = tmp_path / 'scratch'
    scratch.mkdir()
    monkeypatch.setattr(tempfile, 'tempdir', str(scratch))
    monkeypatch.chdir(tmp_path)
    return scratch


@pytest.fixture
def serve(monkeypatch: pytest.MonkeyPatch) -> Callable[..., prov.FakeDb]:
    def install(script: Script, **db_kwargs) -> prov.FakeDb:
        db = prov.FakeDb(**db_kwargs)
        monkeypatch.setattr(script.module, 'connect_with_retry', lambda _url: db)
        monkeypatch.setattr(script.module, 'execute_values', db.execute_values)
        return db

    return install


def iso(*days: date) -> list[str]:
    return [d.isoformat() for d in days]


def two_fires(script: Script) -> list[tuple]:
    """One priced fire and one whose chain is not in the tape."""
    return [script.row(1, prov.TSLA), script.row(2, prov.NVDA)]


def write_statements(db: prov.FakeDb) -> list[str]:
    return [
        sql
        for sql, _ in db.executed
        if sql.lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE'))
    ]


# ── the source: --parquet-dir | --r2 ───────────────────────────


@pytest.mark.parametrize('parse_args', PARSERS)
def test_source_is_required_and_exclusive(
    parse_args, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(SystemExit) as exc:
        parse_args(['--date', '2026-07-23'])
    assert exc.value.code == 2
    err = capsys.readouterr().err
    assert 'one of the arguments --parquet-dir --r2 is required' in err

    with pytest.raises(SystemExit) as exc:
        parse_args(['--parquet-dir', str(tmp_path), '--r2'])
    assert exc.value.code == 2
    assert 'argument --r2: not allowed with argument --parquet-dir' in capsys.readouterr().err


@pytest.mark.parametrize('parse_args', PARSERS)
def test_select_and_dry_run_parse(parse_args) -> None:
    args = parse_args(['--r2'])
    assert (args.r2, args.select, args.dry_run) == (True, 'pending', False)
    args = parse_args(['--r2', '--select', 'all', '--dry-run'])
    assert (args.select, args.dry_run) == ('all', True)


@pytest.mark.parametrize('parse_args', PARSERS)
def test_an_unknown_select_is_a_usage_error(parse_args, capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        parse_args(['--r2', '--select', 'everything'])
    assert exc.value.code == 2
    assert '--select' in capsys.readouterr().err


def test_lottery_parquet_format_follows_the_source(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # --parquet-dir keeps its default (trades); --r2 is the Full Tape.
    assert lottery.parse_args(['--parquet-dir', str(tmp_path)]).parquet_format == 'trades'
    fulltape = ['--parquet-dir', str(tmp_path), '--parquet-format', 'fulltape']
    assert lottery.parse_args(fulltape).parquet_format == 'fulltape'
    assert lottery.parse_args(['--r2']).parquet_format == 'fulltape'
    assert lottery.parse_args(['--r2', '--parquet-format', 'fulltape']).parquet_format == 'fulltape'

    with pytest.raises(SystemExit) as exc:
        lottery.parse_args(['--r2', '--parquet-format', 'trades'])
    assert exc.value.code == 2
    err = capsys.readouterr().err
    assert '--parquet-format' in err and '--r2' in err


def test_sb_backfill_mode_and_select_are_exclusive(capsys: pytest.CaptureFixture[str]) -> None:
    for select in ('empty', 'all'):
        with pytest.raises(SystemExit) as exc:
            silent_boom.parse_args(['--r2', '--backfill-mode', '--select', select])
        assert exc.value.code == 2
        err = capsys.readouterr().err
        assert '--select' in err and '--backfill-mode' in err

    # 'pending' is what backfill mode is, so that pair is fine.
    args = silent_boom.parse_args(['--r2', '--backfill-mode', '--select', 'pending'])
    assert (args.backfill_mode, args.select) == (True, 'pending')
    assert silent_boom.parse_args(['--r2', '--select', 'all']).select == 'all'


def test_importing_the_scripts_does_not_load_the_reader() -> None:
    # A fresh interpreter: this process has already imported _tape_reader above.
    code = (
        'import sys\n'
        f'sys.path.insert(0, {str(SCRIPTS_DIR)!r})\n'
        'import enrich_lottery_outcomes, enrich_silent_boom_outcomes\n'
        "loaded = [m for m in ('_tape_reader', 'boto3', 'botocore') if m in sys.modules]\n"
        'assert not loaded, loaded\n'
    )
    done = subprocess.run(
        [sys.executable, '-c', code], capture_output=True, text=True, timeout=180, check=False
    )
    assert done.returncode == 0, done.stderr


# ── --r2: one day at a time ────────────────────────────────────


@pytest.mark.parametrize('script', SCRIPTS)
def test_r2_mode_fetches_each_day_and_releases_it(
    script: Script, lake: Lake, cli_env: Path, serve
) -> None:
    lake.landed = {D1, D2}
    db = serve(script, fires=two_fires(script), work_dates=iso(D1, D2))

    script.module.main(['--r2', '--all-unenriched'])

    # One day on disk at a time: each fetch finds the cache empty.
    assert lake.calls == [
        ('landed_days',),
        ('fetch', D1),
        ('release', D1),
        ('fetch', D2),
        ('release', D2),
        ('close',),
    ]
    assert lake.cached_at_fetch == [[], []]
    # The days were read for real (a missing file would have been a skip), as the Full Tape.
    assert [w.rows[0][-2:] for w in db.values_writes if w.rows] == [('fulltape', 1)] * 2
    stamps = [params for _, params in db.outcome_stamps()]
    assert stamps == [('fulltape', 1, 1, 1, [2])] * 2
    # The reader works in a fresh temp directory that does not outlive the run.
    (cache_dir,) = lake.cache_dirs
    assert cache_dir.name.startswith('enrich-')
    assert cache_dir.parent == cli_env
    assert not cache_dir.exists()
    assert script.module.PARQUET_DIR == cache_dir
    assert script.module.SOURCE_TAG == 'fulltape'
    assert script.module.PARQUET_FILE_PATTERN == '{date}-fulltape.parquet'


@pytest.mark.parametrize('script', SCRIPTS)
def test_r2_day_missing_is_a_skip(
    script: Script,
    lake: Lake,
    cli_env: Path,
    serve,
    capsys: pytest.CaptureFixture[str],
) -> None:
    # Listed, but the object is gone by the GET: fetch_day returns None.
    lake.landed = {D1, D2, D3}
    lake.missing = {D2}
    db = serve(script, fires=two_fires(script), work_dates=iso(D1, D2, D3))

    script.module.main(['--r2', '--all-unenriched'])  # returns: exit 0

    assert lake.calls[-1] == ('close',)
    assert lake.fetched() == [D1, D2, D3]
    # D1 and D3 wrote their one values statement each; D2 wrote nothing.
    assert len(db.values_writes) == 2
    assert len(db.outcome_stamps()) == 2
    out, err = capsys.readouterr()
    skip = f'{script.prefix} SKIP {D2}: archive file missing: '
    assert skip in out
    assert skip in err
    assert '1 day(s) skipped for a missing archive' in out


@pytest.mark.parametrize('script', SCRIPTS)
def test_r2_every_day_missing_writes_nothing(script: Script, lake: Lake, cli_env: Path, serve) -> None:
    lake.landed = {D1}
    lake.missing = {D1}
    db = serve(script, fires=two_fires(script), work_dates=iso(D1))

    script.module.main(['--r2', '--all-unenriched'])

    assert db.values_writes == []
    assert write_statements(db) == []
    assert db.commits == 0


@pytest.mark.parametrize('script', SCRIPTS)
def test_r2_all_unenriched_skips_days_the_lake_does_not_hold(
    script: Script,
    lake: Lake,
    cli_env: Path,
    serve,
    capsys: pytest.CaptureFixture[str],
) -> None:
    lake.landed = {D1, D3}
    serve(script, fires=two_fires(script), work_dates=iso(D1, D2, D3, D4))

    script.module.main(['--r2', '--all-unenriched'])

    # Never fetched, and named once, dates only, on stdout and stderr.
    assert lake.fetched() == [D1, D3]
    out, err = capsys.readouterr()
    noun = 'fires' if script is LOTTERY else 'alerts'
    line = f'{script.prefix} skipped (not landed in R2, {noun} left unenriched): {D2}, {D4}'
    assert line in out
    assert line in err


def test_r2_latest_date_comes_from_the_lake(
    lake: Lake, cli_env: Path, serve, capsys: pytest.CaptureFixture[str]
) -> None:
    lake.landed = {D1, D3, D2}
    serve(LOTTERY, fires=two_fires(LOTTERY))

    lottery.main(['--r2'])

    assert lake.fetched() == [D3]
    assert f'[enrich] target date: {D3}' in capsys.readouterr().out


def test_r2_explicit_date_does_not_list_the_lake(lake: Lake, cli_env: Path, serve) -> None:
    lake.landed = {D1, D2}
    serve(LOTTERY, fires=two_fires(LOTTERY))

    lottery.main(['--r2', '--date', D1.isoformat()])

    assert ('landed_days',) not in lake.calls
    assert lake.fetched() == [D1]


def test_r2_nothing_pending_reports_the_newest_landed_day_and_still_refits(
    lake: Lake,
    cli_env: Path,
    serve,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    lake.landed = {D1, D3}
    db = serve(LOTTERY, work_dates=[])

    lottery.main(['--r2', '--all-unenriched'])

    assert lake.fetched() == []
    assert f'0 dates pending (latest landed day: {D3})' in capsys.readouterr().out
    # The global refit still runs for `make enrich`, and names its CSV for that day.
    assert any('GROUP BY underlying_symbol' in sql for sql, _ in db.executed)
    assert (tmp_path / 'docs' / 'tmp' / f'lottery-quality-sim-{D3}.csv').exists()


def test_r2_with_an_empty_lake_and_no_date_exits(lake: Lake, cli_env: Path, serve) -> None:
    serve(LOTTERY)

    with pytest.raises(SystemExit) as exc:
        lottery.main(['--r2'])

    assert 'No landed Full Tape days' in str(exc.value.code)
    assert lake.calls[-1] == ('close',)
    assert lake.cache_dirs and not lake.cache_dirs[0].exists()


@pytest.mark.parametrize('script', SCRIPTS)
def test_r2_all_unenriched_overrides_date(script: Script, lake: Lake, cli_env: Path, serve) -> None:
    # As with --parquet-dir: the work list wins over --date.
    lake.landed = {D1, D2, D3}
    serve(script, fires=two_fires(script), work_dates=iso(D2, D3))

    script.module.main(['--r2', '--all-unenriched', '--date', D1.isoformat()])

    assert lake.fetched() == [D2, D3]


def test_sb_r2_range_filters_the_landed_days(
    lake: Lake, cli_env: Path, serve, capsys: pytest.CaptureFixture[str]
) -> None:
    lake.landed = {D1, D2, D3, D4}
    serve(SILENT_BOOM, fires=two_fires(SILENT_BOOM), work_dates=iso(D1, D2, D3, D4))

    silent_boom.main(['--r2', '--from-date', D2.isoformat(), '--to-date', D3.isoformat()])

    assert lake.fetched() == [D2, D3]
    assert '[enrich-silent-boom] 2 dates (mode=standard, scope=lake-list)' in capsys.readouterr().out


def test_sb_r2_range_does_not_download_a_landed_day_with_nothing_to_do(
    lake: Lake, cli_env: Path, serve
) -> None:
    # The lake holds every day since the tape began; only days with alerts to
    # enrich are worth a download.
    lake.landed = {D1, D2, D3, D4}
    serve(SILENT_BOOM, fires=two_fires(SILENT_BOOM), work_dates=iso(D1, D2, D4))

    silent_boom.main(['--r2'])

    assert lake.fetched() == [D1, D2, D4]


def test_sb_r2_explicit_date_is_fetched_as_asked(lake: Lake, cli_env: Path, serve) -> None:
    lake.landed = {D1}
    serve(SILENT_BOOM, fires=two_fires(SILENT_BOOM))

    silent_boom.main(['--r2', '--date', D1.isoformat()])

    assert ('landed_days',) not in lake.calls
    assert lake.fetched() == [D1]


# ── --select and --dry-run reach enrich_one_date ───────────────


@pytest.mark.parametrize('script', SCRIPTS)
def test_select_and_dry_run_reach_enrich_one_date(
    script: Script, lake: Lake, cli_env: Path, serve
) -> None:
    lake.landed = {D1}
    db = serve(script, fires=two_fires(script), work_dates=iso(D1))

    script.module.main(['--r2', '--all-unenriched', '--select', 'all', '--dry-run'])

    # --select picked the dates (list_work_dates) and the fires (the tape's gate) ...
    dates_sql = next(sql for sql, _ in db.executed if sql.startswith('SELECT DISTINCT date::text'))
    assert f'WHERE {prov.ALL_TAPE}' in dates_sql
    fetch_sql = next(sql for sql, _ in db.executed if 'WHERE date = %s AND' in sql)
    assert f'WHERE date = %s AND {prov.ALL_TAPE} ORDER BY' in fetch_sql
    # ... and --dry-run kept every write away from the database.
    assert db.values_writes == []
    assert write_statements(db) == []
    assert db.commits == 0
    assert lake.calls[-1] == ('close',)


@pytest.mark.parametrize('select', ['pending', 'empty'])
@pytest.mark.parametrize('script', SCRIPTS)
def test_select_defaults_and_narrower_choices(
    script: Script, select: str, lake: Lake, cli_env: Path, serve
) -> None:
    lake.landed = {D1}
    db = serve(script, fires=two_fires(script), work_dates=iso(D1))

    script.module.main(['--r2', '--all-unenriched', '--select', select])

    dates_sql = next(sql for sql, _ in db.executed if sql.startswith('SELECT DISTINCT date::text'))
    assert f'WHERE {prov.PREDICATES[select]}' in dates_sql
    fetch_sql = next(sql for sql, _ in db.executed if 'WHERE date = %s AND' in sql)
    assert f'WHERE date = %s AND {prov.PREDICATES[select]} ORDER BY' in fetch_sql


@pytest.mark.parametrize('script', SCRIPTS)
def test_parquet_dir_mode_takes_select_and_dry_run_too(
    script: Script, cli_env: Path, serve, tmp_path: Path
) -> None:
    archive = tmp_path / 'archive'
    archive.mkdir()
    prov.write_tape(archive, 'trades')
    db = serve(script, fires=two_fires(script), work_dates=iso(D1))

    script.module.main(
        ['--parquet-dir', str(archive), '--all-unenriched', '--select', 'empty', '--dry-run']
    )

    dates_sql = next(sql for sql, _ in db.executed if sql.startswith('SELECT DISTINCT date::text'))
    assert f'WHERE {prov.EMPTY}' in dates_sql
    assert db.values_writes == []
    assert write_statements(db) == []


# ── a dry run writes nothing, and says "would" ─────────────────


def test_lottery_dry_run_skips_the_refit_and_writes_nothing(
    lake: Lake,
    cli_env: Path,
    serve,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    lake.landed = {D1}
    # The refit is global, so a wet run over the same day runs it and writes its CSV ...
    wet = serve(LOTTERY, fires=two_fires(LOTTERY), work_dates=iso(D1))
    lottery.main(['--r2', '--all-unenriched'])
    assert any('GROUP BY underlying_symbol' in sql for sql, _ in wet.executed)
    sim = tmp_path / 'docs' / 'tmp' / f'lottery-quality-sim-{D1}.csv'
    assert sim.exists()
    sim.unlink()
    capsys.readouterr()

    # ... a dry run does not: no statement but SELECTs, no refit, no CSV.
    lake.calls.clear()
    dry = serve(LOTTERY, fires=two_fires(LOTTERY), work_dates=iso(D1))
    lottery.main(['--r2', '--all-unenriched', '--dry-run'])

    assert write_statements(dry) == []
    assert dry.values_writes == []
    assert dry.commits == 0
    assert not any('GROUP BY underlying_symbol' in sql for sql, _ in dry.executed)
    assert not sim.exists()
    assert (
        '[enrich] dry run: skipping the ticker-quality refit (it writes a simulation CSV)'
        in capsys.readouterr().out
    )


def test_lottery_dry_run_summary_says_would(
    lake: Lake, cli_env: Path, serve, capsys: pytest.CaptureFixture[str]
) -> None:
    lake.landed = {D1}
    serve(
        LOTTERY,
        fires=[prov.fire_row(1, prov.TSLA, had_outcome=True), prov.fire_row(2, prov.NVDA, had_outcome=True)],
        work_dates=iso(D1),
    )

    lottery.main(['--r2', '--all-unenriched', '--select', 'all', '--dry-run'])

    out = capsys.readouterr().out
    assert (
        '[enrich] summary (dry run, nothing written): 1 day(s) would be enriched, '
        '1 fires would be updated, 0 flow-inversion rows would be written; '
        '0 day(s) skipped for a missing archive'
    ) in out
    assert (
        '[enrich] summary (dry run, nothing written): 1 outcome(s) would replace a prior '
        'outcome, 1 unpriced fire(s) would keep theirs'
    ) in out
    # Every summary line is conditional, and none keeps the wet run's past tense.
    summary = [line for line in out.splitlines() if line.startswith('[enrich] summary')]
    assert len(summary) == 2
    for line in summary:
        assert 'would' in line
        for wet_phrase in ('fires updated', 'rows written', 'replaced a prior', 'kept theirs'):
            assert wet_phrase not in line


def test_lottery_wet_summary_keeps_its_wording(
    lake: Lake, cli_env: Path, serve, capsys: pytest.CaptureFixture[str]
) -> None:
    lake.landed = {D1}
    serve(LOTTERY, fires=[prov.fire_row(1, prov.TSLA, had_outcome=True)], work_dates=iso(D1))

    lottery.main(['--r2', '--all-unenriched', '--select', 'all'])

    out = capsys.readouterr().out
    assert (
        '[enrich] summary: 1 day(s) enriched, 1 fires updated, 0 flow-inversion rows written; '
        '0 day(s) skipped for a missing archive'
    ) in out
    assert '[enrich] summary: 1 outcome(s) replaced a prior outcome, 0 unpriced fire(s) kept theirs' in out


def test_sb_dry_run_summary_says_would(
    lake: Lake, cli_env: Path, serve, capsys: pytest.CaptureFixture[str]
) -> None:
    lake.landed = {D1}
    db = serve(
        SILENT_BOOM,
        fires=[prov.alert_row(1, prov.TSLA, had_outcome=True), prov.alert_row(2, prov.NVDA, had_outcome=True)],
        work_dates=iso(D1),
    )

    silent_boom.main(['--r2', '--all-unenriched', '--select', 'all', '--dry-run'])

    out = capsys.readouterr().out
    assert '[enrich-silent-boom] DONE (dry run, nothing written) would update 1 in ' in out
    assert (
        '[enrich-silent-boom] summary (dry run, nothing written): 1 day(s) would be enriched, '
        '1 alerts would be updated; 0 day(s) skipped for a missing archive'
    ) in out
    assert (
        '[enrich-silent-boom] summary (dry run, nothing written): '
        'alerts_would_replace=1 alerts_would_keep=1'
    ) in out
    assert 'DONE updated=' not in out
    assert 'alerts updated;' not in out
    assert write_statements(db) == []


def test_sb_wet_summary_keeps_its_wording(
    lake: Lake, cli_env: Path, serve, capsys: pytest.CaptureFixture[str]
) -> None:
    lake.landed = {D1}
    serve(SILENT_BOOM, fires=[prov.alert_row(1, prov.TSLA, had_outcome=True)], work_dates=iso(D1))

    silent_boom.main(['--r2', '--all-unenriched', '--select', 'all'])

    out = capsys.readouterr().out
    assert '[enrich-silent-boom] DONE updated=1 in ' in out
    assert '[enrich-silent-boom] summary: 1 day(s) enriched, 1 alerts updated; 0 day(s) skipped' in out
    assert '[enrich-silent-boom] summary: alerts_replaced=1 alerts_kept=0' in out


# ── a failed read ends the run, loudly and tidily ──────────────


def read_error(day: date, cause: str = 'AccessDenied') -> _tape_reader.TapeReadError:
    return _tape_reader.TapeReadError(
        f'fulltape/{day.isoformat()}-fulltape.parquet: R2 refused the read ({cause})'
    )


@pytest.mark.parametrize('script', SCRIPTS)
def test_a_failed_fetch_ends_the_run_and_closes_the_reader(
    script: Script, lake: Lake, cli_env: Path, serve
) -> None:
    lake.landed = {D1, D2, D3}
    lake.fetch_errors = {D2: read_error(D2)}
    db = serve(script, fires=two_fires(script), work_dates=iso(D1, D2, D3))

    with pytest.raises(SystemExit) as exc:
        script.module.main(['--r2', '--all-unenriched'])

    # Non-zero, and the message names the key and the cause.
    assert isinstance(exc.value.code, str)
    assert f'fulltape/{D2.isoformat()}-fulltape.parquet' in exc.value.code
    assert 'AccessDenied' in exc.value.code
    assert exc.value.code.startswith(f'{script.prefix} R2 tape read failed: ')
    # D1 was enriched and released; D2 wrote nothing; D3 was never fetched.
    assert lake.calls == [
        ('landed_days',),
        ('fetch', D1),
        ('release', D1),
        ('fetch', D2),
        ('close',),
    ]
    assert len(db.values_writes) == 1
    assert len(db.outcome_stamps()) == 1
    assert not lake.cache_dirs[0].exists()


@pytest.mark.parametrize('script', SCRIPTS)
def test_a_failed_listing_ends_the_run_and_closes_the_reader(
    script: Script, lake: Lake, cli_env: Path, serve
) -> None:
    lake.landed_error = _tape_reader.TapeReadError('listing fulltape/ failed (AccessDenied)')
    db = serve(script, fires=two_fires(script), work_dates=iso(D1))

    with pytest.raises(SystemExit) as exc:
        script.module.main(['--r2', '--all-unenriched'])

    assert 'listing fulltape/ failed (AccessDenied)' in exc.value.code
    assert lake.calls == [('landed_days',), ('close',)]
    assert db.values_writes == [] and write_statements(db) == []
    assert not lake.cache_dirs[0].exists()


@pytest.mark.parametrize('script', SCRIPTS)
def test_a_database_failure_still_closes_the_reader(
    script: Script, lake: Lake, cli_env: Path, serve
) -> None:
    lake.landed = {D1, D2}
    db = serve(script, fires=two_fires(script), work_dates=iso(D1, D2))
    db.fail_when = lambda sql: sql.startswith('UPDATE')

    with pytest.raises(psycopg2.OperationalError, match='server closed'):
        script.module.main(['--r2', '--all-unenriched'])

    assert lake.calls == [('landed_days',), ('fetch', D1), ('release', D1), ('close',)]
    assert not lake.cache_dirs[0].exists()


@pytest.mark.parametrize('script', SCRIPTS)
def test_a_missing_r2_variable_is_named_and_no_value_is_printed(
    script: Script,
    cli_env: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    # The real TapeReader.from_env, which reads only the environment: the
    # endpoint and the bucket are unset, the two secrets are not.
    key_id, secret = 'KEY-ID-SENTINEL-1f3a', 'SECRET-SENTINEL-9c2e'
    monkeypatch.setenv('R2_ACCESS_KEY_ID', key_id)
    monkeypatch.setenv('R2_SECRET_ACCESS_KEY', secret)
    connects: list[str] = []
    monkeypatch.setattr(script.module, 'connect_with_retry', lambda url: connects.append(url))

    with pytest.raises(SystemExit) as exc:
        script.module.main(['--r2', '--all-unenriched'])

    message = str(exc.value.code)
    assert exc.value.code not in (0, None)
    assert 'R2_ENDPOINT_URL' in message and 'R2_BUCKET_FULLTAPE' in message
    assert 'R2_ACCESS_KEY_ID' not in message and 'R2_SECRET_ACCESS_KEY' not in message
    out, err = capsys.readouterr()
    for value in (key_id, secret):
        assert value not in message + out + err
    # Failing fast: no database connection, and no directory left behind.
    assert connects == []
    assert list(cli_env.iterdir()) == []


@pytest.mark.parametrize('script', SCRIPTS)
def test_env_local_is_loaded_before_the_reader_is_built(
    script: Script,
    lake: Lake,
    cli_env: Path,
    serve,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The R2_* values normally live in .env.local; main loads it first. The
    # setenv/delenv pair makes the test's teardown remove what the loader sets.
    monkeypatch.setenv('R2_BUCKET_FULLTAPE', 'placeholder')
    monkeypatch.delenv('R2_BUCKET_FULLTAPE')
    env_file = tmp_path / 'with-r2.env.local'
    env_file.write_text('R2_BUCKET_FULLTAPE=bucket-from-the-file\n', encoding='utf-8')
    monkeypatch.setattr(script.module, 'ENV_FILE', env_file)
    lake.landed = {D1}
    serve(script, fires=two_fires(script), work_dates=iso(D1))

    script.module.main(['--r2', '--all-unenriched'])

    assert lake.bucket_seen == ['bucket-from-the-file']
