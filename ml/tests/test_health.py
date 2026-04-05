"""
Unit tests for ml/health.py — Pipeline Health Monitor.

Covers pure date helpers, DB-dependent check functions (mocked),
and the summary printer.

Run:
    cd ml && .venv/bin/python -m pytest test_health.py -v
"""

from datetime import datetime
from unittest.mock import MagicMock, patch

import numpy as np
import pandas as pd
import pytest

import health
from health import (
    business_days_between,
    check_column_coverage,
    check_completeness,
    check_freshness,
    check_labels,
    check_stationarity,
    most_recent_business_day,
    print_summary,
)

# ── Helpers ───────────────────────────────────────────────────


def _make_date_df(dates: list[datetime]) -> pd.DataFrame:
    """Build a date-indexed DataFrame matching load_data's return shape.

    load_data('SELECT date FROM ...') returns a DataFrame with the date
    column consumed as the index.  We keep a dummy '_' column so that
    df.empty correctly reflects whether rows exist.
    """
    df = pd.DataFrame({"date": dates, "_": 1})
    df["date"] = pd.to_datetime(df["date"])
    return df.set_index("date").sort_index()


def _make_features_df(
    n: int = 10,
    completeness: float = 0.95,
    start: str = "2026-03-15",
) -> pd.DataFrame:
    """Build a training_features-like DataFrame with configurable completeness."""
    dates = pd.bdate_range(start, periods=n)
    rng = np.random.default_rng(42)
    return pd.DataFrame(
        {
            "feature_completeness": [completeness] * n,
            "vix": rng.uniform(12, 30, n),
            "gex_oi_t1": rng.uniform(-5e10, 5e10, n),
            "flow_agreement_t1": rng.uniform(-1, 1, n),
            "charm_pattern": rng.choice(["all_negative", "all_positive", "mixed"], n),
            "prev_day_range_pts": rng.uniform(5, 80, n),
            "realized_vol_5d": rng.uniform(5, 40, n),
            "dp_total_premium": rng.uniform(1e6, 5e7, n),
            "dp_support_resistance_ratio": rng.uniform(0.5, 2.0, n),
            "opt_vol_pcr": rng.uniform(0.5, 1.5, n),
            "iv_open": rng.uniform(10, 40, n),
            "max_pain_dist": rng.uniform(-20, 20, n),
        },
        index=dates,
    )


# ── most_recent_business_day ─────────────────────────────────


class TestMostRecentBusinessDay:
    """Tests for the most_recent_business_day helper."""

    def test_returns_weekday_on_monday(self):
        """Monday should return Monday itself (weekday 0)."""
        # 2026-03-30 is a Monday
        with patch("health.datetime") as mock_dt:
            mock_dt.now.return_value = datetime(2026, 3, 30, 14, 30)
            mock_dt.side_effect = lambda *a, **kw: datetime(*a, **kw)
            mock_dt.min = datetime.min
            result = most_recent_business_day()
        assert result.weekday() == 0  # Monday
        assert result == datetime(2026, 3, 30)

    def test_returns_weekday_on_friday(self):
        """Friday should return Friday itself (weekday 4)."""
        with patch("health.datetime") as mock_dt:
            mock_dt.now.return_value = datetime(2026, 3, 27, 10, 0)
            mock_dt.side_effect = lambda *a, **kw: datetime(*a, **kw)
            mock_dt.min = datetime.min
            result = most_recent_business_day()
        assert result.weekday() == 4  # Friday
        assert result == datetime(2026, 3, 27)

    def test_saturday_returns_friday(self):
        """Saturday should return the preceding Friday."""
        with patch("health.datetime") as mock_dt:
            mock_dt.now.return_value = datetime(2026, 3, 28, 9, 0)
            mock_dt.side_effect = lambda *a, **kw: datetime(*a, **kw)
            mock_dt.min = datetime.min
            result = most_recent_business_day()
        assert result.weekday() == 4  # Friday
        assert result == datetime(2026, 3, 27)

    def test_sunday_returns_friday(self):
        """Sunday should return the preceding Friday."""
        with patch("health.datetime") as mock_dt:
            mock_dt.now.return_value = datetime(2026, 3, 29, 9, 0)
            mock_dt.side_effect = lambda *a, **kw: datetime(*a, **kw)
            mock_dt.min = datetime.min
            result = most_recent_business_day()
        assert result.weekday() == 4  # Friday
        assert result == datetime(2026, 3, 27)

    def test_result_has_zeroed_time(self):
        """Returned datetime should have hour/minute/second/microsecond = 0."""
        with patch("health.datetime") as mock_dt:
            mock_dt.now.return_value = datetime(2026, 3, 30, 15, 45, 12, 999)
            mock_dt.side_effect = lambda *a, **kw: datetime(*a, **kw)
            mock_dt.min = datetime.min
            result = most_recent_business_day()
        assert result.hour == 0
        assert result.minute == 0
        assert result.second == 0
        assert result.microsecond == 0

    def test_wednesday_returns_wednesday(self):
        """Mid-week day should return itself."""
        with patch("health.datetime") as mock_dt:
            mock_dt.now.return_value = datetime(2026, 4, 1, 12, 0)
            mock_dt.side_effect = lambda *a, **kw: datetime(*a, **kw)
            mock_dt.min = datetime.min
            result = most_recent_business_day()
        assert result.weekday() == 2  # Wednesday
        assert result == datetime(2026, 4, 1)


