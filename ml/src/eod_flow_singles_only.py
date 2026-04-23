"""
Premium-threshold sweep — SINGLE-LEG PRINTS ONLY (SPXW).

Raw-data re-analysis triggered by Finding 2 in docs/0dte-findings.md:
multi-leg conditions (`mlet`/`mlat`) account for ~35% of 0DTE premium,
and 37-39% of their prints fall in the 0.3-1% signal band. Those are
spread legs, not directional bets. If our previous premium-threshold
result was driven by spread-leg contamination, filtering to single-leg
conditions only (`auto`, `slan`) should change the signal.

This script reads SPXW prints directly from the raw CSVs (to access
the `upstream_condition_detail` column, which is NOT in the current
bucket Parquet), filters to single-leg conds, runs the same threshold
sweep as `eod_flow_premium_threshold.py`, and prints it side-by-side
with the all-cond baseline for the same symbol.

Scope: SPXW only (matches the current investigation focus). Extend
later to SPY/QQQ if the pattern holds.

Usage:
  ml/.venv/bin/python src/eod_flow_singles_only.py
"""

from __future__ import annotations

import sys
import time

try:
    import duckdb
    import matplotlib.pyplot as plt
    import pandas as pd
    import seaborn as sns
except ImportError as e:
    print(f"Missing dependency: {e}")
    sys.exit(1)

from utils import (  # noqa: E402
    ML_ROOT,
    save_section_findings,
    section,
    subsection,
    takeaway,
)

CSV_GLOB = "/Users/charlesobrien/Downloads/EOD-OptionFlow/bot-eod-report-*.csv"
PLOT_ROOT = ML_ROOT / "plots" / "eod-flow-singles-only"
PLOT_ROOT.mkdir(parents=True, exist_ok=True)

SINGLE_LEG_CONDS: tuple[str, ...] = ("auto", "slan")
BUCKET_MINUTES = 5  # match main pipeline

# Same bins as premium_threshold for direct comparison
DISTANCE_BUCKETS = (
    (0.003, 0.005, "0.3-0.5%"),
    (0.005, 0.010, "0.5-1%"),
    (0.010, 0.015, "1-1.5%"),
    (0.015, 0.020, "1.5-2%"),
    (0.020, 0.030, "2-3%"),
    (0.030, 1.000, "3%+"),
)
PREMIUM_THRESHOLDS = (
    1_000,
    5_000,
    25_000,
    50_000,
    100_000,
    250_000,
    500_000,
    1_000_000,
)
MIN_CELL_N = 10
PATH_MAX_MINUTES = 120
SESSION_END_UTC_HOUR = 20

sns.set_theme(style="darkgrid", palette="muted")
plt.rcParams.update(
    {
        "figure.facecolor": "#1a1a2e",
        "axes.facecolor": "#16213e",
        "axes.edgecolor": "#555",
        "axes.labelcolor": "#ccc",
        "text.color": "#ccc",
        "xtick.color": "#aaa",
        "ytick.color": "#aaa",
        "grid.color": "#333",
        "grid.alpha": 0.5,
        "font.size": 9,
        "text.parse_math": False,
    }
)


