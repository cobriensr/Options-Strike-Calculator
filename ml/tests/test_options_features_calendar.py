"""Tests for `options_features.calendar`."""

from __future__ import annotations

from datetime import date

import pandas as pd

from options_features.calendar import (
    FOMC_DATES,
    calendar_features,
    is_event_day,
    is_fomc,
    is_opex,
    is_quarterly_opex,
)


class TestIsOpex:
    def test_third_friday_is_opex(self):
        """2024-04-19 was a Friday, day 19 — the third Friday of April 2024."""
        assert is_opex(date(2024, 4, 19)) is True

    def test_third_friday_june_is_opex(self):
        assert is_opex(date(2024, 6, 21)) is True

    def test_second_friday_is_not_opex(self):
        """2024-04-12 was the 2nd Friday — not OPEX."""
        assert is_opex(date(2024, 4, 12)) is False

    def test_fourth_friday_is_not_opex(self):
        """2024-04-26 was the 4th Friday — not OPEX."""
        assert is_opex(date(2024, 4, 26)) is False

    def test_thursday_is_never_opex(self):
        # A Thursday with day-of-month 15-21 still isn't OPEX
        assert is_opex(date(2024, 4, 18)) is False

    def test_day_before_opex_window_not_opex(self):
        """Day 14 of month on a Friday is the 2nd Friday, not third."""
        assert is_opex(date(2024, 6, 14)) is False


class TestIsQuarterlyOpex:
    def test_march_opex_is_quarterly(self):
        assert is_quarterly_opex(date(2024, 3, 15)) is True

    def test_june_opex_is_quarterly(self):
        assert is_quarterly_opex(date(2024, 6, 21)) is True

    def test_september_opex_is_quarterly(self):
        assert is_quarterly_opex(date(2024, 9, 20)) is True

    def test_december_opex_is_quarterly(self):
        assert is_quarterly_opex(date(2024, 12, 20)) is True

    def test_april_opex_is_not_quarterly(self):
        """April is monthly-only, not a quarterly settlement month."""
        assert is_quarterly_opex(date(2024, 4, 19)) is False

    def test_non_opex_never_quarterly(self):
        # Non-OPEX Friday in March cannot be quarterly OPEX
        assert is_quarterly_opex(date(2024, 3, 8)) is False


class TestIsFomc:
    def test_known_fomc_date_2024(self):
        assert is_fomc(date(2024, 12, 18)) is True

    def test_known_fomc_date_2026(self):
        assert is_fomc(date(2026, 3, 18)) is True

    def test_non_fomc_wednesday(self):
        """A random Wednesday that isn't in the FOMC calendar."""
        assert is_fomc(date(2024, 7, 17)) is False

    def test_fomc_dates_cover_2024_2025_2026(self):
        """Sanity: we have ~8 FOMC dates per year."""
        by_year = {}
        for d in FOMC_DATES:
            by_year.setdefault(d.year, []).append(d)
        for year in (2024, 2025, 2026):
            assert year in by_year, f"Missing FOMC dates for {year}"
            assert 7 <= len(by_year[year]) <= 9, (
                f"Expected 7-9 FOMC dates in {year}, got {len(by_year[year])}"
            )


class TestIsEventDay:
    def test_opex_is_event_day(self):
        assert is_event_day(date(2024, 4, 19)) is True

    def test_fomc_is_event_day(self):
        assert is_event_day(date(2024, 12, 18)) is True

    def test_neither_is_not_event_day(self):
        assert is_event_day(date(2024, 4, 10)) is False


class TestCalendarFeatures:
    def test_produces_expected_columns(self):
        """Calendar feature DataFrame must have the schema overlay.py expects."""
        df = calendar_features([pd.Timestamp("2024-04-19")])
        expected = {
            "day",
            "is_opex",
            "is_quarterly_opex",
            "is_fomc",
            "is_event_day",
        }
        assert expected.issubset(set(df.columns))

    def test_row_per_input_date(self):
        dates = [pd.Timestamp(d) for d in ("2024-04-19", "2024-07-17", "2024-12-18")]
        df = calendar_features(dates)
        assert len(df) == 3

    def test_known_multi_day_flags(self):
        """Integration of all calendar logic on a known set of dates."""
        dates = [
            pd.Timestamp("2024-04-19"),  # April monthly OPEX (not quarterly)
            pd.Timestamp("2024-12-18"),  # FOMC, not OPEX
            pd.Timestamp("2024-06-21"),  # Quarterly OPEX (June)
            pd.Timestamp("2024-04-10"),  # Neither
        ]
        df = calendar_features(dates).set_index("day")

        assert bool(df.loc[date(2024, 4, 19), "is_opex"]) is True
        assert bool(df.loc[date(2024, 4, 19), "is_quarterly_opex"]) is False
        assert bool(df.loc[date(2024, 4, 19), "is_event_day"]) is True

        assert bool(df.loc[date(2024, 12, 18), "is_fomc"]) is True
        assert bool(df.loc[date(2024, 12, 18), "is_opex"]) is False
        assert bool(df.loc[date(2024, 12, 18), "is_event_day"]) is True

        assert bool(df.loc[date(2024, 6, 21), "is_quarterly_opex"]) is True

        assert bool(df.loc[date(2024, 4, 10), "is_event_day"]) is False

    def test_accepts_plain_date_objects(self):
        """calendar_features should work on either pd.Timestamp or date inputs."""
        df = calendar_features([date(2024, 4, 19)])
        assert len(df) == 1
        assert bool(df["is_opex"].iloc[0]) is True

    def test_rejects_unsupported_types(self):
        import pytest

        with pytest.raises(TypeError, match="Unsupported date type"):
            calendar_features(["2024-04-19"])  # string, not Timestamp or date
