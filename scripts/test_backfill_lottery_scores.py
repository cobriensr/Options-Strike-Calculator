"""Guard tests for scripts/backfill_lottery_scores.py (temporary refit guard).

Run:
    ml/.venv/bin/pytest scripts/test_backfill_lottery_scores.py -q
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import backfill_lottery_scores as bls  # noqa: E402


class _FakeDate(date):
    pinned = date(2026, 10, 29)

    @classmethod
    def today(cls) -> date:  # type: ignore[override]
        return cls.pinned


def _boom(*_a, **_k):
    raise AssertionError("must not run while guarded")


def test_main_guarded_skips_env_and_db(monkeypatch, capsys) -> None:
    _FakeDate.pinned = date(2026, 10, 29)
    monkeypatch.setattr(bls, "date_type", _FakeDate)
    monkeypatch.setattr(sys, "argv", ["backfill_lottery_scores.py"])
    monkeypatch.setattr(bls, "load_env", _boom)
    monkeypatch.setattr(bls, "connect_with_retry", _boom)

    bls.main()  # returns normally => exit 0

    captured = capsys.readouterr()
    assert "REFIT BLOCKED: backfill_lottery_scores.py" in captured.out
    assert "REFIT BLOCKED: backfill_lottery_scores.py" in captured.err


def test_main_dry_run_is_not_blocked(monkeypatch) -> None:
    _FakeDate.pinned = date(2026, 10, 29)
    monkeypatch.setattr(bls, "date_type", _FakeDate)
    monkeypatch.setattr(sys, "argv", ["backfill_lottery_scores.py", "--dry-run"])
    reached: list[bool] = []

    def _load_env() -> None:
        reached.append(True)
        raise SystemExit("stop after load_env")

    monkeypatch.setattr(bls, "load_env", _load_env)
    with pytest.raises(SystemExit):
        bls.main()
    assert reached == [True]


def test_main_before_cutoff_proceeds(monkeypatch) -> None:
    _FakeDate.pinned = date(2026, 10, 28)
    monkeypatch.setattr(bls, "date_type", _FakeDate)
    monkeypatch.setattr(sys, "argv", ["backfill_lottery_scores.py"])
    reached: list[bool] = []

    def _load_env() -> None:
        reached.append(True)
        raise SystemExit("stop after load_env")

    monkeypatch.setattr(bls, "load_env", _load_env)
    with pytest.raises(SystemExit):
        bls.main()
    assert reached == [True]
