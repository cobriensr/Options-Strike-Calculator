"""Outlier discovery — Phase 5 of the EOD options flow archive.

Walks the archive day by day, finds outliers via the multi-criteria
scoring, computes touch-ITM win + path diagnostics, and prints a
stratified hit-rate table to stdout.

Run with:
    set -a; source .env.local; set +a
    ml/.venv/bin/python ml/notebooks/outlier-discovery.py

Optional overrides via env:
    MIN_SCORE  — outlier score threshold (default 4)

Spec: docs/superpowers/specs/options-flow-archive-2026-04-28.md (Phase 5)
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import polars as pl

# Allow running this file directly without `pip install -e .` shenanigans.
_SRC = Path(__file__).resolve().parent.parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from flow_archive import list_archive_dates, load_flow  # noqa: E402
from flow_outcomes import compute_outcomes, synthesize_minute_bars  # noqa: E402
from flow_outliers import add_bucket_columns, find_outliers, summarize_outliers  # noqa: E402

MIN_SCORE = int(os.environ.get("MIN_SCORE", "4"))

# Decision-gate thresholds from spec
EDGE_HIT_RATE = 0.60
NO_EDGE_BAND = (0.45, 0.55)
TOO_FEW_PER_DAY = 10
TOO_MANY_PER_DAY = 500


def _h(s: str) -> None:
    print(f"\n{'=' * 70}\n{s}\n{'=' * 70}")


def main() -> int:
    t_start = time.perf_counter()

    # ------------------------------------------------------------------
    _h("1. Inventory")
    dates = list_archive_dates()
    print(f"Archive contains {len(dates)} dates: {dates[0]} → {dates[-1]}")

    if not dates:
        print("ERROR: archive is empty — nothing to analyze", file=sys.stderr)
        return 2

    # ------------------------------------------------------------------
    _h("2. Detection sweep (day-by-day to bound memory)")
    # Loading all 12 days at once materializes ~120M rows × 30 cols ≈ 30 GB.
    # Per-day processing keeps peak RAM at ~3 GB and is semantically correct
    # because outlier scoring has no cross-day dependencies (repeat_print_count
    # resets at session start each day).
    t0 = time.perf_counter()
    per_day_outliers: list[pl.DataFrame] = []
    for d in dates:
        t_day = time.perf_counter()
        day_outliers = find_outliers(d, min_score=MIN_SCORE)
        per_day_outliers.append(day_outliers)
        print(
            f"  {d}  {day_outliers.height:>5,} outliers  "
            f"({time.perf_counter() - t_day:.1f}s)"
        )
    outliers = pl.concat(per_day_outliers, how="vertical_relaxed")
    print(
        f"\nTotal: {outliers.height:,} outliers in {time.perf_counter() - t0:.1f}s"
    )

    if outliers.is_empty():
        print(
            f"WARN: no outliers at min_score={MIN_SCORE} — try lowering the threshold",
            file=sys.stderr,
        )
        return 1

    # Per-day breakdown — sanity check the threshold (spec: 10 < per-day < 500)
    per_day = (
        outliers.with_columns(date=pl.col("executed_at").dt.date())
        .group_by("date")
        .len()
        .sort("date")
    )
    print("\nPer-day outlier counts:")
    for row in per_day.iter_rows(named=True):
        marker = ""
        if row["len"] < TOO_FEW_PER_DAY:
            marker = "  ← under floor"
        elif row["len"] > TOO_MANY_PER_DAY:
            marker = "  ← over ceiling"
        print(f"  {row['date']}  {row['len']:>5,}{marker}")

    median_per_day = per_day["len"].median()
    print(f"\nMedian outliers/day: {median_per_day:.0f}")

    # ------------------------------------------------------------------
    _h("3. Synthesize per-ticker minute bars (day-by-day)")
    # Same memory bound as step 2 — only one day's underlying_price column in
    # RAM at a time. Per-day bars are independent (no cross-day windowing).
    needed_tickers = outliers["underlying_symbol"].unique().to_list()
    print(
        f"Need bars for {len(needed_tickers)} tickers: "
        f"{sorted(needed_tickers)[:10]}{' ...' if len(needed_tickers) > 10 else ''}"
    )

    t0 = time.perf_counter()
    per_day_bars: list[pl.DataFrame] = []
    for d in dates:
        flow_day = (
            load_flow(
                d,
                tickers=needed_tickers,
                columns=["executed_at", "underlying_symbol", "underlying_price"],
            )
            .collect()
        )
        bars_day = synthesize_minute_bars(flow_day)
        per_day_bars.append(bars_day)
    bars = pl.concat(per_day_bars, how="vertical_relaxed")
    print(
        f"Synthesized {bars.height:,} minute bars across {len(needed_tickers)} "
        f"tickers in {time.perf_counter() - t0:.1f}s"
    )

    # ------------------------------------------------------------------
    _h("4. Compute outcomes (touch-ITM win + path diagnostics)")
    t0 = time.perf_counter()
    enriched = compute_outcomes(outliers, bars)
    print(f"Joined outcomes onto {enriched.height:,} outliers in {time.perf_counter() - t0:.1f}s")

    # Summary of the won column
    won_dist = enriched["won"].value_counts().sort("count", descending=True)
    print("\nOverall win/loss distribution:")
    print(won_dist)

    # ------------------------------------------------------------------
    _h("5. Stratified win-rate table")
    # `add_bucket_columns` was already called inside `find_outliers`, so the
    # bucket cols are present. Just summarize.
    summary = summarize_outliers(enriched).filter(pl.col("n") >= 5)
    print(f"\nBuckets with n >= 5 (filtered from full breakdown):")
    print(summary)

    # ------------------------------------------------------------------
    _h("6. Concentration check (uniform = leakage; concentrated = real edge)")
    if "win_rate" in summary.columns:
        edge_buckets = summary.filter(pl.col("win_rate") >= EDGE_HIT_RATE)
        no_edge_buckets = summary.filter(
            (pl.col("win_rate") >= NO_EDGE_BAND[0])
            & (pl.col("win_rate") <= NO_EDGE_BAND[1])
        )
        print(
            f"Buckets with win_rate >= {EDGE_HIT_RATE:.0%}: {edge_buckets.height} "
            f"of {summary.height}"
        )
        if edge_buckets.height > 0:
            print("\n  Edge buckets:")
            print(edge_buckets.sort("win_rate", descending=True))
        print(
            f"\nBuckets in no-edge band ({NO_EDGE_BAND[0]:.0%}–{NO_EDGE_BAND[1]:.0%}): "
            f"{no_edge_buckets.height}"
        )

    # ------------------------------------------------------------------
    _h("7. Path-shape splits within wins")
    won_only = enriched.filter(pl.col("won") == True)  # noqa: E712
    if won_only.is_empty():
        print("No wins to split.")
    else:
        # Quartile of time_to_itm — fast vs slow.
        # `allow_duplicates=True` because many wins ITM in the same minute
        # as the print (time_to_itm_min = 0 has high frequency) — strict
        # quartiles would error out on tied bin edges.
        with_quartile = won_only.with_columns(
            time_to_itm_quartile=pl.col("time_to_itm_min").qcut(
                4,
                labels=["Q1_fast", "Q2", "Q3", "Q4_slow"],
                allow_duplicates=True,
            )
        )
        path_shape = (
            with_quartile.group_by("time_to_itm_quartile")
            .agg(
                n=pl.len(),
                median_mfe_pts=pl.col("mfe_pts").median(),
                close_won_rate=pl.col("close_won").cast(pl.Float64).mean(),
            )
            .sort("time_to_itm_quartile")
        )
        print(path_shape)

    # ------------------------------------------------------------------
    _h(f"DONE in {time.perf_counter() - t_start:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
