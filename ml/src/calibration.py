"""
Phase 3: Calibration dashboard for TRACE Live ML predictions.

Reads trace_live_analyses rows that have been joined with actual_close
(populated by the post-close fetch-outcomes cron), computes error metrics
across regime / confidence / stability_pct buckets, and produces five
diagnostic plots.

Was the model honest about its confidence labels?
  - "high confidence" predictions should pin tighter than "low confidence"
  - accuracy should NOT degrade below the stability_pct threshold the
    prompt assumes

Output plots  → ml/plots/calibration-*.png
Output JSON   → ml/findings/calibration-{YYYY-MM-DD}.json

Usage:
    ml/.venv/bin/python ml/src/calibration.py
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import psycopg2

# ── Paths ────────────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_LOCAL = REPO_ROOT / ".env.local"
PLOTS_DIR = REPO_ROOT / "ml" / "plots"
FINDINGS_DIR = REPO_ROOT / "ml" / "findings"

# ── Thresholds ───────────────────────────────────────────────────────────────

HIT_THRESHOLDS = [5, 10, 15]  # ±$N hit windows
MIN_TOTAL_ROWS = 50            # skip gracefully if insufficient data
MIN_BUCKET_ROWS = 10           # warn (but proceed) if a bucket is smaller

# Confidence levels from the enum in the prompt (ordered worst → best)
CONFIDENCE_ORDER = ["no_trade", "low", "medium", "high"]


# ── Environment loading ───────────────────────────────────────────────────────

def load_env() -> None:
    """Load .env.local into os.environ if present (prefer over env var)."""
    if not ENV_LOCAL.exists():
        return
    for line in ENV_LOCAL.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip().strip('"'))


# ── Database load ─────────────────────────────────────────────────────────────

def _column_exists(conn, table: str, column: str) -> bool:
    """Return True if column exists in table (Postgres information_schema check)."""
    sql = """
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = %s AND column_name = %s
    LIMIT 1
    """
    with conn.cursor() as cur:
        cur.execute(sql, (table, column))
        return cur.fetchone() is not None


def load_trace_outcomes(conn) -> pd.DataFrame:
    """
    Pull TRACE Live rows that have been joined with actual outcomes.
    Only rows with actual_close IS NOT NULL are useful for calibration.

    Returns an empty DataFrame if the table or the actual_close column
    does not yet exist (Phase 1 migration may not have run).
    """
    # Guard: actual_close column may not exist if Phase 1 migration hasn't run
    if not _column_exists(conn, "trace_live_analyses", "actual_close"):
        print(
            "[warn] Column actual_close does not exist in trace_live_analyses. "
            "Phase 1 migration (fetch-outcomes) has not run yet.",
            file=sys.stderr,
        )
        return pd.DataFrame(
            columns=[
                "id", "captured_at", "regime", "confidence",
                "stability_pct", "predicted_close", "actual_close", "full_response",
            ]
        )

    sql = """
    SELECT
        id,
        captured_at,
        regime,
        confidence,
        stability_pct,
        predicted_close,
        actual_close,
        full_response
    FROM trace_live_analyses
    WHERE actual_close IS NOT NULL
    ORDER BY captured_at ASC
    """
    print("[query] loading trace_live_analyses with actual_close...", file=sys.stderr)
    df = pd.read_sql_query(sql, conn)
    print(f"[query] got {len(df)} rows", file=sys.stderr)
    return df


# ── Feature engineering ───────────────────────────────────────────────────────

def compute_errors(df: pd.DataFrame) -> pd.DataFrame:
    """Add error columns and hit flags to the DataFrame."""
    df = df.copy()

    # Coerce to numeric (schema guarantees NUMERIC but read_sql gives Decimal)
    df["predicted_close"] = pd.to_numeric(df["predicted_close"], errors="coerce")
    df["actual_close"] = pd.to_numeric(df["actual_close"], errors="coerce")
    df["stability_pct"] = pd.to_numeric(df["stability_pct"], errors="coerce")

    df["error"] = df["actual_close"] - df["predicted_close"]
    df["abs_error"] = df["error"].abs()

    for thr in HIT_THRESHOLDS:
        df[f"hit_{thr}pt"] = (df["abs_error"] <= thr).astype(int)

    return df


def assign_stability_tertile(df: pd.DataFrame) -> pd.DataFrame:
    """Compute stability tertile labels from the loaded data's percentiles."""
    df = df.copy()
    q33 = df["stability_pct"].quantile(0.333)
    q67 = df["stability_pct"].quantile(0.667)
    print(
        f"[tertile] stability_pct p33={q33:.1f}  p67={q67:.1f}",
        file=sys.stderr,
    )

    conditions = [
        df["stability_pct"] <= q33,
        df["stability_pct"] <= q67,
    ]
    choices = ["low", "mid"]
    df["stability_tertile"] = np.select(conditions, choices, default="high")
    return df