# ── business_days_between ─────────────────────────────────────


class TestBusinessDaysBetween:
    """Tests for the business_days_between helper."""

    def test_same_day_returns_zero(self):
        """Two identical dates should have zero business days between them."""
        d = datetime(2026, 3, 30)  # Monday
        assert business_days_between(d, d) == 0

    def test_consecutive_weekdays(self):
        """Monday to Tuesday should be 1 business day."""
        d1 = datetime(2026, 3, 30)  # Monday
        d2 = datetime(2026, 3, 31)  # Tuesday
        assert business_days_between(d1, d2) == 1

    def test_friday_to_monday(self):
        """Friday to Monday spans a weekend: 1 business day."""
        d1 = datetime(2026, 3, 27)  # Friday
        d2 = datetime(2026, 3, 30)  # Monday
        assert business_days_between(d1, d2) == 1

    def test_full_week(self):
        """Monday to Friday of the same week: 4 business days."""
        d1 = datetime(2026, 3, 30)  # Monday
        d2 = datetime(2026, 4, 3)  # Friday
        assert business_days_between(d1, d2) == 4

    def test_two_weeks(self):
        """Monday to Monday (next week): 5 business days."""
        d1 = datetime(2026, 3, 30)  # Monday
        d2 = datetime(2026, 4, 6)  # Monday (next week)
        assert business_days_between(d1, d2) == 5

    def test_swapped_order(self):
        """Reversed dates should give the same result (auto-swap)."""
        d1 = datetime(2026, 3, 30)
        d2 = datetime(2026, 4, 3)
        assert business_days_between(d2, d1) == business_days_between(d1, d2)

    def test_weekend_to_weekend(self):
        """Saturday to Sunday: zero business days."""
        d1 = datetime(2026, 3, 28)  # Saturday
        d2 = datetime(2026, 3, 29)  # Sunday
        assert business_days_between(d1, d2) == 0

    def test_saturday_to_monday(self):
        """Saturday to Monday: 1 business day (Monday)."""
        d1 = datetime(2026, 3, 28)  # Saturday
        d2 = datetime(2026, 3, 30)  # Monday
        assert business_days_between(d1, d2) == 1


# ── check_freshness ───────────────────────────────────────────


