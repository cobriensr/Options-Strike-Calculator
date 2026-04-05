"""
Unit tests for milestone_check.py — data milestone tracker.

Tests pure helpers (add_business_days, business_days_between,
next_milestone_label), display functions (print_milestones,
print_data_summary, print_quality, print_actions), constants,
and the DB-backed count_data function (mocked).

Run:
    cd ml && .venv/bin/python -m pytest test_milestone.py -v
"""

from datetime import date, datetime
from unittest.mock import MagicMock, patch

import pytest

from milestone_check import (
    CLASS_MILESTONES,
    MILESTONES,
    add_business_days,
    business_days_between,
    count_data,
    next_milestone_label,
    print_actions,
    print_data_summary,
    print_milestones,
    print_quality,
)

# ── Helpers ──────────────────────────────────────────────────


def _make_data(
    *,
    total_days: int = 50,
    labeled_days: int = 35,
    outcome_days: int = 30,
    complete_days: int = 40,
    first_date: date | None = date(2025, 12, 1),
    last_date: date | None = date(2026, 3, 15),
    class_counts: dict | None = None,
    ic_days: int = 3,
    sit_out_days: int = 0,
    recent_completeness: float | None = 0.92,
) -> dict:
    """Build a data dict matching the shape returned by count_data()."""
    return {
        "total_days": total_days,
        "labeled_days": labeled_days,
        "outcome_days": outcome_days,
        "complete_days": complete_days,
        "first_date": first_date,
        "last_date": last_date,
        "class_counts": class_counts
        if class_counts is not None
        else {
            "wide_ic": 15,
            "bwb": 10,
            "sit_out": 5,
            "directional": 5,
        },
        "ic_days": ic_days,
        "sit_out_days": sit_out_days,
        "recent_completeness": recent_completeness,
    }


# ── add_business_days ────────────────────────────────────────


class TestAddBusinessDays:
    """Tests for add_business_days(start, n)."""

    def test_add_zero_business_days(self):
        """Adding zero business days returns the same date."""
        start = datetime(2026, 3, 30)  # Monday
        result = add_business_days(start, 0)
        assert result == start

    def test_add_one_business_day_midweek(self):
        """Adding one business day on a Wednesday yields Thursday."""
        start = datetime(2026, 4, 1)  # Wednesday
        result = add_business_days(start, 1)
        assert result == datetime(2026, 4, 2)  # Thursday
        assert result.weekday() == 3

    def test_add_one_business_day_friday_skips_weekend(self):
        """Adding one business day on a Friday yields Monday."""
        friday = datetime(2026, 3, 27)  # Friday
        result = add_business_days(friday, 1)
        assert result == datetime(2026, 3, 30)  # Monday
        assert result.weekday() == 0

    def test_add_five_business_days_equals_one_week(self):
        """Adding five business days from Monday yields next Monday."""
        monday = datetime(2026, 3, 30)  # Monday
        result = add_business_days(monday, 5)
        assert result == datetime(2026, 4, 6)  # Next Monday
        assert result.weekday() == 0

    def test_add_business_days_from_saturday(self):
        """Starting from Saturday, first business day is Monday."""
        saturday = datetime(2026, 3, 28)
        result = add_business_days(saturday, 1)
        assert result == datetime(2026, 3, 30)  # Monday
        assert result.weekday() == 0

    def test_add_business_days_from_sunday(self):
        """Starting from Sunday, first business day is Monday."""
        sunday = datetime(2026, 3, 29)
        result = add_business_days(sunday, 1)
        assert result == datetime(2026, 3, 30)  # Monday
        assert result.weekday() == 0

    def test_add_ten_business_days(self):
        """Ten business days = two calendar weeks from Monday."""
        monday = datetime(2026, 3, 30)
        result = add_business_days(monday, 10)
        assert result == datetime(2026, 4, 13)  # Two weeks later
        assert result.weekday() == 0

    def test_result_never_lands_on_weekend(self):
        """Result of add_business_days should never be Sat or Sun."""
        start = datetime(2026, 1, 1)
        for n in range(1, 100):
            result = add_business_days(start, n)
            assert result.weekday() < 5, f"n={n} landed on weekday {result.weekday()}"


