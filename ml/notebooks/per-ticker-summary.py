"""Per-ticker drilldown — answers "which tickers actually contribute signal?"

Output:
  - Console table of top 30 tickers by outlier wins
  - CSVs in ml/plots/outlier-discovery/
      per_ticker_summary.csv      — every ticker that produced outliers
      per_ticker_top_directions.csv — for each top ticker, win rate by signed direction
      per_ticker_time_profile.csv — for each top ticker, win rate by time-of-day

Run:
    set -a; source .env.local; set +a
    ml/.venv/bin/python ml/notebooks/per-ticker-summary.py

Spec: docs/superpowers/specs/options-flow-archive-2026-04-28.md (Phase 5/6 viz)
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import polars as pl

_SRC = Path(__file__).resolve().parent.parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from flow_archive import list_archive_dates, load_flow  # noqa: E402
from flow_outcomes import compute_outcomes, synthesize_minute_bars  # noqa: E402
from flow_outliers import find_outliers  # noqa: E402

MIN_SCORE = int(os.environ.get("MIN_SCORE", "4"))
TOP_N = int(os.environ.get("TOP_N", "30"))
OUT_DIR = Path(__file__).resolve().parent.parent / "plots" / "outlier-discovery"


def _load_pipeline() -> pl.DataFrame:
    dates = list_archive_dates()
    per_day_outliers: list[pl.DataFrame] = []
    for d in dates:
        per_day_outliers.append(find_outliers(d, min_score=MIN_SCORE))
    outliers = pl.concat(per_day_outliers, how="vertical_relaxed")

    needed = outliers["underlying_symbol"].unique().to_list()
    per_day_bars: list[pl.DataFrame] = []
    for d in dates:
        flow_day = load_flow(
            d, tickers=needed,
            columns=["executed_at", "underlying_symbol", "underlying_price"],
        ).collect()
        per_day_bars.append(synthesize_minute_bars(flow_day))
    bars = pl.concat(per_day_bars, how="vertical_relaxed")

    return compute_outcomes(outliers, bars)


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print("→ Running pipeline...")
    t0 = time.perf_counter()
    outcomes = _load_pipeline()
    print(f"  {outcomes.height:,} scored prints in {time.perf_counter() - t0:.1f}s")

    # Per-ticker overall
    summary = (
        outcomes.group_by("underlying_symbol")
        .agg(
            n_outliers=pl.len(),
            n_wins=(pl.col("won") == True).cast(pl.Int32).sum(),  # noqa: E712
            n_losses=(pl.col("won") == False).cast(pl.Int32).sum(),  # noqa: E712
            n_undirected=pl.col("won").is_null().cast(pl.Int32).sum(),
            median_premium_m=(pl.col("premium") / 1_000_000).median(),
            max_premium_m=(pl.col("premium") / 1_000_000).max(),
            ticker_family=pl.col("ticker_family").first(),
        )
        .with_columns(
            n_directed=pl.col("n_wins") + pl.col("n_losses"),
        )
        .with_columns(
            win_rate=pl.when(pl.col("n_directed") > 0)
            .then(pl.col("n_wins") / pl.col("n_directed"))
            .otherwise(None),
        )
        .sort("n_outliers", descending=True)
    )

    print(f"\n→ Writing per_ticker_summary.csv ({summary.height} tickers)")
    summary.write_csv(OUT_DIR / "per_ticker_summary.csv")

    # Console: top N tickers
    top_tickers = summary.head(TOP_N).select(
        ["underlying_symbol", "ticker_family", "n_outliers", "n_wins",
         "n_losses", "n_undirected", "win_rate", "median_premium_m"]
    )
    print(f"\nTop {TOP_N} tickers by outlier count:")
    with pl.Config(tbl_rows=TOP_N, tbl_cols=10, fmt_str_lengths=20, tbl_width_chars=140):
        print(top_tickers)

    # For each of the top 10 tickers, break down by signed_direction
    top10 = summary.head(10)["underlying_symbol"].to_list()
    print(f"\n→ Writing per_ticker_top_directions.csv (top {len(top10)} tickers)")
    by_ticker_direction = (
        outcomes.filter(pl.col("underlying_symbol").is_in(top10))
        .group_by(["underlying_symbol", "signed_direction"])
        .agg(
            n=pl.len(),
            n_wins=(pl.col("won") == True).cast(pl.Int32).sum(),  # noqa: E712
            win_rate=pl.col("won").cast(pl.Float64).mean(),
        )
        .sort(["underlying_symbol", "n"], descending=[False, True])
    )
    by_ticker_direction.write_csv(OUT_DIR / "per_ticker_top_directions.csv")

    # Time-of-day profile for top 10 tickers
    print(f"→ Writing per_ticker_time_profile.csv (top {len(top10)} tickers)")
    by_ticker_time = (
        outcomes.filter(pl.col("underlying_symbol").is_in(top10))
        .group_by(["underlying_symbol", "time_bucket"])
        .agg(
            n=pl.len(),
            win_rate=pl.col("won").cast(pl.Float64).mean(),
        )
        .sort(["underlying_symbol", "time_bucket"])
    )
    by_ticker_time.write_csv(OUT_DIR / "per_ticker_time_profile.csv")

    # Quick analysis: which tickers are worth focusing on?
    # Heuristic: n_directed >= 20 AND win_rate >= 0.55 = "ready to trust"
    candidates = summary.filter(
        (pl.col("n_directed") >= 20) & (pl.col("win_rate") >= 0.55)
    ).sort("win_rate", descending=True)
    print(f"\n*** Tickers worth focusing on (n_directed≥20 AND win_rate≥55%): "
          f"{candidates.height} of {summary.height}")
    if not candidates.is_empty():
        with pl.Config(tbl_rows=20, tbl_cols=10, fmt_str_lengths=20, tbl_width_chars=140):
            print(candidates.select(
                ["underlying_symbol", "ticker_family", "n_directed",
                 "win_rate", "median_premium_m"]
            ))

    print(f"\nDone in {time.perf_counter() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