class TestCheckFreshness:
    """Tests for check_freshness with mocked load_data."""

    @patch("health.most_recent_business_day")
    @patch("health.load_data")
    def test_fresh_data_no_warnings(self, mock_load, mock_bday, capsys):
        """When all tables have today's data, no warnings or failures."""
        target = datetime(2026, 3, 30)
        mock_bday.return_value = target

        # Each table returns a row dated today
        fresh_df = _make_date_df([target])
        mock_load.return_value = fresh_df

        warnings: list[str] = []
        failures: list[str] = []
        check_freshness(warnings, failures)

        assert len(warnings) == 0
        assert len(failures) == 0

    @patch("health.most_recent_business_day")
    @patch("health.load_data")
    def test_stale_data_produces_warning(self, mock_load, mock_bday, capsys):
        """When a table is >1 business day old, a warning should be added."""
        target = datetime(2026, 3, 30)  # Monday
        mock_bday.return_value = target

        # Data is from the prior Wednesday (3+ business days stale)
        stale_df = _make_date_df([datetime(2026, 3, 25)])
        mock_load.return_value = stale_df

        warnings: list[str] = []
        failures: list[str] = []
        check_freshness(warnings, failures)

        assert len(warnings) == 3  # one per table
        assert all("stale" in w for w in warnings)

    @patch("health.most_recent_business_day")
    @patch("health.load_data")
    def test_empty_table_produces_failure(self, mock_load, mock_bday, capsys):
        """An empty table should produce a failure."""
        mock_bday.return_value = datetime(2026, 3, 30)

        empty_df = pd.DataFrame(columns=["date"]).set_index(
            pd.DatetimeIndex([], name="date")
        )
        mock_load.return_value = empty_df

        warnings: list[str] = []
        failures: list[str] = []
        check_freshness(warnings, failures)

        assert len(failures) == 3  # one per table
        assert all("no rows" in f for f in failures)

    @patch("health.most_recent_business_day")
    @patch("health.load_data")
    def test_query_failure_produces_failure(self, mock_load, mock_bday, capsys):
        """When load_data raises SystemExit, a failure should be recorded."""
        mock_bday.return_value = datetime(2026, 3, 30)
        mock_load.side_effect = SystemExit(1)

        warnings: list[str] = []
        failures: list[str] = []
        check_freshness(warnings, failures)

        assert len(failures) == 3
        assert all("missing" in f or "failed" in f for f in failures)

    @patch("health.most_recent_business_day")
    @patch("health.load_data")
    def test_one_day_gap_is_within_threshold(self, mock_load, mock_bday, capsys):
        """A 1 business day gap should be within the max_gap=1 threshold."""
        target = datetime(2026, 3, 31)  # Tuesday
        mock_bday.return_value = target

        # Data from Monday (1 business day gap)
        yesterday_df = _make_date_df([datetime(2026, 3, 30)])
        mock_load.return_value = yesterday_df

        warnings: list[str] = []
        failures: list[str] = []
        check_freshness(warnings, failures)

        assert len(warnings) == 0
        assert len(failures) == 0

    @patch("health.most_recent_business_day")
    @patch("health.load_data")
    def test_date_object_index(self, mock_load, mock_bday, capsys):
        """Should handle date objects (not Timestamps) in the index."""
        from datetime import date

        target = datetime(2026, 3, 30)
        mock_bday.return_value = target

        # Create DataFrame with date objects instead of Timestamps
        df = pd.DataFrame({"val": [1]}, index=[date(2026, 3, 30)])
        df.index.name = "date"
        mock_load.return_value = df

        warnings: list[str] = []
        failures: list[str] = []
        check_freshness(warnings, failures)

        assert len(failures) == 0


# ── check_completeness ────────────────────────────────────────