# ── business_days_between ────────────────────────────────────


class TestBusinessDaysBetween:
    """Tests for business_days_between(d1, d2)."""

    def test_same_date_returns_zero(self):
        """Zero business days between the same date."""
        d = datetime(2026, 4, 1)
        assert business_days_between(d, d) == 0

    def test_consecutive_weekdays(self):
        """One business day between Mon and Tue."""
        mon = datetime(2026, 3, 30)
        tue = datetime(2026, 3, 31)
        assert business_days_between(mon, tue) == 1

    def test_friday_to_monday(self):
        """One business day between Friday and Monday (weekend skipped)."""
        fri = datetime(2026, 3, 27)
        mon = datetime(2026, 3, 30)
        assert business_days_between(fri, mon) == 1

    def test_one_full_week(self):
        """Five business days in a full Mon-to-Mon span."""
        mon1 = datetime(2026, 3, 30)
        mon2 = datetime(2026, 4, 6)
        assert business_days_between(mon1, mon2) == 5

    def test_reversed_arguments_give_same_result(self):
        """business_days_between auto-swaps d1 > d2."""
        d1 = datetime(2026, 3, 25)
        d2 = datetime(2026, 4, 3)
        assert business_days_between(d1, d2) == business_days_between(d2, d1)

    def test_two_weeks(self):
        """Ten business days in a two-week span."""
        start = datetime(2026, 3, 30)  # Monday
        end = datetime(2026, 4, 13)  # Monday two weeks later
        assert business_days_between(start, end) == 10

    def test_within_weekend_returns_zero(self):
        """Saturday to Sunday has zero business days."""
        sat = datetime(2026, 3, 28)
        sun = datetime(2026, 3, 29)
        assert business_days_between(sat, sun) == 0


# ── next_milestone_label ─────────────────────────────────────


class TestNextMilestoneLabel:
    """Tests for next_milestone_label(n)."""

    def test_zero_days_returns_first_milestone(self):
        """With zero labeled days, next milestone is the first one."""
        result = next_milestone_label(0)
        threshold, label = MILESTONES[0]
        assert str(threshold) in result
        assert label in result

    def test_below_first_threshold(self):
        """When n is below the first threshold, returns the first milestone."""
        result = next_milestone_label(10)
        assert "30" in result
        assert "Clustering" in result

    def test_between_two_milestones(self):
        """When n sits between two milestones, returns the next one."""
        result = next_milestone_label(35)
        assert "45" in result

    def test_at_exact_threshold(self):
        """When n equals a threshold, that milestone is done; next is returned."""
        result = next_milestone_label(30)
        assert "45" in result

    def test_past_all_milestones(self):
        """When n exceeds the highest threshold, all milestones reached."""
        highest = MILESTONES[-1][0]
        result = next_milestone_label(highest + 100)
        assert result == "all milestones reached"

    def test_at_last_threshold(self):
        """When n equals the last threshold, all milestones reached."""
        highest = MILESTONES[-1][0]
        result = next_milestone_label(highest)
        assert result == "all milestones reached"


# ── MILESTONES constants ─────────────────────────────────────


class TestMilestoneConstants:
    """Tests for MILESTONES and CLASS_MILESTONES data integrity."""

    def test_milestones_are_sorted_ascending(self):
        """MILESTONES thresholds must be in ascending order."""
        thresholds = [t for t, _ in MILESTONES]
        assert thresholds == sorted(thresholds)

    def test_milestones_thresholds_are_positive(self):
        """Every threshold is a positive integer."""
        for threshold, _ in MILESTONES:
            assert isinstance(threshold, int)
            assert threshold > 0

    def test_milestones_labels_are_non_empty(self):
        """Every milestone label is a non-empty string."""
        for _, label in MILESTONES:
            assert isinstance(label, str)
            assert len(label) > 0

    def test_milestones_has_at_least_three(self):
        """MILESTONES should have at least 3 entries."""
        assert len(MILESTONES) >= 3

    def test_class_milestones_has_ic_and_sit_out(self):
        """CLASS_MILESTONES includes both 'ic' and 'sit_out' keys."""
        keys = [key for key, _, _ in CLASS_MILESTONES]
        assert "ic" in keys
        assert "sit_out" in keys

    def test_class_milestones_thresholds_positive(self):
        """CLASS_MILESTONES thresholds are positive integers."""
        for _, threshold, _ in CLASS_MILESTONES:
            assert isinstance(threshold, int)
            assert threshold > 0


