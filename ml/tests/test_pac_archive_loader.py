"""Tests for `pac.archive_loader`.

These exercise the DuckDB access path against the real local parquet
archive in `ml/data/archive/`. Keeping integration-style rather than
mocked-DuckDB because the value of the tests is catching *schema* or
*partitioning* regressions, which a mock cannot surface.

All tests are skip-on-missing-archive so CI on a fresh clone without
the archive still passes rather than erroring.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from pac.archive_loader import (
    front_month_symbol,
    load_bars,
    reset_connection_for_tests,
)

_ARCHIVE_ROOT = Path(__file__).resolve().parents[1] / "data" / "archive"
_ARCHIVE_MISSING = not (_ARCHIVE_ROOT / "ohlcv_1m").exists()

pytestmark = pytest.mark.skipif(
    _ARCHIVE_MISSING,
    reason=f"Archive not present at {_ARCHIVE_ROOT}; skipping archive-backed tests.",
)


@pytest.fixture(autouse=True)
def _fresh_connection():
    """Drop any cached DuckDB connection between tests."""
    reset_connection_for_tests()
    yield
    reset_connection_for_tests()


def test_front_month_selects_nq_for_early_2024():
    """NQH4 is the March 2024 front-month contract for NQ."""
    assert front_month_symbol("NQ", "2024-01-02") == "NQH4"


def test_front_month_selects_es_for_early_2024():
    assert front_month_symbol("ES", "2024-01-02") == "ESH4"


def test_front_month_returns_none_for_missing_root():
    """Micros (MNQ/MES) are not in this archive; confirm graceful absence."""
    assert front_month_symbol("MNQ", "2024-01-02") is None


def test_load_bars_returns_ohlc_schema():
    """The continuous loader must return a known column set for the PAC engine."""
    df = load_bars("NQ", "2024-01-02", "2024-01-03")
    expected = {"ts_event", "open", "high", "low", "close", "volume", "symbol"}
    assert expected.issubset(set(df.columns)), (
        f"Missing columns: {expected - set(df.columns)}"
    )
    assert len(df) > 0, "Expected non-empty result for a known trading day"


def test_load_bars_continuous_picks_single_symbol_per_day():
    """Continuous mode should pick one front-month per day — no interleaving."""
    df = load_bars("NQ", "2024-01-02", "2024-01-03")
    assert df.symbol.nunique() == 1, (
        f"Expected exactly one symbol on a single day, got {df.symbol.unique().tolist()}"
    )


def test_load_bars_timestamps_are_utc():
    """`SET TimeZone = 'UTC'` must apply — timestamps are UTC-aware."""
    df = load_bars("NQ", "2024-01-02", "2024-01-03")
    assert df.ts_event.dt.tz is not None, "ts_event must be tz-aware"
    # pandas normalizes 'UTC' to 'UTC' object; string repr check is stable
    assert str(df.ts_event.dt.tz) == "UTC"


def test_load_bars_ordered_by_timestamp():
    """ORDER BY ts_event must produce a monotonically non-decreasing series."""
    df = load_bars("NQ", "2024-01-02", "2024-01-03")
    assert df.ts_event.is_monotonic_increasing


def test_load_bars_empty_range_returns_empty_frame():
    """A date range with no bars returns empty DataFrame, not an error."""
    df = load_bars("NQ", "1990-01-01", "1990-01-02")
    assert isinstance(df, pd.DataFrame)
    assert len(df) == 0


def test_load_bars_excludes_options_and_spreads():
    """Outright filter must drop 'ESH4 P4150' (option) and 'ESH4-ESM4' (spread)."""
    df = load_bars("ES", "2024-01-02", "2024-01-03", continuous=False)
    # Any surviving symbol must have no space and no dash
    for sym in df.symbol.unique():
        assert " " not in sym, f"Option leaked through outright filter: {sym}"
        assert "-" not in sym, f"Spread leaked through outright filter: {sym}"


def test_load_bars_covers_journal_date():
    """2026-04-17 must be available — it's the baseline regression target."""
    df = load_bars("NQ", "2026-04-17", "2026-04-18")
    assert len(df) > 0, "Journal regression day 2026-04-17 missing from archive"
    # Journal trades were 08:51 CT onwards; 08:51 CT = 13:51 UTC. Confirm window covered.
    cutoff = pd.Timestamp("2026-04-17 13:51:00+00:00")
    assert (df.ts_event >= cutoff).any(), (
        "Archive is missing 2026-04-17 RTH bars needed for journal regression"
    )
