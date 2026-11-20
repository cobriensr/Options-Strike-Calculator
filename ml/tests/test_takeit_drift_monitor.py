# ml/tests/test_takeit_drift_monitor.py
import datetime as dt
import subprocess
import sys
import types
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

import takeit_drift_monitor
from takeit_drift_monitor import (
    DriftRun,
    compute_feed_drift,
    feature_zscore,
    fetch_recent_fires,
    per_segment_auc,
    plot_reliability,
    reliability_bins,
    render_markdown_report,
    rolling_auc,
    run_drift,
)

ML_SRC = Path(__file__).resolve().parents[1] / "src"
AS_OF = dt.date(2026, 11, 4)

# pandas reads through a DBAPI connection it can't type; the warning is the
# production one too and says nothing about these tests.
pytestmark = pytest.mark.filterwarnings(
    "ignore:pandas only supports SQLAlchemy connectable:UserWarning"
)

FIRE_COLUMNS = [
    "date",
    "underlying_symbol",
    "option_type",
    "dte",
    "takeit_prob",
    "takeit_model_version",
    "peak_ceiling_pct",
    "realized_trail30_10_pct",
]


class FakeCursor:
    """A DBAPI cursor over a FakeConn: it answers each feed's SELECT with that
    feed's frame and records the upserts. Pandas uses it without a context
    manager, run_drift with one."""

    def __init__(self, conn: "FakeConn") -> None:
        self.conn = conn
        self.description = None
        self._rows: list[tuple] = []

    def __enter__(self) -> "FakeCursor":
        return self

    def __exit__(self, *exc) -> bool:
        return False

    def execute(self, sql: str, params=None) -> None:
        self.conn.executed.append((sql, params))
        if self.conn.fail_on and self.conn.fail_on in sql:
            raise RuntimeError("connection lost")
        if "INSERT INTO takeit_health_daily" in sql:
            self.conn.upserts.append(params)
            return
        if "FROM lottery_finder_fires" in sql:
            frame = self.conn.frames["lottery"]
        elif "FROM silent_boom_alerts" in sql:
            frame = self.conn.frames["silent_boom"]
        else:
            raise AssertionError(f"unexpected SQL: {sql}")
        self.description = [(column,) for column in frame.columns]
        self._rows = list(frame.itertuples(index=False, name=None))

    def fetchall(self) -> list[tuple]:
        return self._rows

    def close(self) -> None:
        pass


class FakeConn:
    def __init__(self, frames: dict[str, pd.DataFrame], fail_on: str | None = None):
        self.frames = frames
        self.fail_on = fail_on
        self.executed: list[tuple[str, tuple | None]] = []
        self.upserts: list[tuple] = []
        self.commits = 0
        self.closed = False

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def commit(self) -> None:
        self.commits += 1

    def close(self) -> None:
        self.closed = True