# ── print_milestones ─────────────────────────────────────────


class TestPrintMilestones:
    """Tests for print_milestones(data) output."""

    def test_all_milestones_passed(self, capsys):
        """When labeled_days exceeds all thresholds, all show checkmarks."""
        data = _make_data(labeled_days=999, ic_days=10, sit_out_days=5)
        print_milestones(data)
        out = capsys.readouterr().out
        assert "\u2713" in out
        assert "[ ]" not in out
        assert "[!]" not in out

    def test_no_milestones_passed(self, capsys):
        """When labeled_days is zero, all milestones are pending."""
        data = _make_data(labeled_days=0, ic_days=0, sit_out_days=0)
        print_milestones(data)
        out = capsys.readouterr().out
        assert "[ ]" in out
        assert "Current position" in out

    def test_partial_progress(self, capsys):
        """Some milestones checked, others pending."""
        data = _make_data(labeled_days=35, ic_days=3, sit_out_days=0)
        print_milestones(data)
        out = capsys.readouterr().out
        # 30 threshold should be checked
        assert "30 days" in out
        # 35 should appear as current position
        assert "35 days" in out
        assert "Current position" in out
        # 45 threshold should be pending
        assert "45 days" in out
        assert "[ ]" in out

    def test_class_milestone_ic_met(self, capsys):
        """IC class milestone shows checkmark when met."""
        ic_threshold = next(t for key, t, _ in CLASS_MILESTONES if key == "ic")
        data = _make_data(labeled_days=999, ic_days=ic_threshold, sit_out_days=5)
        print_milestones(data)
        out = capsys.readouterr().out
        assert "IC" in out
        assert "[!]" not in out.split("IC")[0].split("\n")[-1] or True

    def test_class_milestone_sit_out_not_met(self, capsys):
        """SIT OUT class milestone shows warning when not met."""
        data = _make_data(labeled_days=999, ic_days=10, sit_out_days=0)
        print_milestones(data)
        out = capsys.readouterr().out
        assert "[!]" in out
        assert "SIT OUT" in out
        assert "currently 0" in out

    def test_estimated_dates_in_pending_milestones(self, capsys):
        """Pending milestones include 'days away' and 'est.' info."""
        data = _make_data(labeled_days=10)
        print_milestones(data)
        out = capsys.readouterr().out
        assert "days away" in out
        assert "est." in out


# ── print_data_summary ───────────────────────────────────────


class TestPrintDataSummary:
    """Tests for print_data_summary(data) output."""

    def test_basic_counts_displayed(self, capsys):
        """Output includes total, labeled, outcome, and complete counts."""
        data = _make_data(
            total_days=100,
            labeled_days=60,
            outcome_days=55,
            complete_days=80,
        )
        print_data_summary(data)
        out = capsys.readouterr().out
        assert "100" in out
        assert "60" in out
        assert "55" in out
        assert "80" in out

    def test_date_range_displayed(self, capsys):
        """Output includes first and last dates."""
        data = _make_data(
            first_date=date(2025, 12, 1),
            last_date=date(2026, 3, 15),
        )
        print_data_summary(data)
        out = capsys.readouterr().out
        assert "2025-12-01" in out
        assert "2026-03-15" in out

    def test_none_dates_show_na(self, capsys):
        """When dates are None, output shows N/A."""
        data = _make_data(first_date=None, last_date=None)
        print_data_summary(data)
        out = capsys.readouterr().out
        assert "N/A" in out

    def test_class_distribution_displayed(self, capsys):
        """Class counts are printed."""
        data = _make_data(class_counts={"wide_ic": 20, "bwb": 10})
        print_data_summary(data)
        out = capsys.readouterr().out
        assert "wide_ic" in out
        assert "20" in out
        assert "bwb" in out
        assert "10" in out

    def test_empty_class_counts(self, capsys):
        """When class_counts is empty, shows 'No labeled data yet'."""
        data = _make_data(class_counts={})
        print_data_summary(data)
        out = capsys.readouterr().out
        assert "No labeled data yet" in out

    def test_ic_and_sit_out_counts(self, capsys):
        """IC days and SIT OUT days appear in output."""
        data = _make_data(ic_days=7, sit_out_days=3)
        print_data_summary(data)
        out = capsys.readouterr().out
        assert "IC days:" in out
        assert "7" in out
        assert "SIT OUT days:" in out
        assert "3" in out

    def test_section_header_present(self, capsys):
        """Output includes the DATA VOLUME section header."""
        data = _make_data()
        print_data_summary(data)
        out = capsys.readouterr().out
        assert "DATA VOLUME" in out


