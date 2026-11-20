# ml/src/takeit_drift_monitor.py
# Daily TAKE-IT drift + validation monitor. `make takeit-drift` runs it from the
# command line and the nightly job calls run_drift in-process. Outputs, written
# to the dirs it is given (defaults: docs/tmp and ml/plots/takeit-drift):
#   - takeit-drift-YYYY-MM-DD.md
#   - reliability_<feed>_<date>.png
#   - rows in takeit_health_daily (ml_-prefixed metric_name)
# Every date is the as_of date (the session), never the clock.
#
# Targets compared:
#   - peak_ceiling_pct >= 20    (the model's training target)
#   - realized_trail30_10_pct >= 0  (trade-worthiness target)
# The divergence between rolling AUCs on these two targets is itself a
# tracked metric — the empirical case for the deferred realized-target retrain.
#
# The imports are plain, and neither scikit-learn nor ml/src/utils is imported:
# the nightly image has neither. A missing dependency raises ImportError, which
# the step catches; a SystemExit here would end the whole nightly run.

from __future__ import annotations

import argparse
import datetime as dt
import sys
from dataclasses import dataclass
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # must precede pyplot import
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import psycopg2

ML_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = ML_ROOT.parent
DOCS_TMP = REPO_ROOT / "docs" / "tmp"
PLOT_DIR = ML_ROOT / "plots" / "takeit-drift"

ROLLING_AUC_DROP_MAX = 0.05
PER_SEGMENT_AUC_MIN = 0.55
PER_SEGMENT_MIN_N = 100
FEATURE_Z_ALERT = 3.0


