"""Tests for the temporary lottery refit guard (ml/src/lottery_refit_guard.py).

The guard blocks lottery_scoring.py from training until the anchor_leg_kind
training filter has history (the classifier label is gone from 2026-10-29 and
anchor_leg_kind is not yet backfilled). Remove with the guard.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

import lottery_scoring as ls
from lottery_refit_guard import UNCLASSIFIED_FROM, refit_blocked, skip_message


class _FakeDate(date):
    """date whose today() is pinned, to drive main() across the cutoff."""

    pinned = date(2026, 10, 29)

    @classmethod
    def today(cls) -> date:  # type: ignore[override]
        return cls.pinned


def test_cutoff_is_first_unclassified_day() -> None:
    assert UNCLASSIFIED_FROM == date(2026, 10, 29)


@pytest.mark.parametrize(
    ("window_end", "expected"),
    [
        (date(2026, 10, 28), False),  # last classified day: refit still allowed
        (date(2026, 10, 29), True),  # cutoff day itself
        (date(2026, 10, 30), True),
        (date(2027, 1, 1), True),
    ],
)
def test_refit_blocked_boundaries(window_end: date, expected: bool) -> None:
    assert refit_blocked(window_end) is expected


def test_skip_message_names_script_cutoff_and_removal() -> None:
    msg = skip_message("lottery_scoring.py")
    assert "lottery_scoring.py" in msg
    assert "2026-10-29" in msg
    assert "anchor_leg_kind" in msg
    assert "unchanged" in msg
    assert msg.startswith("═")
    assert msg.splitlines()[1].startswith("REFIT BLOCKED:")
    assert "SKIP" not in msg


def test_main_skips_training_and_leaves_weights_untouched(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _FakeDate.pinned = date(2026, 10, 29)
    monkeypatch.setattr(ls, "date", _FakeDate)

    def _boom(*_a: object, **_k: object) -> None:
        raise AssertionError("training path must not run while guarded")

    monkeypatch.setattr(ls, "fetch_training_data", _boom)
    monkeypatch.setattr(ls, "get_connection", _boom)

    out = (
        Path(ls.__file__).resolve().parent.parent
        / "output"
        / "lottery_score_weights.json"
    )
    before = out.read_bytes() if out.exists() else None

    ls.main()

    captured = capsys.readouterr()
    assert "REFIT BLOCKED: lottery_scoring.py" in captured.out
    assert "REFIT BLOCKED: lottery_scoring.py" in captured.err
    after = out.read_bytes() if out.exists() else None
    assert after == before


def test_main_runs_training_before_cutoff(monkeypatch: pytest.MonkeyPatch) -> None:
    _FakeDate.pinned = date(2026, 10, 28)
    monkeypatch.setattr(ls, "date", _FakeDate)
    called: list[bool] = []

    def _fetch() -> None:
        called.append(True)
        raise RuntimeError("stop after fetch")

    monkeypatch.setattr(ls, "fetch_training_data", _fetch)
    with pytest.raises(RuntimeError, match="stop after fetch"):
        ls.main()
    assert called == [True]