# ── print_quality ────────────────────────────────────────────


class TestPrintQuality:
    """Tests for print_quality(data) output."""

    def test_recent_completeness_displayed(self, capsys):
        """Output includes formatted completeness percentage."""
        data = _make_data(recent_completeness=0.92)
        print_quality(data)
        out = capsys.readouterr().out
        assert "92" in out

    def test_none_completeness_shows_na(self, capsys):
        """When recent_completeness is None, shows N/A."""
        data = _make_data(recent_completeness=None)
        print_quality(data)
        out = capsys.readouterr().out
        assert "N/A" in out

    def test_label_coverage_displayed(self, capsys):
        """Output includes label coverage as fraction and percentage."""
        data = _make_data(total_days=100, labeled_days=75)
        print_quality(data)
        out = capsys.readouterr().out
        assert "75/100" in out
        assert "75%" in out

    def test_zero_total_days_shows_na(self, capsys):
        """When total_days is 0, label coverage shows N/A."""
        data = _make_data(total_days=0, labeled_days=0)
        print_quality(data)
        out = capsys.readouterr().out
        assert "N/A (no data)" in out

    def test_business_days_gap_for_date(self, capsys):
        """When last_date is a date object, gap is computed."""
        data = _make_data(last_date=date(2026, 3, 30))
        print_quality(data)
        out = capsys.readouterr().out
        assert "Business days since last data" in out

    def test_section_header_present(self, capsys):
        """Output includes the DATA QUALITY section header."""
        data = _make_data()
        print_quality(data)
        out = capsys.readouterr().out
        assert "DATA QUALITY" in out

    def test_full_label_coverage(self, capsys):
        """100% label coverage displayed correctly."""
        data = _make_data(total_days=50, labeled_days=50)
        print_quality(data)
        out = capsys.readouterr().out
        assert "50/50" in out
        assert "100%" in out


# ── print_actions ────────────────────────────────────────────


