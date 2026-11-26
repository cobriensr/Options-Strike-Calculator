"""scripts/analyze_confluence_vs_solo.py: which outcomes CSV it takes when none is named.

The script reads `alert_id` as an interval_ba_alerts id, so it can only use the CSV that
enrich_interval_ba_outcomes.py writes for SPXW from the table. The files for SPY and QQQ and for
the full-year export sort above it by name ("-spy-", "-export-"), so a bare newest-first glob took
them and died on `int('SPXW...@epoch')`. Run from the repo root with the ml venv:

    ml/.venv/Scripts/python -m pytest scripts/test_analyze_confluence_vs_solo.py -q
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import analyze_confluence_vs_solo as acs  # noqa: E402


def touch(folder: Path, *names: str) -> None:
    for name in names:
        (folder / name).write_text('x', encoding='utf-8')


def test_the_newest_spxw_table_csv_is_taken_over_every_other_kind_of_file(tmp_path):
    touch(
        tmp_path,
        'interval-ba-outcomes-20261120-100000.csv',
        'interval-ba-outcomes-20261126-101500.csv',  # the one to take
        'interval-ba-outcomes-export-20261126-120000.csv',  # export: alert_id is not an id
        'interval-ba-outcomes-export-spy-20261126-121000.csv',
        'interval-ba-outcomes-spy-20261126-130000.csv',
        'interval-ba-outcomes-qqq-20261126-131000.csv',
        'interval-ba-outcomes-20261126-140000.csv.partial',  # a run that died
        'interval-ba-outcomes-summary-20261126-101500.md',
    )

    assert acs.newest_outcomes_csv(tmp_path).name == 'interval-ba-outcomes-20261126-101500.csv'


def test_with_only_other_kinds_of_file_it_exits_instead_of_taking_one(tmp_path):
    touch(
        tmp_path,
        'interval-ba-outcomes-export-20261126-120000.csv',
        'interval-ba-outcomes-spy-20261126-130000.csv',
    )

    with pytest.raises(SystemExit, match='No SPXW outcomes CSV'):
        acs.newest_outcomes_csv(tmp_path)


def test_main_loads_the_paths_from_that_csv(tmp_path, monkeypatch):
    """The default invocation passes newest_outcomes_csv's file on to load_paths."""
    touch(
        tmp_path,
        'interval-ba-outcomes-20261126-101500.csv',
        'interval-ba-outcomes-export-20261126-120000.csv',
    )
    taken: list[Path] = []

    class Stop(Exception):
        pass

    def load_paths(path: Path):
        taken.append(path)
        raise Stop

    monkeypatch.setattr(acs, 'OUT_DIR', tmp_path)
    monkeypatch.setattr(acs, 'load_env', lambda: None)
    monkeypatch.setattr(acs, 'load_paths', load_paths)
    monkeypatch.setattr(sys, 'argv', ['analyze_confluence_vs_solo.py'])

    with pytest.raises(Stop):
        acs.main()

    assert [p.name for p in taken] == ['interval-ba-outcomes-20261126-101500.csv']
