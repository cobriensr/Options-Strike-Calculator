"""Unit tests for scripts/ingest-fulltape.py — archive write atomicity."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from unittest.mock import patch

import polars as pl
import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# Load the script as a module (script filename has hyphens, not a valid identifier)
_spec = importlib.util.spec_from_file_location(
    "ingest_fulltape", REPO_ROOT / "scripts" / "ingest-fulltape.py"
)
assert _spec is not None and _spec.loader is not None
ingest_fulltape = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ingest_fulltape)


def test_write_archive_atomic_rename(tmp_path: Path) -> None:
    """Happy path: parquet lands at the final path, no .tmp left behind."""
    archive = tmp_path / "2026-04-24-fulltape.parquet"
    lf = pl.LazyFrame({"a": [1, 2, 3]})
    ingest_fulltape.write_archive(lf, archive)
    assert archive.exists()
    assert pl.read_parquet(archive)["a"].to_list() == [1, 2, 3]
    assert not list(tmp_path.glob("*.tmp"))


def test_write_archive_crash_leaves_no_final_file(tmp_path: Path) -> None:
    """A crash mid-write must not leave a file at the final path — the
    caller's exists() skip guard (and the 10 MB CSV-deletion floor) would
    otherwise lock a truncated archive in."""
    archive = tmp_path / "2026-04-24-fulltape.parquet"
    lf = pl.LazyFrame({"a": [1]})

    def boom(self: pl.LazyFrame, path: Path, **kwargs: object) -> None:
        Path(path).write_bytes(b"partial")
        raise RuntimeError("simulated crash mid-write")

    with patch.object(pl.LazyFrame, "sink_parquet", boom):
        with pytest.raises(RuntimeError, match="simulated crash"):
            ingest_fulltape.write_archive(lf, archive)
    assert not archive.exists()