class TestCheckCompleteness:
    """Tests for check_completeness with mocked load_data."""

    @patch("health.load_data")
    def test_high_completeness_no_warnings(self, mock_load, capsys):
        """All days at 95% completeness should produce no warnings."""
        df = _make_features_df(n=10, completeness=0.95)
        mock_load.return_value = df

        warnings: list[str] = []
        failures: list[str] = []
        check_completeness(warnings, failures)

        assert len(warnings) == 0

    @patch("health.load_data")
    def test_low_completeness_produces_warning(self, mock_load, capsys):
        """Days below 90% should trigger a low-completeness warning."""
        df = _make_features_df(n=10, completeness=0.80)
        mock_load.return_value = df

        warnings: list[str] = []
        failures: list[str] = []
        check_completeness(warnings, failures)

        low_warnings = [w for w in warnings if "below 90%" in w]
        assert len(low_warnings) >= 1

    @patch("health.load_data")
    def test_trending_down_produces_warning(self, mock_load, capsys):
        """A declining completeness trend should produce a warning."""
        df = _make_features_df(n=10, completeness=0.95)
        # Make last 5 days worse than first 5
        df.iloc[:5, df.columns.get_loc("feature_completeness")] = 0.98
        df.iloc[5:, df.columns.get_loc("feature_completeness")] = 0.92
        mock_load.return_value = df

        warnings: list[str] = []
        failures: list[str] = []
        check_completeness(warnings, failures)

        trend_warnings = [w for w in warnings if "trending down" in w]
        assert len(trend_warnings) == 1

    @patch("health.load_data")
    def test_trending_up_no_trend_warning(self, mock_load, capsys):
        """An improving completeness trend should not trigger a trend warning."""
        df = _make_features_df(n=10, completeness=0.95)
        df.iloc[:5, df.columns.get_loc("feature_completeness")] = 0.91
        df.iloc[5:, df.columns.get_loc("feature_completeness")] = 0.97
        mock_load.return_value = df

        warnings: list[str] = []
        failures: list[str] = []
        check_completeness(warnings, failures)

        trend_warnings = [w for w in warnings if "trending down" in w]
        assert len(trend_warnings) == 0

    @patch("health.load_data")
    def test_insufficient_rows_produces_warning(self, mock_load, capsys):
        """Fewer than 2 rows should produce an insufficient-data warning."""
        df = _make_features_df(n=1, completeness=0.95)
        mock_load.return_value = df

        warnings: list[str] = []
        failures: list[str] = []
        check_completeness(warnings, failures)

        assert len(warnings) == 1
        assert "Not enough" in warnings[0]

    @patch("health.load_data")
    def test_fewer_than_10_rows_skips_trend(self, mock_load, capsys):
        """With < 10 rows, trend check should be skipped (no trend warning)."""
        df = _make_features_df(n=5, completeness=0.95)
        mock_load.return_value = df

        warnings: list[str] = []
        failures: list[str] = []
        check_completeness(warnings, failures)

        trend_warnings = [w for w in warnings if "trending" in w]
        assert len(trend_warnings) == 0

        captured = capsys.readouterr()
        assert "Only 5 days" in captured.out

    @patch("health.load_data")
    def test_prints_low_flag_for_sub_90(self, mock_load, capsys):
        """Days below 90% should print the '<< LOW' flag."""
        df = _make_features_df(n=3, completeness=0.85)
        mock_load.return_value = df

        warnings: list[str] = []
        failures: list[str] = []
        check_completeness(warnings, failures)

        captured = capsys.readouterr()
        assert "<< LOW" in captured.out


# ── check_labels ──────────────────────────────────────────────


class TestCheckLabels:
    """Tests for check_labels with mocked get_connection."""

    def _make_mock_conn(
        self,
        total_features: int,
        total_labels: int,
        recent_features: int,
        recent_labels: int,
    ) -> MagicMock:
        """Build a mock connection that returns the given counts."""
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        # fetchone is called 4 times in sequence
        mock_cursor.fetchone.side_effect = [
            (total_features,),
            (total_labels,),
            (recent_features,),
            (recent_labels,),
        ]
        return mock_conn

    @patch("health.get_connection")
    def test_good_coverage_no_warnings(self, mock_get_conn, capsys):
        """When recent coverage >= overall, no warnings."""
        mock_get_conn.return_value = self._make_mock_conn(
            total_features=100,
            total_labels=90,
            recent_features=5,
            recent_labels=5,
        )

        warnings: list[str] = []
        failures: list[str] = []
        check_labels(warnings, failures)

        assert len(warnings) == 0
        assert len(failures) == 0
        captured = capsys.readouterr()
        assert "on par" in captured.out

    @patch("health.get_connection")
    def test_low_recent_coverage_warns(self, mock_get_conn, capsys):
        """When recent label coverage < overall, a warning should fire."""
        mock_get_conn.return_value = self._make_mock_conn(
            total_features=100,
            total_labels=90,
            recent_features=5,
            recent_labels=2,
        )

        warnings: list[str] = []
        failures: list[str] = []
        check_labels(warnings, failures)

        assert len(warnings) == 1
        assert "lower" in warnings[0]

    @patch("health.get_connection")
    def test_no_features_produces_failure(self, mock_get_conn, capsys):
        """Zero training_features rows should produce a failure."""
        mock_get_conn.return_value = self._make_mock_conn(
            total_features=0,
            total_labels=0,
            recent_features=0,
            recent_labels=0,
        )

        warnings: list[str] = []
        failures: list[str] = []
        check_labels(warnings, failures)

        assert len(failures) == 1
        assert "No training_features" in failures[0]

    @patch("health.get_connection")
    def test_conn_close_always_called(self, mock_get_conn):
        """Connection should be closed even on success."""
        mock_conn = self._make_mock_conn(100, 90, 5, 5)
        mock_get_conn.return_value = mock_conn

        check_labels([], [])

        mock_conn.close.assert_called_once()

    @patch("health.get_connection")
    def test_conn_close_on_failure(self, mock_get_conn):
        """Connection should be closed even when total_features=0 triggers early return."""
        mock_conn = self._make_mock_conn(0, 0, 0, 0)
        mock_get_conn.return_value = mock_conn

        check_labels([], [])

        mock_conn.close.assert_called_once()

    @patch("health.get_connection")
    def test_prints_coverage_stats(self, mock_get_conn, capsys):
        """Should print total features, total labels, and coverage percentages."""
        mock_get_conn.return_value = self._make_mock_conn(
            total_features=200,
            total_labels=180,
            recent_features=5,
            recent_labels=4,
        )

        check_labels([], [])

        captured = capsys.readouterr()
        assert "200" in captured.out
        assert "180" in captured.out
        assert "90%" in captured.out


