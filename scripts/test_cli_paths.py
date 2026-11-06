"""Unit tests for the shared archive-directory argparse type and env loader.

Run:

    ml/.venv/Scripts/python -m pytest scripts/test_cli_paths.py -q
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _cli_paths import (  # noqa: E402
    existing_dir,
    format_dates,
    load_env_file,
    warn_missing_archive,
)


@pytest.fixture
def environ(monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    """A private copy of os.environ, so a loaded name can't leak into a later test."""
    env = dict(os.environ)
    monkeypatch.setattr(os, 'environ', env)
    return env


def test_returns_an_existing_directory_as_a_path(tmp_path: Path) -> None:
    assert existing_dir(str(tmp_path)) == tmp_path


def test_expands_a_leading_tilde(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Path.expanduser reads HOME on POSIX and USERPROFILE on Windows.
    monkeypatch.setenv('HOME', str(tmp_path))
    monkeypatch.setenv('USERPROFILE', str(tmp_path))
    (tmp_path / 'tape').mkdir()
    assert existing_dir('~/tape') == tmp_path / 'tape'


def test_rejects_a_missing_directory_by_name(tmp_path: Path) -> None:
    missing = tmp_path / 'Eod-Full-Tape-parquet'
    with pytest.raises(argparse.ArgumentTypeError) as exc:
        existing_dir(str(missing))
    assert str(exc.value) == f'directory not found: {missing}'


def test_rejects_a_file_by_name(tmp_path: Path) -> None:
    day_file = tmp_path / '2026-07-23-fulltape.parquet'
    day_file.write_bytes(b'')
    with pytest.raises(argparse.ArgumentTypeError) as exc:
        existing_dir(str(day_file))
    assert str(exc.value) == f'not a directory: {day_file}'


@pytest.mark.parametrize('value', ['', '   '])
def test_rejects_an_empty_path(value: str) -> None:
    # Path('') is '.', which would silently read the current directory
    # (e.g. `make enrich PARQUET_DIR=` passing --parquet-dir "").
    with pytest.raises(argparse.ArgumentTypeError, match='empty path'):
        existing_dir(value)


def test_argparse_error_names_the_flag_and_the_path(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    parser = argparse.ArgumentParser(prog='enrich')
    parser.add_argument('--parquet-dir', type=existing_dir, required=True)
    missing = tmp_path / 'Bot-Eod-parquet'

    with pytest.raises(SystemExit) as exc:
        parser.parse_args(['--parquet-dir', str(missing)])

    assert exc.value.code == 2
    err = capsys.readouterr().err
    assert '--parquet-dir' in err
    assert str(missing) in err


def test_missing_archive_line_goes_to_stdout_and_stderr(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / '2026-07-23-trades.parquet'
    warn_missing_archive('[enrich]', '2026-07-23', path, '12 fires left unenriched')

    out, err = capsys.readouterr()
    line = (
        f'[enrich] SKIP 2026-07-23: archive file missing: {path} '
        '(12 fires left unenriched)\n'
    )
    assert out == line
    assert err == line


@pytest.mark.parametrize(
    ('dates', 'expected'),
    [
        ([], ''),
        (['2026-07-22'], '2026-07-22'),
        (
            ['2026-07-22', '2026-07-23', '2026-07-24', '2026-07-27'],
            '2026-07-22, 2026-07-23, 2026-07-24, 2026-07-27',
        ),
        (
            [f'2026-08-{d:02d}' for d in range(3, 15)],
            '2026-08-03, 2026-08-04, 2026-08-05 … 2026-08-12, 2026-08-13, 2026-08-14',
        ),
    ],
)
def test_format_dates_keeps_the_ends_of_a_long_list(
    dates: list[str], expected: str
) -> None:
    assert format_dates(dates) == expected


def test_load_env_file_sets_missing_vars_and_never_overrides(
    tmp_path: Path, environ: dict[str, str]
) -> None:
    env_file = tmp_path / 'fake.env'
    env_file.write_text(
        'FAKE_FROM_FILE=file-value\nFAKE_ALREADY_SET=file-value\n', encoding='utf-8'
    )
    environ.pop('FAKE_FROM_FILE', None)
    environ['FAKE_ALREADY_SET'] = 'shell-value'

    load_env_file(env_file)

    assert environ['FAKE_FROM_FILE'] == 'file-value'
    # A variable the shell or the Railway service already set wins over the file.
    assert environ['FAKE_ALREADY_SET'] == 'shell-value'


def test_load_env_file_strips_quotes_and_skips_non_assignments(
    tmp_path: Path, environ: dict[str, str]
) -> None:
    env_file = tmp_path / 'fake.env'
    env_file.write_text(
        '# FAKE_COMMENTED=nope\n'
        '\n'
        'FAKE_DOUBLE="double value"\n'
        "FAKE_SINGLE='single value'\n"
        '  FAKE_PADDED=padded value  \n'
        'FAKE_EMPTY=\n'
        'FAKE_WITH_EQUALS=https://example.invalid/?a=1&b=2\n'
        'FAKE_UTF8=café\n'
        'export FAKE_EXPORTED=nope\n'
        'fake_lowercase=nope\n'
        'FAKE SPACE=nope\n'
        '=nope\n',
        encoding='utf-8',
    )
    before = set(environ)

    load_env_file(env_file)

    assert environ['FAKE_DOUBLE'] == 'double value'
    assert environ['FAKE_SINGLE'] == 'single value'
    assert environ['FAKE_PADDED'] == 'padded value'
    assert environ['FAKE_EMPTY'] == ''
    assert environ['FAKE_WITH_EQUALS'] == 'https://example.invalid/?a=1&b=2'
    assert environ['FAKE_UTF8'] == 'café'
    assert set(environ) - before == {
        'FAKE_DOUBLE',
        'FAKE_SINGLE',
        'FAKE_PADDED',
        'FAKE_EMPTY',
        'FAKE_WITH_EQUALS',
        'FAKE_UTF8',
    }


def test_load_env_file_missing_path_is_a_noop(
    tmp_path: Path, environ: dict[str, str]
) -> None:
    before = dict(environ)

    # The nightly service has no .env.local; Railway supplies the environment.
    assert load_env_file(tmp_path / 'absent.env') is None

    assert environ == before
