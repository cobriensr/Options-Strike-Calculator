"""Tests for `pac.structure.tag_choch_plus`.

Two layers of coverage:

1. **Synthetic fixtures** — hand-constructed `swing_highs_lows` and
   `bos_choch` frames that deterministically exercise the CHoCH+
   promotion logic. Each test targets a specific branch (bullish
   promoted, bearish promoted, plain CHoCH not promoted, edge cases).

2. **Integration against real NQ data** — run the full pipeline on
   2026-04-17 NQ bars and assert invariants that must hold for *any*
   correct implementation (e.g., CHoCH+ count ≤ total CHoCH count).
   Skipped when the local archive is absent.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from pac.structure import describe_structure_events, tag_choch_plus


def _make_shl(pattern: list[tuple[int, int | None, float]]) -> pd.DataFrame:
    """Build a swing_highs_lows frame from (bar_idx, hl, level) tuples.

    hl=None means "not a swing bar at this index". Fills intervening bars
    with NaN. The largest bar_idx determines the frame length.
    """
    n_bars = pattern[-1][0] + 1
    hl = np.full(n_bars, np.nan)
    lv = np.full(n_bars, np.nan)
    for idx, kind, level in pattern:
        if kind is not None:
            hl[idx] = float(kind)
            lv[idx] = level
    return pd.DataFrame({"HighLow": hl, "Level": lv})


def _make_bc(n_bars: int, choch_at: dict[int, int]) -> pd.DataFrame:
    """Build a bos_choch frame with CHoCH events at specified bar indices.

    `choch_at` maps bar_idx -> +/-1 (direction).
    """
    bos = np.full(n_bars, np.nan)
    ch = np.full(n_bars, np.nan)
    lv = np.full(n_bars, np.nan)
    br = np.full(n_bars, np.nan)
    for idx, direction in choch_at.items():
        ch[idx] = float(direction)
    return pd.DataFrame({"BOS": bos, "CHOCH": ch, "Level": lv, "BrokenIndex": br})


class TestTagChochPlus:
    """Synthetic fixtures targeting the CHoCH+ promotion branches."""

    def test_bearish_choch_plus_promoted_on_failed_higher_high(self):
        """Two HHs where 2nd < 1st should trigger a CHoCH+ on subsequent bear CHoCH."""
        # Sequence: HH@100, LL@90, HH@99 (failed HH — second lower), LL@85, CHoCH at 20
        shl = _make_shl(
            [
                (0, 1, 100.0),
                (5, -1, 90.0),
                (10, 1, 99.0),  # failed HH — lower than first
                (15, -1, 85.0),
                (20, None, 0.0),
            ]
        )
        bc = _make_bc(21, {20: -1})
        result = tag_choch_plus(shl, bc, lookback_swings=10)
        assert result.iloc[20] == -1, "Expected CHoCH+ bearish on failed HH"

    def test_plain_bearish_choch_without_failed_hh(self):
        """Ascending HHs (no failure) should leave the CHoCH as plain, not +."""
        shl = _make_shl(
            [
                (0, 1, 100.0),
                (5, -1, 90.0),
                (10, 1, 110.0),  # healthy HH, higher than first
                (15, -1, 85.0),
                (20, None, 0.0),
            ]
        )
        bc = _make_bc(21, {20: -1})
        result = tag_choch_plus(shl, bc, lookback_swings=10)
        assert result.iloc[20] == 0, "Expected plain CHoCH when HHs are ascending"

    def test_bullish_choch_plus_promoted_on_failed_lower_low(self):
        """Two LLs where 2nd > 1st should trigger a CHoCH+ on subsequent bull CHoCH."""
        shl = _make_shl(
            [
                (0, -1, 80.0),
                (5, 1, 90.0),
                (10, -1, 82.0),  # failed LL — higher than first
                (15, 1, 95.0),
                (20, None, 0.0),
            ]
        )
        bc = _make_bc(21, {20: 1})
        result = tag_choch_plus(shl, bc, lookback_swings=10)
        assert result.iloc[20] == 1, "Expected CHoCH+ bullish on failed LL"

    def test_plain_bullish_choch_without_failed_ll(self):
        """Descending LLs (no failure) should leave the CHoCH as plain."""
        shl = _make_shl(
            [
                (0, -1, 80.0),
                (5, 1, 90.0),
                (10, -1, 75.0),  # healthy LL, lower than first
                (15, 1, 95.0),
                (20, None, 0.0),
            ]
        )
        bc = _make_bc(21, {20: 1})
        result = tag_choch_plus(shl, bc, lookback_swings=10)
        assert result.iloc[20] == 0, "Expected plain CHoCH when LLs are descending"

    def test_lookback_window_excludes_old_failed_extremes(self):
        """A failed HH outside the lookback window should NOT promote the CHoCH."""
        shl = _make_shl(
            [
                (0, 1, 100.0),
                (5, 1, 99.0),  # failed HH — but far back
                (10, 1, 110.0),
                (15, -1, 90.0),
                (20, 1, 115.0),
                (25, -1, 85.0),
                (30, 1, 120.0),
                (35, -1, 80.0),
                (40, None, 0.0),
            ]
        )
        bc = _make_bc(41, {40: -1})
        # With lookback=4 the early failed HH is out of scope
        result = tag_choch_plus(shl, bc, lookback_swings=4)
        assert result.iloc[40] == 0, "Expected plain CHoCH when failed HH is outside lookback"

    def test_no_choch_events_returns_all_zeros(self):
        shl = _make_shl([(0, 1, 100.0), (5, -1, 90.0), (10, None, 0.0)])
        bc = _make_bc(11, {})
        result = tag_choch_plus(shl, bc)
        assert (result == 0).all()

    def test_invalid_lookback_raises(self):
        shl = _make_shl([(0, 1, 100.0)])
        bc = _make_bc(1, {})
        with pytest.raises(ValueError, match="lookback_swings"):
            tag_choch_plus(shl, bc, lookback_swings=1)

    def test_missing_column_raises(self):
        shl = pd.DataFrame({"HighLow": [np.nan]})  # missing 'Level'
        bc = _make_bc(1, {})
        with pytest.raises(KeyError, match="Level"):
            tag_choch_plus(shl, bc)

    def test_output_length_matches_input(self):
        """Invariant: output Series length == input bos_choch length."""
        shl = _make_shl([(0, 1, 100.0), (5, -1, 90.0), (20, None, 0.0)])
        bc = _make_bc(21, {20: -1})
        result = tag_choch_plus(shl, bc)
        assert len(result) == 21


_ARCHIVE_ROOT = Path(__file__).resolve().parents[1] / "data" / "archive"
_ARCHIVE_MISSING = not (_ARCHIVE_ROOT / "ohlcv_1m").exists()


@pytest.mark.skipif(_ARCHIVE_MISSING, reason="Archive not present")
class TestTagChochPlusIntegration:
    """Invariants that must hold on real data."""

    @pytest.fixture(scope="class")
    def journal_day_enriched(self):
        """Load 2026-04-17 NQ and run the full pipeline."""
        import os

        os.environ.setdefault("SMC_CREDIT", "0")
        from pac.archive_loader import load_bars, reset_connection_for_tests
        from pac.engine import PACEngine, PACParams

        reset_connection_for_tests()
        df = load_bars("NQ", "2026-04-17", "2026-04-18")
        return PACEngine(PACParams(swing_length=5)).batch_state(df)

    def test_choch_plus_count_bounded_by_choch_count(self, journal_day_enriched):
        """CHoCH+ is a subset of CHoCH — |CHoCH+| ≤ |CHoCH|."""
        total_choch = int((journal_day_enriched["CHOCH"].abs() == 1).sum())
        total_plus = int((journal_day_enriched["CHOCHPlus"].abs() == 1).sum())
        assert total_plus <= total_choch, (
            f"CHoCH+ ({total_plus}) cannot exceed CHoCH ({total_choch})"
        )

    def test_choch_plus_direction_matches_choch(self, journal_day_enriched):
        """Every CHoCH+ tag must match the sign of the underlying CHoCH."""
        enriched = journal_day_enriched
        plus_rows = enriched[enriched["CHOCHPlus"].abs() == 1]
        for _, row in plus_rows.iterrows():
            assert row["CHOCH"] == row["CHOCHPlus"], (
                f"CHoCH+ direction mismatch at {row['ts_event']}: "
                f"CHOCH={row['CHOCH']} vs CHOCHPlus={row['CHOCHPlus']}"
            )

    def test_choch_plus_only_fires_where_choch_fires(self, journal_day_enriched):
        """CHoCH+ must be 0 on every bar where CHoCH is 0 or NaN."""
        enriched = journal_day_enriched
        no_choch = enriched[
            enriched["CHOCH"].isna() | (enriched["CHOCH"] == 0)
        ]
        assert (no_choch["CHOCHPlus"] == 0).all(), (
            "CHoCH+ fired on a bar with no underlying CHoCH"
        )


class TestDescribeStructureEvents:
    def test_emits_row_per_event(self):
        """Every swing / BOS / CHoCH bar should produce a row in the events frame."""
        shl = _make_shl(
            [
                (0, 1, 100.0),
                (5, -1, 90.0),
                (10, 1, 110.0),
                (15, -1, 85.0),
                (20, None, 0.0),
            ]
        )
        bc = _make_bc(21, {20: -1})
        cp = tag_choch_plus(shl, bc, lookback_swings=10)
        events = describe_structure_events(shl, bc, cp)

        # 4 swings + 1 CHoCH = 5 events
        assert len(events) == 5
        assert "HH" in events["event"].values
        assert "LL" in events["event"].values
        assert "CHOCH_dn" in events["event"].values or "CHOCH+_dn" in events["event"].values
