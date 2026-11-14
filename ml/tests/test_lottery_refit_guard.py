"""Tests for the temporary lottery refit guard (ml/src/lottery_refit_guard.py).

The guard blocks the lottery refits from training until the outcome backfill
and the two phase-4 fixes land. anchor_leg_kind is backfilled (2026-11-04), so
that is no longer a reason to block. Remove with the guard.
"""

from __future__ import annotations

from datetime import date

import pytest

from lottery_refit_guard import UNCLASSIFIED_FROM, refit_blocked, skip_message


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
    assert "outcome backfill" in msg
    assert "phase-4 fixes" in msg
    assert "lottery_refit_guard.py" in msg
    assert "unchanged" in msg
    # The anchor_leg_kind history was backfilled, so it is no longer the reason.
    assert "anchor_leg_kind" not in msg
    assert "no history" not in msg
    assert msg.startswith("═")
    assert msg.splitlines()[1].startswith("REFIT BLOCKED:")
    assert "SKIP" not in msg
