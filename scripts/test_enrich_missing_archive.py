"""Archive handling in enrich_lottery_outcomes.py and
enrich_silent_boom_outcomes.py, the two `make update` enrich steps.

- `--parquet-dir` is required (no home-directory default) and a bad one
  fails by name before any work.
- Owner rule, 2026-10-29: a day whose archive file is missing is skipped,
  named on stdout and stderr, counted in the summary, and nothing is
  written for it (its rows keep enriched_at NULL), and the run exits 0.
  Any other error (DB, unreadable parquet) still fails the run.

Neon is faked at the psycopg2 boundary (connect_with_retry, execute_values,
the cursor). Run:

    ml/.venv/Scripts/python -m pytest scripts/test_enrich_missing_archive.py -q
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

import pandas as pd
import psycopg2
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import enrich_lottery_outcomes as lottery  # noqa: E402
import enrich_silent_boom_outcomes as silent_boom  # noqa: E402

PRESENT_1, MISSING, PRESENT_2 = '2026-07-22', '2026-07-23', '2026-07-24'
DAYS = [PRESENT_1, MISSING, PRESENT_2]
# One fire (or alert) per day: id 1 on PRESENT_1, 2 on MISSING, 3 on PRESENT_2.
IDS = {PRESENT_1: 1, MISSING: 2, PRESENT_2: 3}


def _chain(day: str) -> str:
    return f'TSLA{day.replace("-", "")[2:]}C00300000'


def _entry(day: str) -> datetime:
    return datetime.fromisoformat(f'{day}T15:00:00+00:00')


def _write_day(archive: Path, day: str, suffix: str = 'trades') -> None:
    """A small day file: the fired chain trades up from the entry."""
    pd.DataFrame(
        {
            'executed_at': [
                datetime.fromisoformat(f'{day}T15:{m:02d}:00+00:00')
                for m in (1, 20, 30, 45)
            ],
            'option_chain_id': [_chain(day)] * 4,
            'price': [1.1, 1.6, 1.3, 1.2],
            'canceled': [False] * 4,
        }
    ).to_parquet(archive / f'{day}-{suffix}.parquet')


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
        self.db.executed.append((sql, params))
        self.rows = self.db.answer(sql, params)
        self.rowcount = len(params[0]) if 'UPDATE' in sql and params else 0

    def fetchall(self) -> list:
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def close(self) -> None:
        pass


class FakeDb:
    """Answers the enrich scripts' SELECTs and records every write."""

    def __init__(self, table: str) -> None:
        self.table = table
        self.executed: list[tuple[str, tuple | None]] = []
        self.values_writes: list[tuple[str, list]] = []

    # psycopg2 connection surface
    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def commit(self) -> None:
        pass

    def close(self) -> None:
        pass

    def answer(self, sql: str, params: tuple | None) -> list:
        if 'SELECT DISTINCT date::text' in sql:
            return [(d,) for d in DAYS]
        if f'FROM {self.table}' in sql and 'WHERE date = %s' in sql:
            day = params[0]
            if 'realized_flow_inversion_pct IS NULL' in sql:
                return []  # no flow-inversion work in these tests
            return [(IDS[day], _chain(day), _entry(day), 1.0)]
        return []  # net-flow, ticker-quality refit: nothing

    def written_ids(self) -> set[int]:
        """Every fire/alert id any UPDATE touched."""
        ids: set[int] = set()
        for _sql, rows in self.values_writes:
            ids.update(int(r[0]) for r in rows)
        for sql, params in self.executed:
            if 'UPDATE' in sql and params:
                ids.update(int(i) for i in params[0])
        return ids


@pytest.fixture
def archive(tmp_path: Path) -> Path:
    directory = tmp_path / 'Bot-Eod-parquet'
    directory.mkdir()
    return directory