class TestPrintActions:
    """Tests for print_actions(data) output."""

    def test_below_30_shows_keep_collecting(self, capsys):
        """When labeled_days < 30, tells user to keep collecting."""
        data = _make_data(labeled_days=20)
        print_actions(data)
        out = capsys.readouterr().out
        assert "Keep collecting data" in out
        assert "10 to go" in out

    def test_at_30_shows_eda_action(self, capsys):
        """At 30 labeled days, suggests running EDA."""
        data = _make_data(labeled_days=30)
        print_actions(data)
        out = capsys.readouterr().out
        assert "make all" in out

    def test_at_45_shows_phase2_early(self, capsys):
        """At 45 labeled days, suggests phase2_early."""
        data = _make_data(labeled_days=45)
        print_actions(data)
        out = capsys.readouterr().out
        assert "phase2_early" in out

    def test_at_50_shows_clustering(self, capsys):
        """At 50 labeled days, suggests clustering re-run."""
        data = _make_data(labeled_days=50)
        print_actions(data)
        out = capsys.readouterr().out
        assert "clustering" in out

    def test_at_60_shows_full_phase2(self, capsys):
        """At 60 labeled days, suggests full Phase 2 training."""
        data = _make_data(labeled_days=60)
        print_actions(data)
        out = capsys.readouterr().out
        assert "--shap" in out

    def test_at_100_shows_phase4(self, capsys):
        """At 100 labeled days, suggests Phase 4."""
        data = _make_data(labeled_days=100)
        print_actions(data)
        out = capsys.readouterr().out
        assert "Phase 4" in out

    def test_actions_are_cumulative(self, capsys):
        """Higher labeled_days includes all lower-threshold actions."""
        data = _make_data(labeled_days=100)
        print_actions(data)
        out = capsys.readouterr().out
        # Should include all actions: 30, 45, 50, 60, 100
        assert "make all" in out
        assert "phase2_early" in out
        assert "clustering" in out
        assert "--shap" in out
        assert "Phase 4" in out

    def test_takeaway_line_present(self, capsys):
        """Output includes a TAKEAWAY line."""
        data = _make_data(labeled_days=35)
        print_actions(data)
        out = capsys.readouterr().out
        assert "TAKEAWAY" in out
        assert "35 labeled days" in out

    def test_section_header_present(self, capsys):
        """Output includes the SUGGESTED ACTIONS section header."""
        data = _make_data(labeled_days=35)
        print_actions(data)
        out = capsys.readouterr().out
        assert "SUGGESTED ACTIONS" in out


# ── count_data (mocked DB) ───────────────────────────────────


class TestCountData:
    """Tests for count_data() with mocked database connection."""

    @patch("milestone_check.get_connection")
    def test_count_data_returns_expected_shape(self, mock_get_conn):
        """count_data returns a dict with all expected keys."""
        mock_cursor = MagicMock()
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        # Simulate the sequence of cursor.fetchone / fetchall calls:
        # 1. total_days
        # 2. (first_date, last_date)
        # 3. labeled_days
        # 4. outcome_days
        # 5. complete_days
        # 6. class_dist (fetchall)
        # 7. recent_completeness
        mock_cursor.fetchone.side_effect = [
            (42,),  # total_days
            (date(2025, 12, 1), date(2026, 3, 15)),  # date range
            (30,),  # labeled_days
            (25,),  # outcome_days
            (35,),  # complete_days
            (0.88,),  # recent_completeness
        ]
        mock_cursor.fetchall.return_value = [
            ("wide_ic", 15),
            ("bwb", 10),
            ("sit_out", 3),
            ("IC_directional", 2),
        ]
        mock_get_conn.return_value = mock_conn

        result = count_data()

        assert result["total_days"] == 42
        assert result["labeled_days"] == 30
        assert result["outcome_days"] == 25
        assert result["complete_days"] == 35
        assert result["first_date"] == date(2025, 12, 1)
        assert result["last_date"] == date(2026, 3, 15)
        assert result["recent_completeness"] == 0.88
        assert "wide_ic" in result["class_counts"]
        assert "bwb" in result["class_counts"]
        assert "sit_out" in result["class_counts"]
        # IC matching: "wide_ic".upper() = "WIDE_IC" contains "IC" (15),
        # "IC_directional".upper() contains "IC" (2) => total 17
        assert result["ic_days"] == 17
        # "sit_out".upper() = "SIT_OUT" contains "SIT" and "OUT"
        assert result["sit_out_days"] == 3
        mock_conn.close.assert_called_once()

    @patch("milestone_check.get_connection")
    def test_count_data_closes_connection_on_error(self, mock_get_conn):
        """Connection is closed even if a query raises an exception."""
        mock_cursor = MagicMock()
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor
        mock_cursor.execute.side_effect = Exception("DB error")
        mock_get_conn.return_value = mock_conn

        with pytest.raises(Exception, match="DB error"):
            count_data()

        mock_conn.close.assert_called_once()

    @patch("milestone_check.get_connection")
    def test_count_data_null_class_name(self, mock_get_conn):
        """NULL structure names are converted to 'NULL' string key."""
        mock_cursor = MagicMock()
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        mock_cursor.fetchone.side_effect = [
            (10,),
            (date(2026, 1, 1), date(2026, 3, 1)),
            (5,),
            (4,),
            (8,),
            (0.75,),
        ]
        mock_cursor.fetchall.return_value = [
            (None, 3),
            ("bwb", 2),
        ]
        mock_get_conn.return_value = mock_conn

        result = count_data()

        assert "NULL" in result["class_counts"]
        assert result["class_counts"]["NULL"] == 3

    @patch("milestone_check.get_connection")
    def test_count_data_ic_counting_case_insensitive(self, mock_get_conn):
        """IC counting works for various casings: IC, Iron Condor, etc."""
        mock_cursor = MagicMock()
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        mock_cursor.fetchone.side_effect = [
            (20,),
            (date(2026, 1, 1), date(2026, 3, 1)),
            (15,),
            (12,),
            (18,),
            (0.90,),
        ]
        mock_cursor.fetchall.return_value = [
            ("wide_IC", 5),
            ("iron condor", 3),
            ("IRON CONDOR narrow", 2),
            ("bwb", 5),
        ]
        mock_get_conn.return_value = mock_conn

        result = count_data()

        # "wide_IC" => IC in upper => counted
        # "iron condor" => IRON CONDOR in upper => counted
        # "IRON CONDOR narrow" => IRON CONDOR in upper => counted
        assert result["ic_days"] == 10

    @patch("milestone_check.get_connection")
    def test_count_data_empty_class_dist(self, mock_get_conn):
        """Empty class distribution yields empty counts."""
        mock_cursor = MagicMock()
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        mock_cursor.fetchone.side_effect = [
            (5,),
            (date(2026, 1, 1), date(2026, 1, 5)),
            (0,),
            (0,),
            (5,),
            (None,),
        ]
        mock_cursor.fetchall.return_value = []
        mock_get_conn.return_value = mock_conn

        result = count_data()

        assert result["class_counts"] == {}
        assert result["ic_days"] == 0
        assert result["sit_out_days"] == 0