# ── Bucket summary helpers ────────────────────────────────────────────────────

def bucket_summary(df: pd.DataFrame, group_col: str) -> dict[str, dict]:
    """
    Compute per-bucket hit-rate and mean absolute error.

    Returns
    -------
    {bucket_label: {n, hit5, hit10, hit15, mean_abs_error}}
    """
    result: dict[str, dict] = {}
    for bucket, grp in df.groupby(group_col, observed=True):
        n = len(grp)
        if n < MIN_BUCKET_ROWS:
            print(
                f"  [warn] bucket {group_col}={bucket!r} has only {n} rows "
                f"(< {MIN_BUCKET_ROWS} minimum)",
                file=sys.stderr,
            )
        result[str(bucket)] = {
            "n": int(n),
            "hit5": float(grp["hit_5pt"].mean()),
            "hit10": float(grp["hit_10pt"].mean()),
            "hit15": float(grp["hit_15pt"].mean()),
            "mean_abs_error": float(grp["abs_error"].mean()),
        }
    return result


# ── Calibration score ─────────────────────────────────────────────────────────

def compute_calibration_score(by_confidence: dict[str, dict]) -> float:
    """
    Mean absolute deviation between claimed-confidence rank and actual
    hit-rate rank.

    Lower is better. 0.0 = perfectly monotonic (high confidence always has
    the highest hit rate). Possible range: [0, 1].

    Only considers confidence labels that appear in the data and are in
    CONFIDENCE_ORDER. Labels outside CONFIDENCE_ORDER are ignored.
    """
    # Filter to levels present in data and in the known ordering
    present = [c for c in CONFIDENCE_ORDER if c in by_confidence]
    if len(present) < 2:
        return float("nan")

    claimed_ranks = list(range(len(present)))  # 0 = worst, N-1 = best
    hit_rates = [by_confidence[c]["hit10"] for c in present]

    # Rank of actual hit rates (0 = lowest hit rate)
    sorted_by_hr = sorted(range(len(hit_rates)), key=lambda i: hit_rates[i])
    actual_ranks = [0] * len(hit_rates)
    for rank_pos, original_idx in enumerate(sorted_by_hr):
        actual_ranks[original_idx] = rank_pos

    n = len(present)
    deviations = [abs(claimed_ranks[i] - actual_ranks[i]) / max(n - 1, 1) for i in range(n)]
    return float(np.mean(deviations))


# ── Plotting ──────────────────────────────────────────────────────────────────

_BAR_COLORS = {
    f"hit{thr}": color
    for thr, color in zip(HIT_THRESHOLDS, ["#4C8BE3", "#E36B4C", "#50C474"])
}


def _grouped_bar_chart(
    summary: dict[str, dict],
    title: str,
    out_path: Path,
    bucket_order: list[str] | None = None,
) -> None:
    """
    Grouped bar chart: hit-rate at ±$5 / ±$10 / ±$15 for each bucket.
    Bucket order is configurable (e.g. confidence uses CONFIDENCE_ORDER).
    """
    buckets = bucket_order if bucket_order else sorted(summary.keys())
    # Only include buckets that exist in the summary
    buckets = [b for b in buckets if b in summary]

    x = np.arange(len(buckets))
    width = 0.25
    offsets = [-width, 0, width]

    fig, ax = plt.subplots(figsize=(max(8, len(buckets) * 1.8), 5))

    for _i, (thr, offset) in enumerate(zip(HIT_THRESHOLDS, offsets)):
        key = f"hit{thr}"
        rates = [summary[b][key] for b in buckets]
        ns = [summary[b]["n"] for b in buckets]
        bars = ax.bar(
            x + offset,
            rates,
            width,
            label=f"±${thr}",
            color=_BAR_COLORS[key],
            alpha=0.85,
        )
        # Annotate n in the ±$10 bar only to avoid clutter
        if thr == 10:
            for bar, n in zip(bars, ns):
                ax.text(
                    bar.get_x() + bar.get_width() / 2,
                    bar.get_height() + 0.01,
                    f"n={n}",
                    ha="center",
                    va="bottom",
                    fontsize=7,
                    color="#444444",
                )

    ax.set_xticks(x)
    ax.set_xticklabels(buckets, rotation=15, ha="right")
    ax.set_ylim(0, 1.05)
    ax.set_ylabel("Hit Rate")
    ax.set_title(title)
    ax.legend(loc="upper right")
    ax.axhline(0.5, color="grey", linestyle="--", linewidth=0.8, alpha=0.6)
    ax.set_xlabel(None)

    fig.tight_layout()
    fig.savefig(out_path, dpi=140)
    plt.close(fig)
    print(f"[plot] saved {out_path.name}", file=sys.stderr)