# ── check_column_coverage ─────────────────────────────────────


class TestCheckColumnCoverage:
    """Tests for check_column_coverage with mocked load_data."""

    @patch("health.load_data")
    def test_no_nulls_no_warnings(self, mock_load, capsys):
        """Fully populated features should produce no warnings."""
        df = _make_features_df(n=10)
        mock_load.return_value = df

        warnings: list[str] = []
        failures: list[str] = []
        check_column_coverage(warnings, failures)

        assert len(warnings) == 0

    @patch("health.load_data")
    def test_high_null_rate_produces_warning(self, mock_load, capsys):
        """A column with >20% nulls should produce a warning."""
        df = _make_features_df(n=10)
        # Set 5 out of 10 rows null for vix (50%)
        df.iloc[:5, df.columns.get_loc("vix")] = np.nan
        mock_load.return_value = df

        warnings: list[str] = []
        failures: list[str] = []
        check_column_coverage(warnings, failures)

        vix_warnings = [w for w in warnings if "'vix'" in w]
        assert len(vix_warnings) == 1
        assert "50%" in vix_warnings[0]

    @patch("health.load_data")
    def test_missing_column_produces_warning(self, mock_load, capsys):
        """A missing key feature column should produce a warning."""
        df = _make_features_df(n=10)
        df = df.drop(columns=["vix"])
        mock_load.return_value = df

        warnings: list[str] = []
        failures: list[str] = []
        check_column_coverage(warnings, failures)

        vix_missing = [w for w in warnings if "'vix'" in w and "missing" in w]
        assert len(vix_missing) == 1

    @patch("health.load_data")
    def test_insufficient_rows_warns(self, mock_load, capsys):
        """Fewer than 2 rows should produce a warning and return early."""
        df = _make_features_df(n=1)
        mock_load.return_value = df

        warnings: list[str] = []
        failures: list[str] = []
        check_column_coverage(warnings, failures)

        assert len(warnings) == 1
        assert "Not enough rows" in warnings[0]

    @patch("health.load_data")
    def test_prints_high_flag(self, mock_load, capsys):
        """Columns with >20% null should show '<< HIGH' in output."""
        df = _make_features_df(n=10)
        df.iloc[:4, df.columns.get_loc("gex_oi_t1")] = np.nan  # 40%
        mock_load.return_value = df

        warnings: list[str] = []
        failures: list[str] = []
        check_column_coverage(warnings, failures)

        captured = capsys.readouterr()
        assert "<< HIGH" in captured.out

    @patch("health.load_data")
    def test_boundary_20_percent_no_warning(self, mock_load, capsys):
        """Exactly 20% null (2/10) should NOT trigger a warning (>20% required)."""
        df = _make_features_df(n=10)
        df.iloc[:2, df.columns.get_loc("vix")] = np.nan  # exactly 20%
        mock_load.return_value = df

        warnings: list[str] = []
        failures: list[str] = []
        check_column_coverage(warnings, failures)

        vix_warnings = [w for w in warnings if "'vix'" in w]
        assert len(vix_warnings) == 0


# ── check_stationarity ────────────────────────────────────────


