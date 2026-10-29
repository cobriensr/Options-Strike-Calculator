"""--parquet-dir handling for the scripts that read the Full Tape archive.

reload-ws-option-trades-from-fulltape.py, backfill_interval_ba_alerts.py
and enrich_silent_boom_outcomes_fulltape.py read
`{date}-fulltape.parquet` files. The archive's location is a required
argument (no home-directory default), and a missing directory or day
file fails by name before any database work. Run:

    ml/.venv/Scripts/python -m pytest scripts/test_fulltape_parquet_dir.py -q
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import backfill_interval_ba_alerts as interval_ba  # noqa: E402
import enrich_silent_boom_outcomes_fulltape as sb_fulltape  # noqa: E402


def _load_hyphenated(stem: str):
    """Import a script whose file name isn't a valid module name."""
    spec = importlib.util.spec_from_file_location(
        stem.replace('-', '_'), SCRIPTS / f'{stem}.py'
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


reload_ws = _load_hyphenated('reload-ws-option-trades-from-fulltape')


def _touch(directory: Path, *names: str) -> None:
    for name in names:
        (directory / name).write_bytes(b'')


# (parse_args, the other arguments that script requires)
PARSERS = [
    pytest.param(
        reload_ws.parse_args,
        ['--date', '2026-07-23'],
        id='reload-ws-option-trades-from-fulltape',
    ),
    pytest.param(interval_ba.parse_args, [], id='backfill_interval_ba_alerts'),
    pytest.param(
        sb_fulltape.parse_args, [], id='enrich_silent_boom_outcomes_fulltape'
    ),
]


@pytest.mark.parametrize(('parse_args', 'base'), PARSERS)
def test_parquet_dir_is_required(
    parse_args, base: list[str], capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(SystemExit) as exc:
        parse_args(base)
    assert exc.value.code == 2
    assert '--parquet-dir' in capsys.readouterr().err


@pytest.mark.parametrize(('parse_args', 'base'), PARSERS)
def test_missing_parquet_dir_fails_by_name(
    parse_args,
    base: list[str],
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    missing = tmp_path / 'Eod-Full-Tape-parquet'
    with pytest.raises(SystemExit) as exc:
        parse_args([*base, '--parquet-dir', str(missing)])
    assert exc.value.code == 2
    err = capsys.readouterr().err
    assert '--parquet-dir' in err
    assert str(missing) in err


@pytest.mark.parametrize(('parse_args', 'base'), PARSERS)
def test_parquet_dir_parses_to_a_path(
    parse_args, base: list[str], tmp_path: Path
) -> None:
    args = parse_args([*base, '--parquet-dir', str(tmp_path)])
    assert args.parquet_dir == tmp_path


# ── reload-ws-option-trades-from-fulltape ──────────────────────


def test_reload_names_a_missing_day_file_before_touching_the_db(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def no_db(*_args, **_kwargs):
        raise AssertionError('connected to the database')

    monkeypatch.setattr(reload_ws.psycopg2, 'connect', no_db)
    _touch(tmp_path, '2026-07-22-fulltape.parquet')

    rc = reload_ws.main(['--date', '2026-07-23', '--parquet-dir', str(tmp_path)])

    assert rc == 2
    err = capsys.readouterr().err
    assert f'parquet not found: {tmp_path / "2026-07-23-fulltape.parquet"}' in err


# ── backfill_interval_ba_alerts ────────────────────────────────


def test_interval_ba_lists_days_from_the_given_dir(tmp_path: Path) -> None:
    _touch(
        tmp_path,
        '2026-07-22-fulltape.parquet',
        '2026-07-23-fulltape.parquet',
        '2026-07-24-fulltape.parquet',
        '2026-07-23-trades.parquet',  # Bot-EOD layout: not a Full Tape day
        'notes.txt',
    )

    assert interval_ba.list_parquet_dates(
        tmp_path, '2026-07-23', None, None
    ) == [
        ('2026-07-23', tmp_path / '2026-07-23-fulltape.parquet'),
        ('2026-07-24', tmp_path / '2026-07-24-fulltape.parquet'),
    ]
    assert [
        d for d, _ in interval_ba.list_parquet_dates(tmp_path, None, None, 2)
    ] == ['2026-07-22', '2026-07-23']


def test_interval_ba_names_the_dir_when_no_day_matches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    empty_env = tmp_path / '.env.local'
    empty_env.write_text('')
    monkeypatch.setattr(interval_ba, 'ENV_FILE', empty_env)
    _touch(tmp_path, '2026-06-15-fulltape.parquet')

    with pytest.raises(SystemExit) as exc:
        interval_ba.main(
            [
                '--parquet-dir',
                str(tmp_path),
                '--from-date',
                '2026-07-22',
                '--to-date',
                '2026-09-04',
                '--dry-run',
            ]
        )

    message = str(exc.value.code)
    assert 'No *-fulltape.parquet files' in message
    assert str(tmp_path) in message
    assert '2026-07-22' in message and '2026-09-04' in message


# ── enrich_silent_boom_outcomes_fulltape ───────────────────────


def test_sb_fulltape_lists_days_from_the_given_dir(tmp_path: Path) -> None:
    _touch(
        tmp_path,
        '2026-07-21-fulltape.parquet',
        '2026-07-22-fulltape.parquet',
        '2026-07-23-fulltape.parquet',
        '2026-07-22-trades.parquet',
    )

    assert sb_fulltape.list_fulltape_dates(
        tmp_path, '2026-07-22', '2026-07-23'
    ) == ['2026-07-22', '2026-07-23']
    assert sb_fulltape.list_fulltape_dates(tmp_path, None, None) == [
        '2026-07-21',
        '2026-07-22',
        '2026-07-23',
    ]


def test_sb_fulltape_keeps_date_and_range_exclusive(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(SystemExit) as exc:
        sb_fulltape.parse_args(
            [
                '--parquet-dir',
                str(tmp_path),
                '--date',
                '2026-07-23',
                '--from-date',
                '2026-07-22',
            ]
        )
    assert exc.value.code == 2
    assert 'mutually exclusive' in capsys.readouterr().err