def plot_calibration_curve(by_confidence: dict[str, dict], out_path: Path) -> None:
    """
    Dot plot: claimed confidence level (x-axis, ordered worst→best) vs
    actual ±$10 hit rate (y-axis).  Should be monotonically increasing if
    the model is well-calibrated.
    """
    present = [c for c in CONFIDENCE_ORDER if c in by_confidence]
    hit_rates = [by_confidence[c]["hit10"] for c in present]

    fig, ax = plt.subplots(figsize=(7, 4))
    ax.plot(present, hit_rates, marker="o", linewidth=2, color="#4C8BE3", markersize=9)
    for label, hr in zip(present, hit_rates):
        ax.annotate(
            f"{hr:.1%}",
            (label, hr),
            textcoords="offset points",
            xytext=(0, 10),
            ha="center",
            fontsize=9,
        )

    ax.set_ylim(0, 1.05)
    ax.set_ylabel("Hit Rate (±$10)")
    ax.set_xlabel("Claimed Confidence")
    ax.set_title("Calibration Curve: claimed confidence vs actual ±$10 hit rate")
    ax.axhline(0.5, color="grey", linestyle="--", linewidth=0.8, alpha=0.6)
    ax.grid(axis="y", alpha=0.3)

    fig.tight_layout()
    fig.savefig(out_path, dpi=140)
    plt.close(fig)
    print(f"[plot] saved {out_path.name}", file=sys.stderr)


def plot_error_distribution(df: pd.DataFrame, out_path: Path) -> None:
    """
    Histogram of error values: overall (grey) + per-regime overlaid.
    """
    fig, ax = plt.subplots(figsize=(9, 5))

    bins = np.linspace(df["error"].quantile(0.01), df["error"].quantile(0.99), 50)

    ax.hist(
        df["error"].dropna(),
        bins=bins,
        alpha=0.35,
        color="grey",
        label="All",
        density=True,
    )

    regimes = sorted(df["regime"].dropna().unique())
    palette = plt.cm.tab10.colors  # type: ignore[attr-defined]
    for i, regime in enumerate(regimes):
        sub = df.loc[df["regime"] == regime, "error"].dropna()
        if len(sub) < 5:
            continue
        ax.hist(
            sub,
            bins=bins,
            alpha=0.5,
            color=palette[i % len(palette)],
            label=regime,
            density=True,
            histtype="step",
            linewidth=1.5,
        )

    ax.axvline(0, color="black", linestyle="--", linewidth=1, alpha=0.8)
    ax.set_xlabel("Error (actual_close − predicted_close, $)")
    ax.set_ylabel("Density")
    ax.set_title("Error Distribution — overall and per regime")
    ax.legend(loc="upper right", fontsize=8)

    fig.tight_layout()
    fig.savefig(out_path, dpi=140)
    plt.close(fig)
    print(f"[plot] saved {out_path.name}", file=sys.stderr)


# ── Summary JSON ──────────────────────────────────────────────────────────────

def build_summary(
    df: pd.DataFrame,
    by_regime: dict[str, dict],
    by_confidence: dict[str, dict],
    by_stability: dict[str, dict],
    calibration_score: float,
) -> dict:
    return {
        "generated_at": pd.Timestamp.now("UTC").isoformat(),
        "total_rows": int(len(df)),
        "by_regime": by_regime,
        "by_confidence": by_confidence,
        "by_stability": by_stability,
        "calibration_score": calibration_score,
    }


