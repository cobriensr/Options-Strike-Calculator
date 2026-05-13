"""Unit tests for handlers.recent_fires — the cross-symbol confluence
registry.

The handler-level integration tests live in test_interval_ba.py
(:class:`TestConfluenceTagging`). This file verifies the registry's
window math, ordering, and bounded-memory behavior in isolation, so a
regression in the pure helper surfaces here before it sneaks past the
end-to-end handler tests.
"""

from __future__ import annotations

from collections import deque
from datetime import UTC, datetime, timedelta

import pytest

from handlers import recent_fires
from handlers.recent_fires import _MAX_LEN, lookup_confluence, record


# Reset the module-level registry before AND after every test so cases
# can't pollute each other. Belt-and-suspenders: the autouse fixture in
# test_interval_ba.py covers the handler-level tests; this one covers
# the unit tests here.
@pytest.fixture(autouse=True)
def _reset_registry():
    recent_fires._reset_for_tests()
    yield
    recent_fires._reset_for_tests()


_T0 = datetime(2026, 5, 13, 14, 0, 0, tzinfo=UTC)


def test_record_then_lookup_other_ticker_finds_partner():
    """SPY fired 30s ago → SPXW's lookup should return ['SPY']."""
    record("SPY", "C", _T0)
    out = lookup_confluence(
        ticker="SPXW",
        option_type="C",
        fired_at=_T0 + timedelta(seconds=30),
        window_sec=90,
    )
    assert out == ["SPY"]


def test_lookup_excludes_self_ticker():
    """SPXW lookup must never include SPXW even if SPXW fired before."""
    record("SPXW", "C", _T0)
    out = lookup_confluence(
        ticker="SPXW",
        option_type="C",
        fired_at=_T0 + timedelta(seconds=10),
        window_sec=90,
    )
    assert out == []


def test_lookup_excludes_opposite_direction():
    """SPY-CALL recorded; SPXW-PUT lookup must NOT match."""
    record("SPY", "C", _T0)
    out = lookup_confluence(
        ticker="SPXW",
        option_type="P",
        fired_at=_T0 + timedelta(seconds=30),
        window_sec=90,
    )
    assert out == []


def test_lookup_drops_entries_outside_window():
    """SPY fired 5 minutes ago — outside the 90s window — not confluence."""
    record("SPY", "C", _T0)
    out = lookup_confluence(
        ticker="SPXW",
        option_type="C",
        fired_at=_T0 + timedelta(seconds=300),
        window_sec=90,
    )
    assert out == []


def test_lookup_includes_entry_exactly_at_window_edge():
    """Entry exactly window_sec seconds old IS still confluence."""
    record("SPY", "C", _T0)
    out = lookup_confluence(
        ticker="SPXW",
        option_type="C",
        fired_at=_T0 + timedelta(seconds=90),
        window_sec=90,
    )
    assert out == ["SPY"]


def test_lookup_returns_sorted_list_of_multiple_partners():
    """SPY and QQQ both fired CALL in the window → both returned, sorted."""
    record("SPY", "C", _T0)
    record("QQQ", "C", _T0 + timedelta(seconds=20))
    out = lookup_confluence(
        ticker="SPXW",
        option_type="C",
        fired_at=_T0 + timedelta(seconds=60),
        window_sec=90,
    )
    # QQQ sorts before SPY alphabetically.
    assert out == ["QQQ", "SPY"]


def test_multiple_fires_same_ticker_counted_once():
    """SPY fired 3 times in the window — partner list contains 'SPY' once."""
    for delta_sec in (5, 15, 30):
        record("SPY", "C", _T0 + timedelta(seconds=delta_sec))
    out = lookup_confluence(
        ticker="SPXW",
        option_type="C",
        fired_at=_T0 + timedelta(seconds=60),
        window_sec=90,
    )
    assert out == ["SPY"]


def test_deque_max_len_caps_at_max_len():
    """Append (_MAX_LEN + 50) entries — deque retains only _MAX_LEN."""
    for i in range(_MAX_LEN + 50):
        record("SPY", "C", _T0 + timedelta(seconds=i))
    # Force-pull the internal deque to assert the bound.
    dq = recent_fires._fires[("SPY", "C")]
    assert isinstance(dq, deque)
    assert dq.maxlen == _MAX_LEN
    assert len(dq) == _MAX_LEN


def test_lookup_handles_future_timestamp_gracefully():
    """A registry entry from the future (clock skew) shouldn't crash.

    Older entries past the future-skew one should still be visible —
    we keep scanning rather than break on a negative delta.
    """
    record("SPY", "C", _T0)
    record("SPY", "C", _T0 + timedelta(seconds=600))  # future-skew entry
    out = lookup_confluence(
        ticker="SPXW",
        option_type="C",
        fired_at=_T0 + timedelta(seconds=30),
        window_sec=90,
    )
    # The original SPY fire at _T0 (30s ago) is within the window even
    # though the deque ALSO has a future-skewed entry at +600s.
    assert out == ["SPY"]


def test_reset_for_tests_clears_state():
    """_reset_for_tests() empties every key."""
    record("SPY", "C", _T0)
    record("QQQ", "P", _T0)
    assert recent_fires._fires  # populated
    recent_fires._reset_for_tests()
    assert recent_fires._fires == {}