def fires(*, separable: bool, n: int = 12) -> pd.DataFrame:
    """`n` fires over the 5 days before AS_OF. Separable: high takeit_prob goes with
    peak >= 20 and realized >= 0, so every AUC is 1.0. Otherwise every fire is a
    loser on both targets, a single class that gives NaN AUCs."""
    prob = np.tile([0.1, 0.9], n // 2)
    win = prob > 0.5 if separable else np.zeros(n, dtype=bool)
    return pd.DataFrame(
        {
            "date": [
                pd.Timestamp(AS_OF) - pd.Timedelta(days=1 + i % 5) for i in range(n)
            ],
            "underlying_symbol": ["SPY"] * n,
            "option_type": ["C"] * n,
            "dte": [0] * n,
            "takeit_prob": prob,
            "takeit_model_version": ["v1"] * n,
            "peak_ceiling_pct": np.where(win, 30.0, 5.0),
            "realized_trail30_10_pct": np.where(win, 4.0, -4.0),
        }
    )


def test_rolling_auc_perfect_separation():
    y_true = np.array([0, 0, 0, 1, 1, 1])
    y_pred = np.array([0.1, 0.2, 0.3, 0.7, 0.8, 0.9])
    assert rolling_auc(y_true, y_pred) == pytest.approx(1.0)


def test_rolling_auc_returns_nan_on_single_class():
    y_true = np.array([1, 1, 1])
    y_pred = np.array([0.4, 0.6, 0.8])
    assert np.isnan(rolling_auc(y_true, y_pred))


def test_rolling_auc_returns_nan_on_nan_in_y_pred():
    y_true = np.array([0, 0, 1, 1])
    y_pred = np.array([0.1, 0.2, float("nan"), 0.9])
    assert np.isnan(rolling_auc(y_true, y_pred))


def test_rolling_auc_returns_nan_on_nan_in_a_negative_row():
    # The NaN is on a label-0 row, so ranking the positives alone would still give
    # a number: the guard has to look at every score.
    y_true = np.array([0, 0, 1, 1])
    y_pred = np.array([0.1, float("nan"), 0.8, 0.9])
    assert np.isnan(rolling_auc(y_true, y_pred))


def test_rolling_auc_returns_nan_on_empty_input():
    assert np.isnan(rolling_auc(np.array([]), np.array([])))


def test_rolling_auc_ties_count_half():
    # One positive and one negative with the same score: a tie counts half a win.
    assert rolling_auc(np.array([0, 1]), np.array([0.5, 0.5])) == 0.5


def test_rolling_auc_inverted_separation_is_zero():
    y_true = np.array([1, 1, 0, 0])
    y_pred = np.array([0.1, 0.2, 0.8, 0.9])
    assert rolling_auc(y_true, y_pred) == pytest.approx(0.0)


def test_reliability_bins_returns_10_bins_with_predicted_actual():
    y_true = np.array([0, 0, 1, 1, 0, 1, 1, 1, 1, 1])
    y_pred = np.array([0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95])
    bins = reliability_bins(y_true, y_pred, n_bins=10)
    assert len(bins) == 10
    for b in bins:
        assert len(b) == 3  # (predicted_mean, actual_rate, count)


def test_per_segment_auc_skips_segments_below_min_n():
    y_true = np.array([0, 1, 0, 1, 0, 1])
    y_pred = np.array([0.2, 0.7, 0.3, 0.8, 0.4, 0.9])
    segments = np.array(["A", "A", "A", "A", "B", "B"])
    result = per_segment_auc(y_true, y_pred, segments, min_n=3)
    assert "A" in result
    assert "B" not in result  # below min_n
    assert result["A"]["auc"] == pytest.approx(1.0)


def test_per_segment_auc_drops_nan_segments():
    # pandas 3.0 Categorical.astype(str) leaves missing values as float NaN,
    # producing an object array that mixes str labels with float NaN. np.unique
    # cannot sort across those types, so per_segment_auc must drop nulls first.
    y_true = np.array([0, 1, 0, 1, 0, 1])
    y_pred = np.array([0.2, 0.7, 0.3, 0.8, 0.4, 0.9])
    segments = np.array(["A", "A", "A", float("nan"), float("nan"), "A"], dtype=object)
    result = per_segment_auc(y_true, y_pred, segments, min_n=3)
    assert "A" in result
    assert "nan" not in result
    assert not any(isinstance(k, float) for k in result)


def test_per_segment_auc_returns_empty_when_all_segments_null():
    # All-NaN segments (e.g. every row has a null/out-of-bin DTE): the label
    # set is empty after dropna, so the helper returns {} without raising and
    # without inventing a 'nan' bucket. Callers (render_markdown_report) iterate
    # an empty dict harmlessly.
    y_true = np.array([0, 1, 0, 1])
    y_pred = np.array([0.2, 0.7, 0.3, 0.8])
    segments = np.array([float("nan")] * 4, dtype=object)
    result = per_segment_auc(y_true, y_pred, segments, min_n=1)
    assert result == {}


def test_feature_zscore_against_baseline():
    today = np.array([1.0, 2.0, 3.0])
    z = feature_zscore(today, baseline_mean=0.0, baseline_std=1.0)
    # today's mean is 2.0; z = (2.0 - 0.0) / 1.0 = 2.0
    assert z == pytest.approx(2.0)


def test_feature_zscore_returns_nan_on_zero_baseline_std():
    today = np.array([1.0, 2.0, 3.0])
    z = feature_zscore(today, baseline_mean=0.0, baseline_std=0.0)
    assert np.isnan(z)


# --- reliability_bins: empty-bin branch (src ~71-72) -------------------------


def test_reliability_bins_empty_bin_yields_nan_and_zero_count():
    # All predictions cluster in the low bin [0, 0.5); with n_bins=2 the upper
    # bin [0.5, 1.0] gets no samples, so the function appends the
    # (bin_center, NaN, 0) sentinel for it.
    y_true = np.array([0, 1, 0, 1])
    y_pred = np.array([0.1, 0.2, 0.3, 0.4])
    bins = reliability_bins(y_true, y_pred, n_bins=2)
    assert len(bins) == 2

    low_pred, low_actual, low_n = bins[0]
    assert low_n == 4
    assert low_pred == pytest.approx(0.25)  # mean of [0.1,0.2,0.3,0.4]
    assert low_actual == pytest.approx(0.5)  # 2 of 4 positive

    # Upper bin [0.5, 1.0] is empty -> (bin_center=0.75, NaN, 0)
    hi_pred, hi_actual, hi_n = bins[1]
    assert hi_n == 0
    assert hi_pred == pytest.approx(0.75)  # (0.5 + 1.0) / 2
    assert np.isnan(hi_actual)


# --- feature_zscore: all-NaN today branch (src ~117-119) ---------------------


@pytest.mark.filterwarnings("ignore:Mean of empty slice:RuntimeWarning")
def test_feature_zscore_returns_nan_when_today_all_nan():
    # np.nanmean over an all-NaN array yields NaN (and emits a RuntimeWarning we
    # intentionally trigger), so the today_mean isnan guard returns NaN before
    # the division.
    today = np.array([float("nan"), float("nan"), float("nan")])
    z = feature_zscore(today, baseline_mean=5.0, baseline_std=2.0)
    assert np.isnan(z)


# --- render_markdown_report (src ~184-212) -----------------------------------


def test_render_markdown_report_header_and_metrics():
    lottery = {
        "feed": "lottery",
        "n_rows_total": 123,
        "auc_7d_peak": 0.6789,
        "auc_30d_peak": 0.7012,
    }
    silent_boom = {"feed": "silent_boom", "n_rows_total": 0}
    report = render_markdown_report("2026-06-09", lottery, silent_boom)

    assert report.startswith("# TAKE-IT drift report — 2026-06-09")
    assert "## lottery" in report
    assert "## silent_boom" in report
    assert "- rows in 30d window: 123" in report
    # floats are formatted to 3 decimals
    assert "- auc_7d_peak: 0.679" in report
    assert "- auc_30d_peak: 0.701" in report


def test_render_markdown_report_nan_metric_renders_na():
    lottery = {
        "feed": "lottery",
        "n_rows_total": 5,
        "auc_7d_peak": float("nan"),
    }
    silent_boom = {"feed": "silent_boom", "n_rows_total": 0}
    report = render_markdown_report("2026-06-09", lottery, silent_boom)
    assert "- auc_7d_peak: n/a" in report
    # absent metric keys are simply omitted, not rendered
    assert "auc_30d_realized" not in report


def test_render_markdown_report_includes_per_segment_subsections():
    lottery = {
        "feed": "lottery",
        "n_rows_total": 50,
        "by_dte": {
            "0DTE": {"auc": 0.61, "n": 120},
            "1-3": {"auc": 0.58, "n": 110},
        },
        "by_option_type": {
            "C": {"auc": 0.6, "n": 200},
        },
    }
    silent_boom = {"feed": "silent_boom", "n_rows_total": 0}
    report = render_markdown_report("2026-06-09", lottery, silent_boom)

    assert "### per-DTE 30d AUC (peak target)" in report
    assert "- 0DTE: AUC=0.610  n=120" in report
    assert "- 1-3: AUC=0.580  n=110" in report
    assert "### per-option-type 30d AUC (peak target)" in report
    assert "- C: AUC=0.600  n=200" in report


# --- compute_feed_drift (src ~145-181) ---------------------------------------


def test_compute_feed_drift_empty_frame_returns_only_totals():
    out = compute_feed_drift(pd.DataFrame(), "lottery", AS_OF)
    assert out == {"feed": "lottery", "n_rows_total": 0}


def _days_ago(n: int) -> pd.Timestamp:
    # Windows are counted back from the as_of date, never from the clock.
    return pd.Timestamp(AS_OF) - pd.Timedelta(days=n)


def test_compute_feed_drift_windows_count_back_from_as_of():
    # A fire exactly 7 days before as_of is in the 7d window (>=); one 8 days
    # before is only in the 30d window. The 8-day fire is a high-score loser, so
    # the 30d AUC drops to 0.5 while the 7d AUC stays 1.0.
    rows = [
        (_days_ago(1), 0.10, 5.0, -5.0, 0, "C"),
        (_days_ago(7), 0.90, 30.0, 5.0, 0, "C"),
        (_days_ago(8), 0.95, 5.0, -5.0, 0, "C"),
    ]
    df = pd.DataFrame(
        rows,
        columns=[
            "date",
            "takeit_prob",
            "peak_ceiling_pct",
            "realized_trail30_10_pct",
            "dte",
            "option_type",
        ],
    )
    out = compute_feed_drift(df, "lottery", AS_OF)
    assert out["auc_7d_peak"] == pytest.approx(1.0)
    assert out["auc_30d_peak"] == pytest.approx(0.5)


def test_compute_feed_drift_windowing_and_auc():
    # Six in-window rows (within 7d) with perfectly separable takeit_prob vs the
    # peak>=20 label, plus one stale row at 40d that must be excluded from both
    # the 7d and 30d windows.
    rows = [
        # date, takeit_prob, peak_ceiling_pct, realized, dte, option_type
        (_days_ago(1), 0.10, 5.0, -5.0, 0, "C"),
        (_days_ago(1), 0.20, 10.0, -3.0, 0, "C"),
        (_days_ago(2), 0.30, 15.0, -1.0, 1, "P"),
        (_days_ago(3), 0.70, 25.0, 4.0, 2, "C"),
        (_days_ago(4), 0.80, 30.0, 6.0, 5, "P"),
        (_days_ago(5), 0.90, 40.0, 8.0, 7, "C"),
        (_days_ago(40), 0.50, 50.0, 9.0, 0, "C"),  # stale, excluded
    ]
    df = pd.DataFrame(
        rows,
        columns=[
            "date",
            "takeit_prob",
            "peak_ceiling_pct",
            "realized_trail30_10_pct",
            "dte",
            "option_type",
        ],
    )

    out = compute_feed_drift(df, "lottery", AS_OF)
    assert out["feed"] == "lottery"
    assert out["n_rows_total"] == 7  # total rows, not windowed

    # In the 7d window the 6 fresh rows: peak>=20 label = [0,0,0,1,1,1] vs
    # takeit_prob ascending -> perfect separation -> AUC 1.0.
    assert out["auc_7d_peak"] == pytest.approx(1.0)
    assert out["auc_30d_peak"] == pytest.approx(1.0)

    # realized>=0 label = [0,0,0,1,1,1] -> also perfect separation.
    assert out["auc_7d_realized"] == pytest.approx(1.0)
    assert out["auc_30d_realized"] == pytest.approx(1.0)

    # Cross-check against rolling_auc computed by hand on the same labels.
    y_pred = np.array([0.10, 0.20, 0.30, 0.70, 0.80, 0.90])
    peak_label = np.array([0, 0, 0, 1, 1, 1])
    assert out["auc_7d_peak"] == pytest.approx(rolling_auc(peak_label, y_pred))


def test_compute_feed_drift_realized_label_binarizes_nan_as_negative():
    # realized_trail30_10_pct NaN is filled with -100 -> label 0 (< 0). Build a
    # window where the only positive takeit_prob rows have NaN realized: that
    # forces the high-prob rows to label 0, inverting separation so AUC = 0.0.
    rows = [
        (_days_ago(1), 0.10, 5.0, 5.0, 0, "C"),  # realized>=0 -> 1
        (_days_ago(1), 0.20, 5.0, 5.0, 0, "C"),  # realized>=0 -> 1
        (_days_ago(2), 0.80, 30.0, float("nan"), 1, "P"),  # NaN -> 0
        (_days_ago(2), 0.90, 30.0, float("nan"), 1, "P"),  # NaN -> 0
    ]
    df = pd.DataFrame(
        rows,
        columns=[
            "date",
            "takeit_prob",
            "peak_ceiling_pct",
            "realized_trail30_10_pct",
            "dte",
            "option_type",
        ],
    )
    out = compute_feed_drift(df, "lottery", AS_OF)
    # realized label = [1, 1, 0, 0] vs ascending prob -> fully inverted -> 0.0
    assert out["auc_7d_realized"] == pytest.approx(0.0)


def test_compute_feed_drift_dte_segmentation_buckets():
    # >= PER_SEGMENT_MIN_N (100) rows per DTE bucket so per_segment_auc keeps
    # them. Bins: [-1,0]=0DTE, (0,3]=1-3, (3,100]=4+.
    n = 120
    base = _days_ago(2)
    frames = []
    for dte_val, _bucket in [(0, "0DTE"), (2, "1-3"), (10, "4+")]:
        frames.append(
            pd.DataFrame(
                {
                    "date": [base] * n,
                    # alternate labels so each segment is two-class & separable
                    "takeit_prob": np.tile([0.2, 0.8], n // 2),
                    "peak_ceiling_pct": np.tile([5.0, 30.0], n // 2),
                    "realized_trail30_10_pct": [1.0] * n,
                    "dte": [dte_val] * n,
                    "option_type": ["C"] * n,
                }
            )
        )
    df = pd.concat(frames, ignore_index=True)

    out = compute_feed_drift(df, "lottery", AS_OF)
    assert set(out["by_dte"].keys()) == {"0DTE", "1-3", "4+"}
    for seg in ("0DTE", "1-3", "4+"):
        assert out["by_dte"][seg]["n"] == n
        # takeit_prob 0.2/0.8 maps perfectly to peak label 0/1 -> AUC 1.0
        assert out["by_dte"][seg]["auc"] == pytest.approx(1.0)
    # option_type 'C' is the only label, with 3*n rows
    assert out["by_option_type"]["C"]["n"] == 3 * n


def test_compute_feed_drift_single_class_window_yields_nan_auc():
    # All rows have peak < 20 -> peak_label is single-class -> rolling_auc NaN.
    rows = [
        (_days_ago(1), 0.10, 5.0, 1.0, 0, "C"),
        (_days_ago(2), 0.20, 10.0, 1.0, 1, "P"),
        (_days_ago(3), 0.30, 15.0, 1.0, 2, "C"),
    ]
    df = pd.DataFrame(
        rows,
        columns=[
            "date",
            "takeit_prob",
            "peak_ceiling_pct",
            "realized_trail30_10_pct",
            "dte",
            "option_type",
        ],
    )
    out = compute_feed_drift(df, "lottery", AS_OF)
    assert np.isnan(out["auc_7d_peak"])
    assert np.isnan(out["auc_30d_peak"])


# --- fetch_recent_fires: the window comes from as_of --------------------------


@pytest.mark.parametrize(
    ("feed", "table"),
    [("lottery", "lottery_finder_fires"), ("silent_boom", "silent_boom_alerts")],
)
def test_fetch_window_uses_as_of_param(feed, table):
    conn = FakeConn({feed: fires(separable=True)})
    frame = fetch_recent_fires(conn, feed, 30, AS_OF)

    ((sql, params),) = conn.executed
    assert "current_date" not in sql.lower()
    assert f"FROM {table}" in sql
    assert "date >= %s" in sql
    assert params == (AS_OF - dt.timedelta(days=30),)
    assert len(frame) == 12
    assert pd.api.types.is_datetime64_any_dtype(frame["date"])


def test_fetch_window_follows_the_lookback():
    conn = FakeConn({"lottery": fires(separable=True)})
    fetch_recent_fires(conn, "lottery", 7, AS_OF)
    assert conn.executed[0][1] == (dt.date(2026, 10, 28),)


# --- plot_reliability ---------------------------------------------------------


def test_plot_reliability_writes_a_dated_png_into_plot_dir(tmp_path):
    plot_dir = tmp_path / "plots" / "nested"
    path = plot_reliability(fires(separable=True), "lottery", AS_OF, plot_dir)

    assert path == plot_dir / "reliability_lottery_2026-11-04.png"
    assert path.read_bytes().startswith(b"\x89PNG")


def test_plot_reliability_returns_none_without_rows_in_the_30d_window(tmp_path):
    stale = fires(separable=True)
    stale["date"] = pd.Timestamp(AS_OF) - pd.Timedelta(days=45)

    assert plot_reliability(pd.DataFrame(), "lottery", AS_OF, tmp_path) is None
    assert plot_reliability(stale, "lottery", AS_OF, tmp_path) is None
    assert list(tmp_path.iterdir()) == []


# --- run_drift ----------------------------------------------------------------


def test_run_drift_writes_report_plots_and_counts_metrics(tmp_path):
    conn = FakeConn(
        {
            "lottery": fires(separable=True),
            "silent_boom": fires(separable=True),
        }
    )
    report_dir = tmp_path / "reports"
    plot_dir = tmp_path / "plots"

    run = run_drift(conn, AS_OF, report_dir, plot_dir)

    assert isinstance(run, DriftRun)
    assert run.report_path == report_dir / "takeit-drift-2026-11-04.md"
    assert run.report_path.read_text(encoding="utf-8").startswith(
        "# TAKE-IT drift report — 2026-11-04"
    )
    assert run.plot_paths == (
        plot_dir / "reliability_lottery_2026-11-04.png",
        plot_dir / "reliability_silent_boom_2026-11-04.png",
    )
    assert all(p.read_bytes().startswith(b"\x89PNG") for p in run.plot_paths)

    # Every upsert is dated by as_of, not the clock, and the count is the
    # number of executes: 2 feeds x 4 metrics.
    assert all(params[0] == AS_OF for params in conn.upserts)
    assert run.metrics_written == len(conn.upserts) == 8
    assert {(p[1], p[2]) for p in conn.upserts} == {
        (feed, f"ml_auc_{window}_{target}")
        for feed in ("lottery", "silent_boom")
        for window in ("7d", "30d")
        for target in ("peak", "realized")
    }
    assert all(p[3] == pytest.approx(1.0) for p in conn.upserts)
    upsert_sql = next(
        sql for sql, _ in conn.executed if "INSERT INTO takeit_health_daily" in sql
    )
    assert "ON CONFLICT (date, feed, metric_name)" in upsert_sql
    assert conn.commits == 1
    # Nothing outside the two dirs it was given.
    assert sorted(p.name for p in tmp_path.iterdir()) == ["plots", "reports"]


def test_run_drift_skips_nan_metrics(tmp_path):
    # silent_boom is a single class on both targets, so every AUC is NaN.
    conn = FakeConn(
        {
            "lottery": fires(separable=True),
            "silent_boom": fires(separable=False),
        }
    )

    run = run_drift(conn, AS_OF, tmp_path, tmp_path)

    assert [p for p in conn.upserts if p[1] == "silent_boom"] == []
    assert len([p for p in conn.upserts if p[1] == "lottery"]) == 4
    assert run.metrics_written == len(conn.upserts) == 4
    # The report still lists the NaN metrics as n/a.
    assert "- auc_7d_peak: n/a" in run.report_path.read_text(encoding="utf-8")


def test_run_drift_with_an_empty_feed_writes_one_plot_and_only_that_feeds_metrics(
    tmp_path,
):
    conn = FakeConn(
        {
            "lottery": fires(separable=True),
            "silent_boom": fires(separable=True).iloc[0:0],
        }
    )

    run = run_drift(conn, AS_OF, tmp_path, tmp_path)

    assert run.plot_paths == (tmp_path / "reliability_lottery_2026-11-04.png",)
    assert run.metrics_written == 4
    assert {p[1] for p in conn.upserts} == {"lottery"}
    assert conn.commits == 1


@pytest.mark.parametrize(
    "failing_sql", ["FROM silent_boom_alerts", "INSERT INTO takeit_health_daily"]
)
def test_run_drift_surfaces_a_database_failure_and_does_not_commit(
    tmp_path, failing_sql
):
    conn = FakeConn(
        {"lottery": fires(separable=True), "silent_boom": fires(separable=True)},
        fail_on=failing_sql,
    )

    with pytest.raises(RuntimeError, match="connection lost"):
        run_drift(conn, AS_OF, tmp_path, tmp_path)

    assert conn.commits == 0


# --- main ---------------------------------------------------------------------


def _fake_utils(monkeypatch, conn: FakeConn) -> None:
    """Replace the ml `utils` package that main imports get_connection from."""
    module = types.ModuleType("utils")
    module.get_connection = lambda: conn
    monkeypatch.setitem(sys.modules, "utils", module)


def test_main_writes_to_the_dirs_it_is_given_and_closes_the_connection(
    tmp_path, monkeypatch, capsys
):
    conn = FakeConn(
        {"lottery": fires(separable=True), "silent_boom": fires(separable=True)}
    )
    _fake_utils(monkeypatch, conn)
    out_dir, plot_dir = tmp_path / "out", tmp_path / "plots"

    code = takeit_drift_monitor.main(
        [
            "--as-of",
            "2026-11-04",
            "--out-dir",
            str(out_dir),
            "--plot-dir",
            str(plot_dir),
        ]
    )

    assert code == 0
    assert (out_dir / "takeit-drift-2026-11-04.md").exists()
    assert (plot_dir / "reliability_lottery_2026-11-04.png").exists()
    assert all(p[0] == AS_OF for p in conn.upserts)
    assert conn.closed
    assert f"Wrote {out_dir / 'takeit-drift-2026-11-04.md'}" in capsys.readouterr().out


def test_main_defaults_to_today_and_the_module_dirs(tmp_path, monkeypatch):
    conn = FakeConn(
        {"lottery": fires(separable=True), "silent_boom": fires(separable=True)}
    )
    _fake_utils(monkeypatch, conn)
    monkeypatch.setattr(takeit_drift_monitor, "DOCS_TMP", tmp_path / "docs")
    monkeypatch.setattr(takeit_drift_monitor, "PLOT_DIR", tmp_path / "plots")
    days = {dt.date.today()}

    assert takeit_drift_monitor.main([]) == 0
    days.add(dt.date.today())  # a run that straddles midnight is still fine

    (report,) = (tmp_path / "docs").iterdir()
    assert report.name in {f"takeit-drift-{day.isoformat()}.md" for day in days}
    assert len(list((tmp_path / "plots").iterdir())) == 2


def test_main_closes_the_connection_when_the_run_fails(tmp_path, monkeypatch):
    conn = FakeConn(
        {"lottery": fires(separable=True), "silent_boom": fires(separable=True)},
        fail_on="FROM lottery_finder_fires",
    )
    _fake_utils(monkeypatch, conn)

    with pytest.raises(RuntimeError, match="connection lost"):
        takeit_drift_monitor.main(
            ["--out-dir", str(tmp_path), "--plot-dir", str(tmp_path)]
        )

    assert conn.closed


def test_main_rejects_a_malformed_as_of(capsys):
    with pytest.raises(SystemExit) as exc:
        takeit_drift_monitor.main(["--as-of", "11/04/2026"])
    assert exc.value.code == 2
    assert "--as-of" in capsys.readouterr().err


# --- the module's imports -------------------------------------------------------


def _run_child(code: str) -> subprocess.CompletedProcess[str]:
    """Run `code` in a fresh interpreter whose cwd is ml/src, the way a script in
    that directory (or the nightly image's app dir) imports the module."""
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=ML_SRC,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


def test_missing_dependency_raises_import_error_not_systemexit():
    # The nightly runs the step in-process: a SystemExit at import would pass
    # through run_steps and end the run before the tape's check-in.
    child = _run_child(
        "import sys\n"
        "sys.modules['matplotlib'] = None\n"
        "try:\n"
        "    import takeit_drift_monitor\n"
        "except ImportError as exc:\n"
        "    print('ImportError', type(exc).__name__)\n"
        "except SystemExit:\n"
        "    print('SystemExit')\n"
        "else:\n"
        "    print('imported')\n"
    )
    assert child.returncode == 0, child.stderr
    assert child.stdout.split()[0] == "ImportError", child.stdout + child.stderr


def test_import_needs_no_sklearn_or_ml_utils():
    # The nightly image carries neither scikit-learn nor scipy and SQLAlchemy,
    # which ml/src/utils pulls in. get_connection is imported inside main.
    child = _run_child(
        "import sys\n"
        "import takeit_drift_monitor\n"
        "print('sklearn' in sys.modules, 'utils' in sys.modules)\n"
    )
    assert child.returncode == 0, child.stderr
    assert child.stdout.split() == ["False", "False"], child.stdout + child.stderr