@pytest.fixture
def run_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Empty .env.local, a fake DATABASE_URL, and the cwd in tmp so the
    lottery refit's sim CSV (docs/tmp/...) lands there."""
    env_file = tmp_path / '.env.local'
    env_file.write_text('')
    for module in (lottery, silent_boom):
        monkeypatch.setattr(module, 'ENV_FILE', env_file)
    monkeypatch.delenv('DATABASE_URL_UNPOOLED', raising=False)
    monkeypatch.delenv('WRITE_DB', raising=False)
    monkeypatch.setenv('DATABASE_URL', 'postgresql://test/none')
    monkeypatch.chdir(tmp_path)
    # main() rebinds these module globals; restore them after the test.
    monkeypatch.setattr(lottery, 'PARQUET_DIR', None)
    monkeypatch.setattr(
        lottery, 'PARQUET_FILE_PATTERN', lottery.PARQUET_FORMATS['trades']
    )
    monkeypatch.setattr(silent_boom, 'PARQUET_DIR', None)


def _fake_db(module, table: str, monkeypatch: pytest.MonkeyPatch) -> FakeDb:
    db = FakeDb(table)
    monkeypatch.setattr(module, 'connect_with_retry', lambda _url: db)

    def record(_cur, sql, rows, **_kwargs):
        db.values_writes.append((sql, list(rows)))

    monkeypatch.setattr(module, 'execute_values', record)
    return db


# ── --parquet-dir contract ─────────────────────────────────────

PARSERS = [
    pytest.param(lottery.parse_args, id='enrich_lottery_outcomes'),
    pytest.param(silent_boom.parse_args, id='enrich_silent_boom_outcomes'),
]