def rolling_auc(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    """AUC as the Mann-Whitney U statistic over average ranks (ties count half).

    y_true holds two labels (0/1), the higher one the positive class. Returns NaN
    if y_true is single-class or empty, or y_pred has NaN. Equals scikit-learn's
    roc_auc_score to float precision (ml/tests/test_takeit_drift_auc_sklearn.py)
    without importing it: the nightly image carries no scikit-learn.
    """
    y_true = np.asarray(y_true)
    y_pred = np.asarray(y_pred, dtype=float)
    if len(y_true) == 0 or len(np.unique(y_true)) < 2:
        return float("nan")
    if np.any(np.isnan(y_pred)):
        return float("nan")
    ranks = pd.Series(y_pred).rank(method="average").to_numpy()
    positive = y_true == y_true.max()
    n_pos = int(positive.sum())
    n_neg = len(y_true) - n_pos
    rank_sum = float(ranks[positive].sum())
    return (rank_sum - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg)


def reliability_bins(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    n_bins: int = 10,
) -> list[tuple[float, float, int]]:
    """Return (predicted_mean, actual_rate, count) per equal-width prob bin."""
    bins = np.linspace(0, 1, n_bins + 1)
    out: list[tuple[float, float, int]] = []
    for i in range(n_bins):
        lo, hi = bins[i], bins[i + 1]
        if i == n_bins - 1:
            mask = (y_pred >= lo) & (y_pred <= hi)
        else:
            mask = (y_pred >= lo) & (y_pred < hi)
        n = int(mask.sum())
        if n == 0:
            out.append((float((lo + hi) / 2), float("nan"), 0))
            continue
        out.append(
            (
                float(y_pred[mask].mean()),
                float(y_true[mask].mean()),
                n,
            )
        )
    return out


def per_segment_auc(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    segments: np.ndarray,
    min_n: int = PER_SEGMENT_MIN_N,
) -> dict[str, dict[str, float | int]]:
    """AUC per segment label. Segments with count < min_n are skipped.

    Null segments are dropped before computing the label set. pandas 3.0's
    Categorical.astype(str) leaves missing values as float NaN rather than the
    string 'nan', so segments can be an object array mixing str and float —
    np.unique would raise TypeError sorting across those types.
    """
    out: dict[str, dict[str, float | int]] = {}
    labels = sorted(pd.Series(segments).dropna().unique())
    for seg in labels:
        mask = segments == seg
        n = int(mask.sum())
        if n < min_n:
            continue
        auc = rolling_auc(y_true[mask], y_pred[mask])
        out[str(seg)] = {"auc": auc, "n": n}
    return out


# Exported for the deferred per-feature drift monitor (see Phase 3 scope notes in
# docs/superpowers/specs/2026-05-28-takeit-reliability-hardening.md). Not called
# in main() until the per-feature baseline table ships in a follow-up plan.
def feature_zscore(
    today: np.ndarray,
    baseline_mean: float,
    baseline_std: float,
) -> float:
    """Z-score of today's mean against baseline distribution. NaN on zero std."""
    if baseline_std == 0 or np.isnan(baseline_std):
        return float("nan")
    today_mean = float(np.nanmean(today)) if today.size else float("nan")
    if np.isnan(today_mean):
        return float("nan")
    return (today_mean - baseline_mean) / baseline_std


def fetch_recent_fires(
    conn: psycopg2.extensions.connection,
    feed: str,
    lookback_days: int,
    as_of: dt.date,
) -> pd.DataFrame:
    """Fires of `feed` dated from `lookback_days` before `as_of` through `as_of`, with
    a score. Both ends come from `as_of`, so a historical run never reads later fires."""
    table = "lottery_finder_fires" if feed == "lottery" else "silent_boom_alerts"
    sql = f"""
      SELECT
        date,
        underlying_symbol,
        option_type,
        dte,
        takeit_prob,
        takeit_model_version,
        peak_ceiling_pct,
        realized_trail30_10_pct
      FROM {table}
      WHERE date >= %s
        AND date <= %s
        AND takeit_prob IS NOT NULL
        AND peak_ceiling_pct IS NOT NULL
    """
    cutoff = as_of - dt.timedelta(days=lookback_days)
    return pd.read_sql(sql, conn, params=(cutoff, as_of), parse_dates=["date"])


def compute_feed_drift(df: pd.DataFrame, feed: str, as_of: dt.date) -> dict:
    out: dict = {"feed": feed, "n_rows_total": len(df)}
    if df.empty:
        return out

    for window_days, label in [(7, "7d"), (30, "30d")]:
        cutoff = as_of - dt.timedelta(days=window_days)
        win = df[df["date"] >= pd.Timestamp(cutoff)]
        if win.empty:
            continue
        y_pred = win["takeit_prob"].to_numpy()
        peak_label = (win["peak_ceiling_pct"].to_numpy() >= 20).astype(int)
        out[f"auc_{label}_peak"] = rolling_auc(peak_label, y_pred)
        if "realized_trail30_10_pct" in win:
            real_label = (
                win["realized_trail30_10_pct"].fillna(-100).to_numpy() >= 0
            ).astype(int)
            out[f"auc_{label}_realized"] = rolling_auc(real_label, y_pred)

    # Per-segment AUC on 30d window
    cutoff30 = as_of - dt.timedelta(days=30)
    win30 = df[df["date"] >= pd.Timestamp(cutoff30)]
    if not win30.empty:
        y_pred = win30["takeit_prob"].to_numpy()
        peak_label = (win30["peak_ceiling_pct"].to_numpy() >= 20).astype(int)
        dte_seg = (
            pd.cut(
                win30["dte"],
                bins=[-1, 0, 3, 100],
                labels=["0DTE", "1-3", "4+"],
            )
            .astype(str)
            .to_numpy()
        )
        out["by_dte"] = per_segment_auc(peak_label, y_pred, dte_seg)
        out["by_option_type"] = per_segment_auc(
            peak_label,
            y_pred,
            win30["option_type"].astype(str).to_numpy(),
        )

    return out


def render_markdown_report(
    as_of_str: str,
    lottery: dict,
    silent_boom: dict,
) -> str:
    lines: list[str] = []
    lines.append(f"# TAKE-IT drift report — {as_of_str}")
    lines.append("")
    for feed_name, summary in [("lottery", lottery), ("silent_boom", silent_boom)]:
        lines.append(f"## {feed_name}")
        lines.append("")
        lines.append(f"- rows in 30d window: {summary.get('n_rows_total', 0)}")
        for k in ("auc_7d_peak", "auc_30d_peak", "auc_7d_realized", "auc_30d_realized"):
            v = summary.get(k)
            if v is not None:
                if isinstance(v, float) and not np.isnan(v):
                    lines.append(f"- {k}: {v:.3f}")
                else:
                    lines.append(f"- {k}: n/a")
        if "by_dte" in summary:
            lines.append("")
            lines.append("### per-DTE 30d AUC (peak target)")
            for seg, m in summary["by_dte"].items():
                lines.append(f"- {seg}: AUC={m['auc']:.3f}  n={m['n']}")
        if "by_option_type" in summary:
            lines.append("")
            lines.append("### per-option-type 30d AUC (peak target)")
            for seg, m in summary["by_option_type"].items():
                lines.append(f"- {seg}: AUC={m['auc']:.3f}  n={m['n']}")
        lines.append("")
    return "\n".join(lines)


def plot_reliability(
    df: pd.DataFrame, feed: str, as_of: dt.date, plot_dir: Path
) -> Path | None:
    """Write the feed's 30-day reliability curve to `plot_dir`; None without rows."""
    if df.empty:
        return None
    cutoff30 = pd.Timestamp(as_of) - pd.Timedelta(days=30)
    win = df[df["date"] >= cutoff30]
    if win.empty:
        return None
    y_pred = win["takeit_prob"].to_numpy()
    y_true = (win["peak_ceiling_pct"].to_numpy() >= 20).astype(int)
    bins = reliability_bins(y_true, y_pred, n_bins=10)

    as_of_str = as_of.isoformat()
    plot_dir.mkdir(parents=True, exist_ok=True)
    out_path = plot_dir / f"reliability_{feed}_{as_of_str}.png"
    fig, ax = plt.subplots(figsize=(8, 6))
    pred = [b[0] for b in bins]
    actual = [b[1] for b in bins]
    ax.plot([0, 1], [0, 1], "k--", label="perfect calibration")
    ax.plot(pred, actual, "o-", label=feed)
    ax.set_xlabel("predicted prob (bin mean)")
    ax.set_ylabel("actual rate (peak >= 20%)")
    ax.set_title(f"TAKE-IT reliability — {feed} — 30d ending {as_of_str}")
    ax.legend()
    ax.grid(alpha=0.3)
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    return out_path


@dataclass(frozen=True)
class DriftRun:
    """What one run wrote: the report, the plots that had rows, and the number of
    takeit_health_daily upserts executed (NaN metrics are not written)."""

    report_path: Path
    plot_paths: tuple[Path, ...]
    metrics_written: int


def run_drift(
    conn: psycopg2.extensions.connection,
    as_of: dt.date,
    report_dir: Path,
    plot_dir: Path,
) -> DriftRun:
    """Read both feeds' recent fires, write the report and reliability plots, and
    upsert the AUC metrics for `as_of`. Commits once, after the last upsert.

    On any error the open transaction is rolled back and the error is re-raised;
    a rollback that fails too never replaces it. The caller owns the connection
    and closes it on error.
    """
    try:
        as_of_str = as_of.isoformat()
        lottery_df = fetch_recent_fires(conn, "lottery", 30, as_of)
        sb_df = fetch_recent_fires(conn, "silent_boom", 30, as_of)

        lottery_summary = compute_feed_drift(lottery_df, "lottery", as_of)
        sb_summary = compute_feed_drift(sb_df, "silent_boom", as_of)

        plots = (
            plot_reliability(lottery_df, "lottery", as_of, plot_dir),
            plot_reliability(sb_df, "silent_boom", as_of, plot_dir),
        )

        report = render_markdown_report(as_of_str, lottery_summary, sb_summary)
        report_dir.mkdir(parents=True, exist_ok=True)
        report_path = report_dir / f"takeit-drift-{as_of_str}.md"
        report_path.write_text(report, encoding="utf-8")

        # Persist key metrics to takeit_health_daily (ml_-prefixed names)
        metrics_written = 0
        with conn.cursor() as cur:
            for feed_name, s in (
                ("lottery", lottery_summary),
                ("silent_boom", sb_summary),
            ):
                for key in (
                    "auc_7d_peak",
                    "auc_30d_peak",
                    "auc_7d_realized",
                    "auc_30d_realized",
                ):
                    val = s.get(key)
                    if val is None or (isinstance(val, float) and np.isnan(val)):
                        continue
                    cur.execute(
                        """
                        INSERT INTO takeit_health_daily
                          (date, feed, metric_name, metric_value)
                        VALUES (%s, %s, %s, %s)
                        ON CONFLICT (date, feed, metric_name)
                        DO UPDATE SET
                          metric_value = EXCLUDED.metric_value,
                          computed_at = NOW()
                        """,
                        (as_of, feed_name, f"ml_{key}", float(val)),
                    )
                    metrics_written += 1
        conn.commit()
        return DriftRun(
            report_path=report_path,
            plot_paths=tuple(p for p in plots if p is not None),
            metrics_written=metrics_written,
        )
    except Exception:
        try:
            conn.rollback()
        except Exception as rollback_error:
            # Class name only: a database error message can name the host.
            print(f"rollback failed: {type(rollback_error).__name__}", file=sys.stderr)
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Daily TAKE-IT drift monitor")
    parser.add_argument(
        "--as-of",
        type=dt.date.fromisoformat,
        default=None,
        help="session date, YYYY-MM-DD (default: today)",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=DOCS_TMP,
        help="where the markdown report goes (default: docs/tmp)",
    )
    parser.add_argument(
        "--plot-dir",
        type=Path,
        default=PLOT_DIR,
        help="where the reliability plots go (default: ml/plots/takeit-drift)",
    )
    args = parser.parse_args(argv)
    as_of = args.as_of or dt.date.today()

    from utils import get_connection  # type: ignore[import-not-found]

    conn = get_connection()
    try:
        run = run_drift(conn, as_of, args.out_dir, args.plot_dir)
    finally:
        conn.close()
    print(f"Wrote {run.report_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