def save_summary(summary: dict, findings_dir: Path) -> Path:
    today = date.today().isoformat()
    out = findings_dir / f"calibration-{today}.json"
    findings_dir.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(summary, indent=2, default=str))
    print(f"[findings] wrote {out}", file=sys.stderr)
    return out


def print_summary(summary: dict) -> None:
    print("\n=== Calibration Summary ===")
    print(f"Total rows: {summary['total_rows']}")
    print(f"Calibration score: {summary['calibration_score']:.4f}  (0=perfect, 1=anti-calibrated)")

    for group_label, group_data in [
        ("By regime", summary["by_regime"]),
        ("By confidence", summary["by_confidence"]),
        ("By stability tertile", summary["by_stability"]),
    ]:
        print(f"\n{group_label}:")
        for bucket, stats in group_data.items():
            print(
                f"  {bucket:20s}  n={stats['n']:4d}  "
                f"hit5={stats['hit5']:.1%}  "
                f"hit10={stats['hit10']:.1%}  "
                f"hit15={stats['hit15']:.1%}  "
                f"mae=${stats['mean_abs_error']:.1f}"
            )


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    load_env()
    PLOTS_DIR.mkdir(parents=True, exist_ok=True)
    FINDINGS_DIR.mkdir(parents=True, exist_ok=True)

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print(
            "[error] DATABASE_URL not set; check .env.local or environment",
            file=sys.stderr,
        )
        sys.exit(1)

    # ── Load ──────────────────────────────────────────────────────────────────
    with psycopg2.connect(db_url) as conn:
        df = load_trace_outcomes(conn)

    if len(df) == 0:
        print(
            "[warn] No rows with actual_close found in trace_live_analyses. "
            "fetch-outcomes cron may not have run yet. Exiting gracefully.",
            file=sys.stderr,
        )
        print(
            "WARNING: 0 outcome rows available — calibration plots skipped. "
            "Re-run after fetch-outcomes cron has populated actual_close."
        )
        sys.exit(0)

    if len(df) < MIN_TOTAL_ROWS:
        print(
            f"[warn] Only {len(df)} rows available (minimum is {MIN_TOTAL_ROWS}). "
            "Proceeding with reduced statistical power — interpret results cautiously.",
            file=sys.stderr,
        )

    # ── Compute features ───────────────────────────────────────────────────────
    df = compute_errors(df)
    df = assign_stability_tertile(df)

    # ── Bucket summaries ───────────────────────────────────────────────────────
    print("[buckets] computing per-bucket statistics...", file=sys.stderr)
    by_regime = bucket_summary(df, "regime")
    by_confidence = bucket_summary(df, "confidence")
    by_stability = bucket_summary(df, "stability_tertile")

    # ── Calibration score ──────────────────────────────────────────────────────
    calibration_score = compute_calibration_score(by_confidence)
    print(f"[score] calibration_score={calibration_score:.4f}", file=sys.stderr)

    # ── Plots ──────────────────────────────────────────────────────────────────
    print("[plots] generating calibration plots...", file=sys.stderr)

    _grouped_bar_chart(
        by_regime,
        title="Hit Rate by Regime (±$5 / ±$10 / ±$15)",
        out_path=PLOTS_DIR / "calibration-by-regime.png",
    )

    _grouped_bar_chart(
        by_confidence,
        title="Hit Rate by Confidence (±$5 / ±$10 / ±$15)",
        out_path=PLOTS_DIR / "calibration-by-confidence.png",
        bucket_order=CONFIDENCE_ORDER,
    )

    _grouped_bar_chart(
        by_stability,
        title="Hit Rate by Stability Tertile (±$5 / ±$10 / ±$15)",
        out_path=PLOTS_DIR / "calibration-by-stability.png",
        bucket_order=["low", "mid", "high"],
    )

    plot_calibration_curve(
        by_confidence,
        out_path=PLOTS_DIR / "calibration-curve.png",
    )

    plot_error_distribution(
        df,
        out_path=PLOTS_DIR / "calibration-error-distribution.png",
    )

    # ── Summary ────────────────────────────────────────────────────────────────
    summary = build_summary(df, by_regime, by_confidence, by_stability, calibration_score)
    save_summary(summary, FINDINGS_DIR)
    print_summary(summary)


if __name__ == "__main__":
    main()