@pytest.mark.parametrize('parse_args', PARSERS)
def test_parquet_dir_is_required(
    parse_args, capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(SystemExit) as exc:
        parse_args(['--date', '2026-07-23'])
    assert exc.value.code == 2
    assert '--parquet-dir' in capsys.readouterr().err


@pytest.mark.parametrize('parse_args', PARSERS)
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


@pytest.mark.parametrize('parse_args', PARSERS)
def test_parquet_dir_parses_to_a_path(parse_args, archive: Path) -> None:
    assert parse_args(['--parquet-dir', str(archive)]).parquet_dir == archive


def test_lottery_latest_date_reads_the_configured_dir(
    archive: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # scripts/recompute_peak_from_parquet.py sets these globals directly.
    monkeypatch.setattr(lottery, 'PARQUET_DIR', archive)
    monkeypatch.setattr(
        lottery, 'PARQUET_FILE_PATTERN', lottery.PARQUET_FORMATS['fulltape']
    )
    for name in ('2026-07-22-fulltape', '2026-07-23-fulltape', '2026-07-24-trades'):
        (archive / f'{name}.parquet').write_bytes(b'')
    assert lottery.detect_latest_date() == '2026-07-23'


def test_lottery_direct_loader_callers_still_exit_on_a_missing_file(
    archive: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # recompute_peak_from_parquet.py calls the loader directly; only the
    # enrich run's day loop skips.
    monkeypatch.setattr(lottery, 'PARQUET_DIR', archive)
    monkeypatch.setattr(
        lottery, 'PARQUET_FILE_PATTERN', lottery.PARQUET_FORMATS['trades']
    )
    with pytest.raises(SystemExit) as exc:
        lottery.load_parquet_chain_index(MISSING, {_chain(MISSING)})
    assert str(exc.value.code) == (
        f'Parquet not found: {archive / f"{MISSING}-trades.parquet"}'
    )


# ── lottery: missing day is skipped, the run carries on ────────


def test_lottery_skips_a_missing_day_and_enriches_the_others(
    archive: Path,
    run_env: None,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    db = _fake_db(lottery, 'lottery_finder_fires', monkeypatch)
    _write_day(archive, PRESENT_1)
    _write_day(archive, PRESENT_2)

    # Returns normally: the process exits 0.
    lottery.main(['--all-unenriched', '--parquet-dir', str(archive)])

    assert db.written_ids() == {IDS[PRESENT_1], IDS[PRESENT_2]}
    out, err = capsys.readouterr()
    skip = (
        f'[enrich] SKIP {MISSING}: archive file missing: '
        f'{archive / f"{MISSING}-trades.parquet"} '
        '(1 unenriched fires and 0 without flow inversion left as they are)'
    )
    assert skip in out
    assert skip in err
    assert (
        '[enrich] summary: 2 day(s) enriched, 2 fires updated, '
        '0 flow-inversion rows written; 1 day(s) skipped for a missing archive'
    ) in out
    listed = f'[enrich] skipped (archive missing, fires left unenriched): {MISSING}'
    assert listed in out
    assert listed in err


def test_lottery_single_missing_date_is_a_skip_too(
    archive: Path,
    run_env: None,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    db = _fake_db(lottery, 'lottery_finder_fires', monkeypatch)

    lottery.main(['--date', MISSING, '--parquet-dir', str(archive)])

    assert db.written_ids() == set()
    assert '1 day(s) skipped for a missing archive' in capsys.readouterr().out


def test_lottery_db_failure_still_fails_the_run(
    archive: Path, run_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_db(lottery, 'lottery_finder_fires', monkeypatch)

    def connection_lost(*_args, **_kwargs):
        raise psycopg2.OperationalError('server closed the connection')

    monkeypatch.setattr(lottery, 'execute_values', connection_lost)
    _write_day(archive, PRESENT_1)
    _write_day(archive, PRESENT_2)

    with pytest.raises(psycopg2.OperationalError, match='server closed'):
        lottery.main(['--all-unenriched', '--parquet-dir', str(archive)])


def test_lottery_unreadable_parquet_still_fails_the_run(
    archive: Path, run_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = _fake_db(lottery, 'lottery_finder_fires', monkeypatch)
    (archive / f'{PRESENT_1}-trades.parquet').write_bytes(b'not a parquet file')

    with pytest.raises(Exception) as exc:
        lottery.main(['--all-unenriched', '--parquet-dir', str(archive)])

    assert not isinstance(exc.value, SystemExit)
    assert 'parquet' in str(exc.value).lower()
    assert db.written_ids() == set()


# ── silent boom: same rule ─────────────────────────────────────


def test_silent_boom_skips_a_missing_day_and_enriches_the_others(
    archive: Path,
    run_env: None,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    db = _fake_db(silent_boom, 'silent_boom_alerts', monkeypatch)
    _write_day(archive, PRESENT_1)
    _write_day(archive, PRESENT_2)

    silent_boom.main(['--all-unenriched', '--parquet-dir', str(archive)])

    assert db.written_ids() == {IDS[PRESENT_1], IDS[PRESENT_2]}
    out, err = capsys.readouterr()
    skip = (
        f'[enrich-silent-boom] SKIP {MISSING}: archive file missing: '
        f'{archive / f"{MISSING}-trades.parquet"} (1 alerts left unenriched)'
    )
    assert skip in out
    assert skip in err
    assert (
        '[enrich-silent-boom] summary: 2 day(s) enriched, 2 alerts updated; '
        '1 day(s) skipped for a missing archive'
    ) in out
    assert f'alerts left unenriched): {MISSING}' in err


def test_silent_boom_db_failure_still_fails_the_run(
    archive: Path, run_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_db(silent_boom, 'silent_boom_alerts', monkeypatch)

    def connection_lost(*_args, **_kwargs):
        raise psycopg2.OperationalError('server closed the connection')

    monkeypatch.setattr(silent_boom, 'execute_values', connection_lost)
    _write_day(archive, PRESENT_1)

    with pytest.raises(psycopg2.OperationalError, match='server closed'):
        silent_boom.main(['--all-unenriched', '--parquet-dir', str(archive)])


def test_written_ids_sees_both_write_paths() -> None:
    # Guard on the fake itself: the skip tests lean on it.
    db = FakeDb('lottery_finder_fires')
    db.values_writes.append(('UPDATE ... FROM (VALUES %s)', [(7, 1.0)]))
    db.executed.append(('UPDATE lottery_finder_fires SET enriched_at', ([8, 9],)))
    assert db.written_ids() == {7, 8, 9}