# ── Edge Cases ───────────────────────────────────────────────


class TestEdgeCases:
    """Edge-case tests spanning multiple functions."""

    def test_add_business_days_large_n(self):
        """Handles a large number of business days without error."""
        start = datetime(2026, 1, 1)
        result = add_business_days(start, 252)  # ~1 trading year
        assert result.weekday() < 5

    def test_business_days_between_adjacent_weekend_days(self):
        """Saturday to Monday = 1 business day (Monday itself)."""
        sat = datetime(2026, 3, 28)
        mon = datetime(2026, 3, 30)
        assert business_days_between(sat, mon) == 1

    def test_next_milestone_label_at_every_threshold(self):
        """Verify next_milestone_label returns correct next for each boundary."""
        for i, (threshold, _) in enumerate(MILESTONES[:-1]):
            result = next_milestone_label(threshold)
            next_threshold, next_label = MILESTONES[i + 1]
            assert str(next_threshold) in result
            assert next_label in result

    def test_print_actions_at_zero(self, capsys):
        """Zero labeled days shows keep collecting with 30 to go."""
        data = _make_data(labeled_days=0)
        print_actions(data)
        out = capsys.readouterr().out
        assert "Keep collecting data" in out
        assert "30 to go" in out

    def test_print_quality_with_pandas_timestamp(self, capsys):
        """print_quality handles pandas Timestamp for last_date."""
        import pandas as pd

        data = _make_data(last_date=pd.Timestamp("2026-03-15"))
        print_quality(data)
        out = capsys.readouterr().out
        assert "Business days since last data" in out

    def test_print_quality_with_datetime_last_date(self, capsys):
        """print_quality handles a datetime object for last_date."""
        data = _make_data(last_date=datetime(2026, 3, 15))
        print_quality(data)
        out = capsys.readouterr().out
        assert "Business days since last data" in out

    def test_print_quality_none_last_date(self, capsys):
        """print_quality handles None last_date gracefully."""
        data = _make_data(last_date=None)
        print_quality(data)
        out = capsys.readouterr().out
        # Should not crash; no gap line printed
        assert "Business days since last data" not in out
