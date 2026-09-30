"""Tests for moc_features' parquet loaders.

The Databento DBN decode path was removed on 2026-09-30; the loaders now
read only the cached parquet files and exit with a clear error when a
cache is missing.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

import moc_features


def test_load_bars_reads_cached_parquet(tmp_path: Path) -> None:
    cache = tmp_path / "qqq_bars_1m.parquet"
    frame = pd.DataFrame({"symbol": ["QQQ", "QQQ"], "close": [400.0, 401.5]})
    frame.to_parquet(cache)

    loaded = moc_features.load_bars(cache)

    pd.testing.assert_frame_equal(loaded, frame)


def test_load_bars_exits_when_cache_missing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    missing = tmp_path / "nope.parquet"

    with pytest.raises(SystemExit) as exc_info:
        moc_features.load_bars(missing)

    assert exc_info.value.code == 1
    assert "not found" in capsys.readouterr().out


def test_load_imbalance_exits_when_cache_missing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(SystemExit) as exc_info:
        moc_features.load_imbalance(tmp_path / "nope.parquet")

    assert exc_info.value.code == 1
    assert "moc_inspect.py" in capsys.readouterr().out


def test_parse_args_no_longer_requires_dbn_input(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """--bars-input (the DBN path) is gone; defaults parse with no args."""
    monkeypatch.setattr("sys.argv", ["moc_features.py"])

    args = moc_features.parse_args()

    assert not hasattr(args, "bars_input")
    assert args.bars_parquet.name == "qqq_bars_1m.parquet"