class TestCheckStationarity:
    """Tests for check_stationarity with mocked load_data."""

    def _make_stationary_df(self, n: int = 30) -> pd.DataFrame:
        """Build a DataFrame with stable means for monitored columns."""
        dates = pd.bdate_range("2026-01-01", periods=n)
        rng = np.random.default_rng(42)
        return pd.DataFrame(
            {
                "vix": rng.normal(20, 2, n),
                "gex_oi_t1": rng.normal(0, 1e10, n),
                "flow_agreement_t1": rng.normal(0, 0.3, n),
            },
            index=dates,
        )

    @patch("health.load_data")
    def test_stable_data_no_warnings(self, mock_load, capsys):
        """Stationary data should produce no regime-shift warnings."""
        df = self._make_stationary_df(30)
        mock_load.return_value = df

        warnings: list[str] = []
        failures: list[str] = []
        check_stationarity(warnings, failures)

        regime_warnings = [w for w in warnings if "regime shift" in w]
        assert len(regime_warnings) == 0

    @patch("health.load_data")
    def test_regime_shift_produces_warning(self, mock_load, capsys):
        """When recent mean is >2 SD from overall, a regime shift warning fires."""
        # Use 100 rows so the last 10 are a small fraction and spiking them
        # pushes the recent mean well above the overall z-score threshold.
        df = self._make_stationary_df(100)
        overall_mean = df["vix"].mean()
        overall_std = df["vix"].std()
        df.iloc[-10:, df.columns.get_loc("vix")] = overall_mean + 10 * overall_std
        mock_load.return_value = df

        warnings: list[str] = []
        failures: list[str] = []
        check_stationarity(warnings, failures)

        vix_warnings = [w for w in warnings if "'vix'" in w]
        assert len(vix_warnings) == 1
        assert "above" in vix_warnings[0]

    @patch("health.load_data")
    def test_downward_regime_shift(self, mock_load, capsys):
        """A sharp drop should flag 'below' in the warning."""
        df = self._make_stationary_df(100)
        overall_mean = df["vix"].mean()
        overall_std = df["vix"].std()
        df.iloc[-10:, df.columns.get_loc("vix")] = overall_mean - 10 * overall_std
        mock_load.return_value = df

        warnings: list[str] = []
        failures: list[str] = []
        check_stationarity(warnings, failures)

        vix_warnings = [w for w in warnings if "'vix'" in w]
        assert len(vix_warnings) == 1
        assert "below" in vix_warnings[0]

    @patch("health.load_data")
    def test_insufficient_data_warns(self, mock_load, capsys):
        """Fewer than 15 rows should trigger an insufficient-data warning."""
        df = self._make_stationary_df(10)
        mock_load.return_value = df

        warnings: list[str] = []
        failures: list[str] = []
        check_stationarity(warnings, failures)

        assert len(warnings) == 1
        assert "15+" in warnings[0]

    @patch("health.load_data")
    def test_zero_variance_handled(self, mock_load, capsys):
        """A column with zero variance should print 'zero variance', not crash."""
        df = self._make_stationary_df(30)
        df["vix"] = 20.0  # constant -> zero std
        mock_load.return_value = df

        warnings: list[str] = []
        failures: list[str] = []
        check_stationarity(warnings, failures)

        captured = capsys.readouterr()
        assert "zero variance" in captured.out

    @patch("health.load_data")
    def test_prints_regime_shift_flag(self, mock_load, capsys):
        """Regime shift output should contain '<< REGIME SHIFT'."""
        df = self._make_stationary_df(100)
        overall_mean = df["vix"].mean()
        overall_std = df["vix"].std()
        df.iloc[-10:, df.columns.get_loc("vix")] = overall_mean + 10 * overall_std
        mock_load.return_value = df

        check_stationarity([], [])

        captured = capsys.readouterr()
        assert "<< REGIME SHIFT" in captured.out

    @patch("health.load_data")
    def test_sparse_recent_data_skipped(self, mock_load, capsys):
        """If recent column has <3 non-null values, it should print 'insufficient'."""
        df = self._make_stationary_df(30)
        # Make the last 10 rows (recent) mostly null for flow_agreement_t1
        df.iloc[-10:, df.columns.get_loc("flow_agreement_t1")] = np.nan
        mock_load.return_value = df

        check_stationarity([], [])

        captured = capsys.readouterr()
        assert "insufficient data" in captured.out


# ── print_summary ─────────────────────────────────────────────


