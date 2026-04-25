"""Tests for `pac_classifier.events.extract_events`.

Covers:
- Empty input → empty frame with the correct schema (downstream code
  should never index-error on a quiet day).
- BOS-only bar emits one row.
- CHoCH-only bar emits one row.
- CHoCH + CHoCHPlus at the same bar: only CHOCHPLUS emitted (no
  double-counting of the same setup).
- BOS coexists with CHoCH at the same bar: both emitted (different
  setup types).
- Direction sign: +1 → "up", -1 → "dn".
- Sorted by bar_idx ascending.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from pac_classifier.events import extract_events


def _frame(rows: list[dict]) -> pd.DataFrame:
    """Build an enriched-shape DataFrame from a list of per-bar dicts."""
    n = len(rows)
    base = {
        "ts_event": pd.date_range("2024-01-02 09:30", periods=n, freq="1min", tz="UTC"),
        "close": [r.get("close", 100.0) for r in rows],
        "BOS": [r.get("BOS", np.nan) for r in rows],
        "CHOCH": [r.get("CHOCH", np.nan) for r in rows],
        "CHOCHPlus": [r.get("CHOCHPlus", np.nan) for r in rows],
        "atr_14": [r.get("atr_14", 1.0) for r in rows],
    }
    return pd.DataFrame(base)


def test_empty_input_returns_empty_frame_with_schema() -> None:
    df = pd.DataFrame(
        {
            "ts_event": pd.Series([], dtype="datetime64[ns, UTC]"),
            "close": [],
            "BOS": [],
            "CHOCH": [],
            "CHOCHPlus": [],
            "atr_14": [],
        }
    )
    out = extract_events(df)
    assert len(out) == 0
    assert set(out.columns) == {
        "ts_event", "bar_idx", "signal_type",
        "signal_direction", "entry_price", "atr_14",
    }


def test_missing_required_column_raises() -> None:
    bad = pd.DataFrame({"close": [100.0], "BOS": [1.0]})
    with pytest.raises(KeyError):
        extract_events(bad)


def test_bos_up_emits_single_row() -> None:
    df = _frame([
        {},
        {"BOS": 1.0, "close": 105.0, "atr_14": 0.8},
        {},
    ])
    out = extract_events(df)
    assert len(out) == 1
    assert out.iloc[0]["signal_type"] == "BOS"
    assert out.iloc[0]["signal_direction"] == "up"
    assert out.iloc[0]["bar_idx"] == 1
    assert out.iloc[0]["entry_price"] == 105.0
    assert out.iloc[0]["atr_14"] == pytest.approx(0.8)


def test_bos_dn_emits_dn_direction() -> None:
    df = _frame([{"BOS": -1.0, "close": 95.0}])
    out = extract_events(df)
    assert out.iloc[0]["signal_direction"] == "dn"


def test_choch_only_bar() -> None:
    df = _frame([{"CHOCH": 1.0}])
    out = extract_events(df)
    assert len(out) == 1
    assert out.iloc[0]["signal_type"] == "CHOCH"
    assert out.iloc[0]["signal_direction"] == "up"


def test_chochplus_supersedes_choch_at_same_bar() -> None:
    """CHoCHPlus implies CHoCH — emit only the higher tier so the
    dataset doesn't double-count the same setup."""
    df = _frame([{"CHOCH": 1.0, "CHOCHPlus": 1.0}])
    out = extract_events(df)
    assert len(out) == 1
    assert out.iloc[0]["signal_type"] == "CHOCHPLUS"


def test_bos_and_choch_at_same_bar_both_emitted() -> None:
    """BOS and CHoCH are independent setup types — both should fire
    if they happen on the same bar (e.g., a structure flip)."""
    df = _frame([{"BOS": 1.0, "CHOCH": -1.0}])
    out = extract_events(df)
    assert len(out) == 2
    types = sorted(out["signal_type"].tolist())
    assert types == ["BOS", "CHOCH"]


def test_bos_and_chochplus_at_same_bar_both_emitted() -> None:
    df = _frame([{"BOS": 1.0, "CHOCH": 1.0, "CHOCHPlus": 1.0}])
    out = extract_events(df)
    assert len(out) == 2
    types = sorted(out["signal_type"].tolist())
    assert types == ["BOS", "CHOCHPLUS"]


def test_multiple_events_sorted_by_bar_idx() -> None:
    df = _frame([
        {"BOS": 1.0},
        {},
        {"CHOCH": -1.0},
        {"CHOCHPlus": 1.0},
        {"BOS": -1.0},
    ])
    out = extract_events(df)
    assert len(out) == 4
    assert list(out["bar_idx"]) == [0, 2, 3, 4]


def test_nan_signals_are_skipped() -> None:
    df = _frame([{"BOS": np.nan, "CHOCH": np.nan, "CHOCHPlus": np.nan}])
    out = extract_events(df)
    assert len(out) == 0


def test_zero_signals_are_skipped() -> None:
    """smc emits 0 (not NaN) for some no-event bars; both should skip."""
    df = _frame([{"BOS": 0.0, "CHOCH": 0.0, "CHOCHPlus": 0.0}])
    out = extract_events(df)
    assert len(out) == 0