def _build_view(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute(f"""
        CREATE VIEW spxw AS
        SELECT
            executed_at,
            CAST(executed_at AS DATE) AS date,
            option_chain_id,
            CAST(strike AS DOUBLE) AS strike,
            option_type,
            CAST(underlying_price AS DOUBLE) AS spot,
            CAST(size AS INTEGER) AS size,
            CAST(premium AS DOUBLE) AS premium,
            CAST(price AS DOUBLE) AS price,
            side,
            upstream_condition_detail AS cond,
            date_diff('day', CAST(executed_at AS DATE), CAST(expiry AS DATE)) AS dte,
            (CAST(strike AS DOUBLE) - CAST(underlying_price AS DOUBLE))
                / CAST(underlying_price AS DOUBLE) AS mny
        FROM read_csv_auto('{CSV_GLOB}', header=true)
        WHERE underlying_symbol = 'SPXW'
          AND (canceled IS NULL OR canceled = FALSE)
    """)


def _aggregate_buckets(
    conn: duckdb.DuckDBPyConnection,
    cond_filter: tuple[str, ...] | None,
) -> pd.DataFrame:
    """5-min buckets per contract, 0DTE only, OTM only. Optional cond filter."""
    cond_clause = ""
    if cond_filter:
        quoted = ", ".join(f"'{c}'" for c in cond_filter)
        cond_clause = f"AND cond IN ({quoted})"

    return conn.execute(f"""
        WITH prints AS (
            SELECT
                *,
                time_bucket(INTERVAL {BUCKET_MINUTES} MINUTE, executed_at) AS bucket_start
            FROM spxw
            WHERE dte = 0
              AND (
                  (option_type = 'call' AND strike > spot)
               OR (option_type = 'put'  AND strike < spot)
              )
              AND abs(mny) >= 0.003
              {cond_clause}
        )
        SELECT
            option_chain_id,
            any_value(strike) AS strike,
            any_value(option_type) AS option_type,
            CAST(bucket_start AS DATE) AS date,
            bucket_start,
            bucket_start + INTERVAL {BUCKET_MINUTES} MINUTE AS bucket_end,
            COUNT(*)::INTEGER AS n_prints,
            SUM(size)::INTEGER AS total_volume,
            CAST(SUM(premium) AS DOUBLE) AS total_premium,
            CAST(MEDIAN(spot) AS DOUBLE) AS bucket_spot,
            CAST(
                (any_value(strike) - MEDIAN(spot)) / MEDIAN(spot)
                AS DOUBLE
            ) AS moneyness_pct
        FROM prints
        GROUP BY option_chain_id, bucket_start
        HAVING COUNT(*) >= 1 AND SUM(premium) >= 1000
    """).fetchdf()


def _load_minute_spot(conn: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    """Per-minute median spot from ALL SPXW prints (not cond-filtered)."""
    df = conn.execute("""
        SELECT
            CAST(executed_at AS DATE) AS date,
            time_bucket(INTERVAL 1 MINUTE, executed_at) AS ts,
            MEDIAN(spot) AS spot_med,
            MIN(spot)    AS spot_min,
            MAX(spot)    AS spot_max
        FROM spxw
        WHERE spot IS NOT NULL
        GROUP BY 1, 2
        ORDER BY 1, 2
    """).fetchdf()
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    return df


def _attach_path_stats(
    buckets: pd.DataFrame, minute_spot: pd.DataFrame
) -> pd.DataFrame:
    """Touch rate, MFE, MAE per bucket, using minute-high/low.

    Observation window: (bucket_end, min(bucket_end + PATH_MAX, session_end)].
    """
    out = buckets.copy()
    out["bucket_end"] = pd.to_datetime(out["bucket_end"], utc=True)
    out["touched_strike"] = False
    out["peak_toward_bps"] = 0.0
    out["peak_against_bps"] = 0.0
    out["distance_to_strike_bps"] = pd.NA

    ms_by_date = {d: g.sort_values("ts") for d, g in minute_spot.groupby("date")}

    for idx, row in out.iterrows():
        be = row["bucket_end"]
        base_spot = row["bucket_spot"]
        strike = row["strike"]
        direction = 1 if row["option_type"] == "call" else -1
        date = row["date"]
        spot_day = ms_by_date.get(date)
        if spot_day is None or base_spot is None or base_spot <= 0:
            continue
        session_end = be.replace(
            hour=SESSION_END_UTC_HOUR, minute=0, second=0, microsecond=0
        )
        hard_cap = be + pd.Timedelta(minutes=PATH_MAX_MINUTES)
        window_end = min(session_end, hard_cap)
        if window_end <= be:
            continue
        window = spot_day[(spot_day["ts"] > be) & (spot_day["ts"] <= window_end)]
        if window.empty:
            continue

        dist_bps = abs(strike - base_spot) / base_spot * 1e4
        out.at[idx, "distance_to_strike_bps"] = float(dist_bps)

        if direction > 0:
            touched = (window["spot_max"] >= strike).any()
            toward = (window["spot_max"] - base_spot) / base_spot * direction * 1e4
            against = (window["spot_min"] - base_spot) / base_spot * direction * 1e4
        else:
            touched = (window["spot_min"] <= strike).any()
            toward = (window["spot_min"] - base_spot) / base_spot * direction * 1e4
            against = (window["spot_max"] - base_spot) / base_spot * direction * 1e4

        out.at[idx, "touched_strike"] = bool(touched)
        out.at[idx, "peak_toward_bps"] = max(float(toward.max()), 0.0)
        out.at[idx, "peak_against_bps"] = max(-float(against.min()), 0.0)

    return out


def _threshold_sweep(df: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for _lo, _hi, dist_label in DISTANCE_BUCKETS:
        for thresh in PREMIUM_THRESHOLDS:
            cell = df[
                (df["distance_bucket"] == dist_label) & (df["total_premium"] >= thresh)
            ]
            if len(cell) < MIN_CELL_N:
                continue
            rows.append(
                {
                    "distance_bucket": dist_label,
                    "threshold": thresh,
                    "n": len(cell),
                    "touch_pct": float(cell["touched_strike"].mean() * 100),
                    "median_mfe_bps": float(cell["peak_toward_bps"].median()),
                    "median_mae_bps": float(cell["peak_against_bps"].median()),
                }
            )
    return pd.DataFrame(rows)


def _assign_distance_bucket(df: pd.DataFrame) -> pd.DataFrame:
    def label(mny):
        m = abs(mny)
        for lo, hi, label_ in DISTANCE_BUCKETS:
            if lo <= m < hi:
                return label_
        return None

    out = df.copy()
    out["distance_bucket"] = out["moneyness_pct"].map(label)
    return out


def _plot_comparison(all_cond: pd.DataFrame, singles: pd.DataFrame) -> None:
    fig, axes = plt.subplots(
        1, 2, figsize=(12, 4.5), sharey=True, constrained_layout=True
    )
    cmap = plt.get_cmap("viridis")
    dists = ["0.3-0.5%", "0.5-1%"]

    for ax, (label, df) in zip(
        axes,
        [("all cond", all_cond), ("singles only (auto+slan)", singles)],
        strict=True,
    ):
        for i, dist in enumerate(dists):
            line = df[df["distance_bucket"] == dist].sort_values("threshold")
            if line.empty:
                continue
            ax.plot(
                line["threshold"],
                line["touch_pct"],
                marker="o",
                color=cmap(i / max(len(dists) - 1, 1)),
                linewidth=1.5,
                label=dist,
            )
        ax.set_xscale("log")
        ax.set_title(f"SPXW — {label}", color="#fff")
        ax.set_xlabel("premium threshold $ (log)")
        ax.axhline(15, color="#aaa", linewidth=0.8, linestyle="--", alpha=0.5)
        ax.legend(loc="best", fontsize=9, facecolor="#1a1a2e", edgecolor="#555")
    axes[0].set_ylabel("touch %")

    fig.suptitle(
        "SPXW premium-threshold sweep — all conditions vs single-leg only",
        color="#fff",
        fontsize=12,
    )
    out = PLOT_ROOT / "comparison_all_vs_singles.png"
    plt.savefig(out, dpi=130)
    plt.close(fig)
    print(f"  wrote {out.relative_to(ML_ROOT)}")


def main() -> int:
    section("SPXW Premium-Threshold — All Conditions vs Single-Leg Only")

    t0 = time.monotonic()
    conn = duckdb.connect()
    conn.execute("PRAGMA threads=6")
    conn.execute("PRAGMA memory_limit='6GB'")
    _build_view(conn)
    print(f"  view built in {time.monotonic() - t0:.1f}s")

    subsection("Load + bucket ALL-COND 0DTE SPXW OTM prints")
    t = time.monotonic()
    bk_all = _aggregate_buckets(conn, cond_filter=None)
    print(f"  all-cond buckets: {len(bk_all):,} in {time.monotonic() - t:.1f}s")

    subsection(
        f"Load + bucket SINGLE-LEG (cond IN {SINGLE_LEG_CONDS}) 0DTE SPXW OTM prints"
    )
    t = time.monotonic()
    bk_sing = _aggregate_buckets(conn, cond_filter=SINGLE_LEG_CONDS)
    print(f"  singles-only buckets: {len(bk_sing):,} in {time.monotonic() - t:.1f}s")

    subsection("Load minute-spot from ALL SPXW prints")
    t = time.monotonic()
    ms = _load_minute_spot(conn)
    print(f"  spot minutes: {len(ms):,} in {time.monotonic() - t:.1f}s")

    subsection("Attach path stats (all-cond)")
    t = time.monotonic()
    bk_all = _attach_path_stats(bk_all, ms)
    bk_all = _assign_distance_bucket(bk_all)
    print(f"  done in {time.monotonic() - t:.1f}s")

    subsection("Attach path stats (singles-only)")
    t = time.monotonic()
    bk_sing = _attach_path_stats(bk_sing, ms)
    bk_sing = _assign_distance_bucket(bk_sing)
    print(f"  done in {time.monotonic() - t:.1f}s")

    sweep_all = _threshold_sweep(bk_all)
    sweep_all["cohort"] = "all_cond"
    sweep_sing = _threshold_sweep(bk_sing)
    sweep_sing["cohort"] = "singles_only"

    combined = pd.concat([sweep_all, sweep_sing], ignore_index=True)
    combined.to_csv(PLOT_ROOT / "threshold_sweep_comparison.csv", index=False)

    subsection("Results — side-by-side touch rate")
    pivot = combined.pivot_table(
        index=["distance_bucket", "threshold"],
        columns="cohort",
        values="touch_pct",
        aggfunc="first",
    )
    pivot["singles_minus_all"] = pivot.get("singles_only", 0) - pivot.get("all_cond", 0)
    pivot = pivot.reindex(
        index=[
            (d, t)
            for d in ["0.3-0.5%", "0.5-1%", "1-1.5%"]
            for t in PREMIUM_THRESHOLDS
            if (d, t) in pivot.index
        ]
    )
    print()
    print(pivot.round(1).to_string())

    # N comparison — how much did we lose by filtering?
    n_pivot = combined.pivot_table(
        index=["distance_bucket", "threshold"],
        columns="cohort",
        values="n",
        aggfunc="first",
    )
    n_pivot["singles_pct_of_all"] = (
        100 * n_pivot.get("singles_only", 0) / n_pivot.get("all_cond", 1)
    ).round(1)
    print("\n  Sample-size comparison (how many candidates remain after filter):")
    print(n_pivot.round(0).to_string())

    _plot_comparison(sweep_all, sweep_sing)

    conn.close()
    save_section_findings(
        "eod_flow_singles_only",
        {
            "single_leg_conds": list(SINGLE_LEG_CONDS),
            "rows_all_cond": int(len(bk_all)),
            "rows_singles": int(len(bk_sing)),
        },
    )
    takeaway(
        f"Done in {time.monotonic() - t0:.1f}s. See "
        f"{PLOT_ROOT.relative_to(ML_ROOT)}/threshold_sweep_comparison.csv "
        "for full per-cell comparison."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