class TestPrintSummary:
    """Tests for print_summary output formatting."""

    def test_all_pass(self, capsys):
        """No warnings or failures should print PASS status."""
        print_summary([], [])
        captured = capsys.readouterr()
        assert "PASS" in captured.out
        assert "All pipeline health checks passed" in captured.out

    def test_warnings_only(self, capsys):
        """Warnings without failures should print WARN status."""
        print_summary(["some warning"], [])
        captured = capsys.readouterr()
        assert "WARN" in captured.out
        assert "some warning" in captured.out
        assert "warnings to investigate" in captured.out

    def test_failures_only(self, capsys):
        """Failures should print FAIL status."""
        print_summary([], ["critical failure"])
        captured = capsys.readouterr()
        assert "FAIL" in captured.out
        assert "critical failure" in captured.out
        assert "immediate attention" in captured.out

    def test_both_warnings_and_failures(self, capsys):
        """Both warnings and failures should print FAIL status."""
        print_summary(["a warning"], ["a failure"])
        captured = capsys.readouterr()
        assert "FAIL" in captured.out
        assert "a warning" in captured.out
        assert "a failure" in captured.out

    def test_multiple_warnings_all_printed(self, capsys):
        """All warnings should appear in the output."""
        ws = ["warn1", "warn2", "warn3"]
        print_summary(ws, [])
        captured = capsys.readouterr()
        for w in ws:
            assert w in captured.out

    def test_multiple_failures_all_printed(self, capsys):
        """All failures should appear in the output."""
        fs = ["fail1", "fail2"]
        print_summary([], fs)
        captured = capsys.readouterr()
        for f in fs:
            assert f in captured.out

    def test_pass_does_not_contain_failures_section(self, capsys):
        """PASS status should not print 'Failures' or 'Warnings' headers."""
        print_summary([], [])
        captured = capsys.readouterr()
        assert "Failures" not in captured.out
        assert "Warnings" not in captured.out


# ── main() ────────────────────────────────────────────────────


class TestMain:
    """Tests for the main orchestrator."""

    @patch("health.print_summary")
    @patch("health.check_stationarity")
    @patch("health.check_column_coverage")
    @patch("health.check_labels")
    @patch("health.check_completeness")
    @patch("health.check_freshness")
    def test_main_calls_all_checks(
        self,
        mock_fresh,
        mock_comp,
        mock_labels,
        mock_col,
        mock_stat,
        mock_summary,
        capsys,
    ):
        """main() should call each check function exactly once."""
        health.main()

        mock_fresh.assert_called_once()
        mock_comp.assert_called_once()
        mock_labels.assert_called_once()
        mock_col.assert_called_once()
        mock_stat.assert_called_once()
        mock_summary.assert_called_once()

    @patch("health.print_summary")
    @patch("health.check_stationarity")
    @patch("health.check_column_coverage")
    @patch("health.check_labels")
    @patch("health.check_completeness")
    @patch("health.check_freshness")
    def test_main_exits_on_warnings(
        self,
        mock_fresh,
        mock_comp,
        mock_labels,
        mock_col,
        mock_stat,
        mock_summary,
        capsys,
    ):
        """main() should sys.exit(1) when warnings are present."""

        # Simulate a check that adds a warning
        def add_warning(warnings, failures):
            warnings.append("test warning")

        mock_fresh.side_effect = add_warning

        with pytest.raises(SystemExit) as exc_info:
            health.main()
        assert exc_info.value.code == 1

    @patch("health.print_summary")
    @patch("health.check_stationarity")
    @patch("health.check_column_coverage")
    @patch("health.check_labels")
    @patch("health.check_completeness")
    @patch("health.check_freshness")
    def test_main_exits_on_failures(
        self,
        mock_fresh,
        mock_comp,
        mock_labels,
        mock_col,
        mock_stat,
        mock_summary,
        capsys,
    ):
        """main() should sys.exit(1) when failures are present."""

        def add_failure(warnings, failures):
            failures.append("test failure")

        mock_fresh.side_effect = add_failure

        with pytest.raises(SystemExit) as exc_info:
            health.main()
        assert exc_info.value.code == 1

    @patch("health.print_summary")
    @patch("health.check_stationarity")
    @patch("health.check_column_coverage")
    @patch("health.check_labels")
    @patch("health.check_completeness")
    @patch("health.check_freshness")
    def test_main_no_exit_on_clean(
        self,
        mock_fresh,
        mock_comp,
        mock_labels,
        mock_col,
        mock_stat,
        mock_summary,
        capsys,
    ):
        """main() should not exit when all checks pass."""
        # No side effects = no warnings/failures added
        health.main()  # Should return normally, no SystemExit
