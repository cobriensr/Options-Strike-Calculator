"""Archive-directory helpers for the pipeline scripts that read parquet days.

The Bot-EOD (`{date}-trades.parquet`) and Full Tape
(`{date}-fulltape.parquet`) archives used to sit at fixed paths on the
retired Mac. Scripts now take the directory as `--parquet-dir`, with no
home-directory default, and argparse rejects a bad value before any work
starts:

    error: argument --parquet-dir: directory not found: F:\\uw-lake\\x

The Makefile passes its PARQUET_DIR for the nightly targets.

A day whose file is missing from an existing archive is a different case:
the enrich and timing scripts skip it with `warn_missing_archive` and list
the skipped days at the end (`format_dates`), so one absent day doesn't
stop `make update`.

`load_env_file` is the shared `.env.local` reader. A missing file is fine:
the nightly service on Railway has no env file and gets its variables from
the service.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

_ENV_ASSIGNMENT = re.compile(r'^([A-Z_][A-Z0-9_]*)=(.*)$')


def existing_dir(value: str) -> Path:
    """argparse ``type=``: an existing directory, with ``~`` expanded.

    Raises ``argparse.ArgumentTypeError`` naming the path when it is empty,
    missing or not a directory, which argparse turns into a usage error
    (exit 2) that names the flag too.
    """
    if not value.strip():
        # Path('') is '.', so an empty value would read the current dir.
        raise argparse.ArgumentTypeError('empty path')
    path = Path(value).expanduser()
    if path.is_dir():
        return path
    if path.exists():
        raise argparse.ArgumentTypeError(f'not a directory: {path}')
    raise argparse.ArgumentTypeError(f'directory not found: {path}')


def warn_missing_archive(prefix: str, date: str, path: Path, detail: str) -> None:
    """Print one line for a day skipped because its archive file is missing.

    It goes to stdout (the run log) and stderr (a terminal or cron mail that
    only shows errors), naming the date, the path that was expected and what
    was left alone.
    """
    line = f'{prefix} SKIP {date}: archive file missing: {path} ({detail})'
    print(line, flush=True)
    print(line, file=sys.stderr, flush=True)


def format_dates(dates: list[str], keep: int = 3) -> str:
    """The dates, comma-separated; past ``2 * keep`` of them, only the first
    and last ``keep`` around an ellipsis."""
    if len(dates) <= 2 * keep:
        return ', '.join(dates)
    head = ', '.join(dates[:keep])
    tail = ', '.join(dates[-keep:])
    return f'{head} … {tail}'


def load_env_file(path: Path) -> None:
    """Copy ``NAME=value`` lines from an env file into ``os.environ``.

    A name that is already set keeps its value, so a shell or service
    variable beats the file. Matching lines are ``[A-Z_][A-Z0-9_]*=...``
    after ``strip()``; comments, ``export`` lines and the rest are skipped.
    Double quotes, then single quotes, are stripped from both ends of the
    value. A missing file is a no-op, not an exit.
    """
    try:
        f = path.open(encoding='utf-8')
    except FileNotFoundError:
        return
    with f:
        for line in f:
            m = _ENV_ASSIGNMENT.match(line.strip())
            if m:
                os.environ.setdefault(m.group(1), m.group(2).strip('"').strip("'"))
