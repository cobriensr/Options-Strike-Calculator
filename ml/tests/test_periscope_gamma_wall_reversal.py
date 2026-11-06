"""Tests for the findings write of ml/src/periscope_eda/05_gamma_wall_reversal.py.

The script used to read-modify-write ml/findings.json by hand, so its section
reached production only through a later whole-file upsert. It now saves through
utils.save_section_findings like every other pipeline script, which sends the
database that one section alone.
"""

import importlib
import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

SECTION = "periscope_gamma_wall_edge"
DSN = "postgresql://u:p@db.invalid/neondb"  # fake: psycopg2.connect is patched

DATA_WINDOW = {
    "distinct_days": 7,
    "earliest": "2026-05-06",
    "latest": "2026-05-14",
    "total_reads_in_window": 234,
    "warnings": ["NARROW WINDOW"],
}
BLOCKS = [
    {"claim": "walls_hold", "n_pairs": 10},
    {"claim": "magnet_predicts_close", "n": 20},
    {"claim": "charm_zero_crosses", "n_pairs": 30},
]


@pytest.fixture
def script():
    # The file name starts with a digit, so a plain import statement can't name it.
    return importlib.import_module("periscope_eda.05_gamma_wall_reversal")


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setattr("utils.ML_ROOT", tmp_path)
    monkeypatch.setattr("utils.load_env", lambda: {})
    return tmp_path


@pytest.fixture
def db(monkeypatch):
    cur = MagicMock()
    conn = MagicMock()
    conn.__enter__.return_value = conn
    conn.cursor.return_value.__enter__.return_value = cur
    connect = MagicMock(return_value=conn)
    monkeypatch.setattr("utils.psycopg2.connect", connect)
    monkeypatch.setattr("utils.load_env", lambda: {"DATABASE_URL": DSN})
    return SimpleNamespace(connect=connect, cur=cur)


def test_the_section_keeps_the_shape_the_file_already_holds(script, root):
    script.save_findings(BLOCKS, DATA_WINDOW)
    saved = json.loads((root / "findings.json").read_text())[SECTION]
    assert list(saved) == ["experiment", "run_date_utc", "data_window", "results"]
    assert saved["experiment"] == "periscope-gamma-wall-edge"
    assert saved["data_window"] == DATA_WINDOW
    assert saved["results"] == BLOCKS
    assert saved["run_date_utc"].endswith("+00:00")


def test_other_sections_in_the_file_are_kept(script, root):
    (root / "findings.json").write_text(json.dumps({"health": {"status": "WARN"}}))
    script.save_findings(BLOCKS, DATA_WINDOW)
    saved = json.loads((root / "findings.json").read_text())
    assert saved["health"] == {"status": "WARN"}
    assert SECTION in saved
    assert SECTION in saved["pipeline_sections"]


def test_the_database_gets_only_this_section(script, root, db):
    (root / "findings.json").write_text(json.dumps({"phase2": {"fake": 1}}))
    script.save_findings(BLOCKS, DATA_WINDOW)
    db.cur.execute.assert_called_once()
    params = db.cur.execute.call_args.args[1]
    assert params["name"] == SECTION
    assert json.loads(params["data"])["results"] == BLOCKS
    assert "fake" not in repr(params)
