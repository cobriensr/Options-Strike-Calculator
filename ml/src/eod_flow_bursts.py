"""
Bot EOD options flow — burst candidate ranking + per-candidate viz.

Reads the bucket aggregation Parquet from `eod_flow_buckets.py`
(both 1-min and 5-min) and produces:

  Per bucket size, per trading day:
    ml/plots/eod-flow-bursts/bucket={N}min/date=YYYY-MM-DD/
        candidates.csv   — ALL buckets with composite_score >= p90 for
                           that (symbol, day), sorted desc by score.
        summary.csv      — Top 20 per day for quick eyeball.

  For 5-min buckets only (signal is too noisy to visualize at 1-min):
    ml/plots/eod-flow-bursts/bucket=5min/date=YYYY-MM-DD/
        top{k:02}_{symbol}_{strike}{type}_{HHMM}.png  — 3-panel view:
           - Spot trace ±30 min around the burst, burst band highlighted
           - Cumulative volume on THIS contract, burst band highlighted
           - Print scatter inside the burst (premium vs time, colored
             by aggression)

The composite score and p90 floor come from the bucket table itself
(both are columns / quantiles computed over per-symbol-per-day groups).

Usage:
  ml/.venv/bin/python src/eod_flow_bursts.py [--top-k 20]
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

try:
    import duckdb
    import matplotlib.dates as mdates
    import matplotlib.pyplot as plt
    import pandas as pd
    import seaborn as sns
except ImportError as e:
    print(f"Missing dependency: {e}")
    print("  ml/.venv/bin/pip install duckdb pandas matplotlib seaborn")
    sys.exit(1)

from utils import (  # noqa: E402
    ML_ROOT,
    save_section_findings,
    section,
    subsection,
    takeaway,
)

FLOW_PARQUET_ROOT = ML_ROOT / "data" / "eod-flow"
BUCKETS_PARQUET_ROOT = ML_ROOT / "data" / "eod-flow-buckets"
PLOT_ROOT = ML_ROOT / "plots" / "eod-flow-bursts"

BUCKET_SIZES: tuple[int, ...] = (1, 5)
# Only render per-candidate plots for this bucket size.
VIZ_BUCKET_MIN = 5
# Floor for the CSV: composite_score >= this quantile within
# (symbol, date). 0.9 = top 10% of buckets per symbol-day.
CANDIDATE_FLOOR = 0.90
# Hard floor — any bucket below this premium is noise regardless of
# percentile. $10k cleans out the single-contract / $50 lottery tickets
# that otherwise flood the far-OTM tail.
MIN_PREMIUM_FLOOR = 10_000.0
# Minimum distance from spot. Strikes within ±0.3% of spot are ATM
# and are dominated by opening-auction / dealer-making flow that's
# balanced and huge — drowns out the smaller directional bursts we
# actually want.
MIN_MONEYNESS_PCT = 0.003

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
        # Treat '$' as a literal character — we use it in titles for
        # dollar amounts, not as a math-mode delimiter.
        "text.parse_math": False,
    }
)

COLORS = {
    "buy": "#2ecc71",
    "sell": "#e74c3c",
    "mid": "#95a5a6",
    "spot": "#3498db",
    "cumvol": "#f39c12",
    "highlight": "#9b59b6",
}


def _sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


# ── Candidate ranking ─────────────────────────────────────


def _rank_candidates(
    conn: duckdb.DuckDBPyConnection,
    bucket_min: int,
    *,
    min_premium: float = MIN_PREMIUM_FLOOR,
    include_itm: bool = False,
) -> pd.DataFrame:
    """Rank and filter burst candidates.

    Score formula — calibrated from the premium-threshold discovery in
    `eod_flow_premium_threshold.py`, which showed that touch rate rises
    monotonically with premium ONLY in the 0.3-1% OTM band, and goes
    to zero beyond 1% OTM at any premium level:

        log10(1 + total_premium)
            -- dollar scale (3..7 typical).

        + 3.0 * GREATEST(0, 1 - abs(moneyness_pct) / 0.010)
            -- proximity-to-ATM. +3 at ATM, +1.5 at 0.5% OTM, 0 at
            -- 1% OTM and beyond. Replaces the old "20 * |mny|"
            -- term that was exactly inverted from the empirical signal.

        + (COALESCE(buy_premium_pct, 0.5) - 0.5)
            -- minor buy-skew tiebreaker (-0.5..+0.5). Aggression is
            -- irrelevant for the gamma-magnet hypothesis; kept only to
            -- break ties between otherwise-identical bursts.

    Filters:
      - total_premium >= min_premium (default $10k — drops lottery tickets)
      - abs(moneyness_pct) >= MIN_MONEYNESS_PCT (drops ATM noise)
      - is_otm = TRUE unless include_itm
      - composite_score >= p90 within (symbol, date)
    """
    glob = str(
        BUCKETS_PARQUET_ROOT / f"bucket={bucket_min}min" / "date=*" / "data.parquet"
    )
    itm_clause = "" if include_itm else "AND is_otm = TRUE"
    return conn.execute(
        f"""
        WITH raw AS (
            SELECT
                *,
                CAST(bucket_start AS DATE) AS date
            FROM read_parquet('{glob}', hive_partitioning = true)
            WHERE total_premium >= {min_premium}
              AND abs(moneyness_pct) >= {MIN_MONEYNESS_PCT}
              {itm_clause}
        ),
        scored AS (
            SELECT
                *,
                CAST(
                    log10(1 + total_premium)
                    + 3.0 * GREATEST(0, 1 - abs(moneyness_pct) / 0.010)
                    + (COALESCE(buy_premium_pct, 0.5) - 0.5)
                    AS DOUBLE
                ) AS composite_score
            FROM raw
        ),
        thresh AS (
            SELECT
                symbol,
                date,
                quantile_cont(composite_score, {CANDIDATE_FLOOR}) AS floor_score
            FROM scored
            GROUP BY symbol, date
        ),
        ranked AS (
            SELECT
                s.*,
                ROW_NUMBER() OVER (
                    PARTITION BY s.symbol, s.date
                    ORDER BY s.composite_score DESC
                ) AS rank_in_day_symbol,
                ROW_NUMBER() OVER (
                    PARTITION BY s.date
                    ORDER BY s.composite_score DESC
                ) AS rank_in_day
            FROM scored s
            JOIN thresh t USING (symbol, date)
            WHERE s.composite_score >= t.floor_score
        )
        SELECT
            date,
            bucket_start,
            bucket_end,
            symbol,
            option_chain_id,
            strike,
            option_type,
            expiry,
            is_otm,
            n_prints,
            total_volume,
            total_premium,
            max_print_premium,
            buy_volume,
            sell_volume,
            mid_volume,
            buy_vol_pct,
            sell_vol_pct,
            buy_premium_pct,
            bucket_spot,
            spot_min,
            spot_max,
            moneyness_pct,
            composite_score,
            rank_in_day,
            rank_in_day_symbol
        FROM ranked
        ORDER BY date ASC, composite_score DESC
        """
    ).fetchdf()


# ── Per-candidate context data ───────────────────────────


def _load_spot_trace(
    conn: duckdb.DuckDBPyConnection,
    symbol: str,
    date_str: str,
) -> pd.DataFrame:
    """Minute-bucket spot trace for one (symbol, date).

    Aggregates underlying_price from the raw prints into per-minute
    medians — sub-second noise is irrelevant for the ±30m context
    window.
    """
    parquet = FLOW_PARQUET_ROOT / f"date={date_str}" / "data.parquet"
    if not parquet.exists():
        return pd.DataFrame()
    return conn.execute(
        f"""
        SELECT
            time_bucket(INTERVAL 1 MINUTE, executed_at) AS ts,
            MEDIAN(underlying_price) AS spot
        FROM read_parquet({_sql_string(str(parquet))})
        WHERE underlying_symbol = {_sql_string(symbol)}
          AND underlying_price IS NOT NULL
        GROUP BY 1
        ORDER BY 1
        """
    ).fetchdf()


def _load_contract_session(
    conn: duckdb.DuckDBPyConnection,
    option_chain_id: str,
    date_str: str,
) -> pd.DataFrame:
    """Every print of one contract for one day (for cum-volume + scatter)."""
    parquet = FLOW_PARQUET_ROOT / f"date={date_str}" / "data.parquet"
    if not parquet.exists():
        return pd.DataFrame()
    return conn.execute(
        f"""
        SELECT
            executed_at,
            size,
            premium,
            price,
            aggression_side
        FROM read_parquet({_sql_string(str(parquet))})
        WHERE option_chain_id = {_sql_string(option_chain_id)}
        ORDER BY executed_at
        """
    ).fetchdf()


# ── Per-candidate plot ───────────────────────────────────


def _plot_candidate(
    candidate: pd.Series,
    spot_trace: pd.DataFrame,
    contract_session: pd.DataFrame,
    out_path: Path,
) -> None:
    bucket_start = pd.to_datetime(candidate["bucket_start"])
    bucket_end = pd.to_datetime(candidate["bucket_end"])
    symbol = candidate["symbol"]
    strike = candidate["strike"]
    option_type = candidate["option_type"]

    fig, axes = plt.subplots(
        3, 1, figsize=(11, 9), constrained_layout=True, sharex=False
    )

    # Panel 1: spot trace ±30 min around the burst.
    ax = axes[0]
    if not spot_trace.empty:
        window_lo = bucket_start - pd.Timedelta(minutes=30)
        window_hi = bucket_end + pd.Timedelta(minutes=30)
        mask = (spot_trace["ts"] >= window_lo) & (spot_trace["ts"] <= window_hi)
        window = spot_trace.loc[mask]
        if not window.empty:
            ax.plot(
                window["ts"],
                window["spot"],
                color=COLORS["spot"],
                linewidth=1.2,
            )
    ax.axvspan(
        bucket_start, bucket_end, alpha=0.30, color=COLORS["highlight"], label="burst"
    )
    ax.axhline(
        candidate["strike"],
        color=COLORS["sell"] if option_type == "put" else COLORS["buy"],
        linestyle="--",
        linewidth=0.9,
        alpha=0.8,
        label=f"strike {strike}",
    )
    ax.legend(loc="upper right", fontsize=8, facecolor="#1a1a2e", edgecolor="#555")
    ax.set_ylabel(f"{symbol} spot", fontsize=9)
    ax.set_title(
        f"{symbol} spot ±30 min (burst 3-panel)",
        color="#fff",
        fontsize=10,
    )
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M"))

    # Panel 2: cumulative volume on the contract for the whole session.
    ax = axes[1]
    if not contract_session.empty:
        cs = contract_session.copy()
        cs["cum_vol"] = cs["size"].cumsum()
        ax.plot(cs["executed_at"], cs["cum_vol"], color=COLORS["cumvol"], linewidth=1.2)
    ax.axvspan(bucket_start, bucket_end, alpha=0.30, color=COLORS["highlight"])
    ax.set_ylabel("cum contracts\n(this contract)", fontsize=9)
    ax.set_title(
        f"{candidate['option_chain_id']}  "
        f"— {int(candidate['total_volume']):,} contracts in burst, "
        f"${candidate['total_premium'] / 1000:,.0f}k premium, "
        f"buy={candidate['buy_premium_pct'] * 100:.0f}% (by $)",
        color="#fff",
        fontsize=10,
    )
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M"))

    # Panel 3: print scatter inside burst bucket only.
    ax = axes[2]
    if not contract_session.empty:
        mask = (contract_session["executed_at"] >= bucket_start) & (
            contract_session["executed_at"] <= bucket_end
        )
        inside = contract_session.loc[mask]
        if not inside.empty:
            color_map = {
                "buy_aggressive": COLORS["buy"],
                "sell_aggressive": COLORS["sell"],
                "mid": COLORS["mid"],
            }
            colors = inside["aggression_side"].map(color_map).fillna(COLORS["mid"])
            sizes = 8 + (inside["size"].clip(upper=500).astype(float) * 0.6)
            ax.scatter(
                inside["executed_at"],
                inside["premium"],
                s=sizes,
                c=colors,
                alpha=0.7,
                edgecolor="#222",
                linewidth=0.3,
            )
            ax.set_yscale("log")
    ax.set_ylabel("print premium $\n(log)", fontsize=9)
    ax.set_xlabel("time (UTC)", fontsize=9)
    ax.set_title(
        "Prints inside burst bucket — "
        "green=buy@ask, red=sell@bid, gray=mid. Marker size ~ contracts.",
        color="#fff",
        fontsize=10,
    )
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M:%S"))

    mny_pct = candidate["moneyness_pct"] * 100
    side_marker = "↑ call" if option_type == "call" else "↓ put"
    fig.suptitle(
        f"rank {int(candidate['rank_in_day']):02d}  "
        f"{symbol} {int(strike)}{option_type[0].upper()}  "
        f"{bucket_start.strftime('%Y-%m-%d %H:%M UTC')}  "
        f"[{side_marker}, spot={candidate['bucket_spot']:.2f}, "
        f"mny={mny_pct:+.2f}%, score={candidate['composite_score']:.2f}]",
        color="#fff",
        fontsize=11,
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    plt.savefig(out_path, dpi=120)
    plt.close(fig)


# ── Main ──────────────────────────────────────────────────


def _write_candidates_csv(
    candidates: pd.DataFrame, bucket_min: int, date_str: str
) -> tuple[Path, Path]:
    day_root = PLOT_ROOT / f"bucket={bucket_min}min" / f"date={date_str}"
    day_root.mkdir(parents=True, exist_ok=True)

    subset = candidates[candidates["date"] == pd.to_datetime(date_str).date()]
    csv_path = day_root / "candidates.csv"
    subset.to_csv(csv_path, index=False)

    summary_path = day_root / "summary.csv"
    summary_cols = [
        "rank_in_day",
        "bucket_start",
        "symbol",
        "option_chain_id",
        "strike",
        "option_type",
        "bucket_spot",
        "moneyness_pct",
        "n_prints",
        "total_volume",
        "total_premium",
        "buy_premium_pct",
        "composite_score",
    ]
    subset.head(50)[summary_cols].to_csv(summary_path, index=False)
    return csv_path, summary_path


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Rank burst candidates and render per-candidate plots."
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=20,
        help="Number of top candidates per day to visualize (default 20)",
    )
    parser.add_argument(
        "--include-itm",
        action="store_true",
        help=(
            "Also rank ITM contracts. Default excludes ITM because those "
            "bursts are mostly synthetic-stock / hedging plumbing rather "
            "than directional speculation."
        ),
    )
    args = parser.parse_args()

    section(
        f"EOD Flow Bursts — top-{args.top_k}/day plotted (bucket={VIZ_BUCKET_MIN}min), "
        "CSVs for both bucket sizes"
    )

    conn = duckdb.connect()
    conn.execute("PRAGMA threads=4")
    conn.execute("PRAGMA memory_limit='6GB'")

    overall: dict[int, dict] = {}
    t0 = time.monotonic()

    # Rank candidates for BOTH bucket sizes, emit CSVs per (bucket, day).
    for bucket_min in BUCKET_SIZES:
        subsection(f"Rank candidates — {bucket_min}min buckets")
        df = _rank_candidates(conn, bucket_min, include_itm=args.include_itm)
        if df.empty:
            print(f"  No buckets found for {bucket_min}min.")
            continue

        # Normalize date column to python date objects (DuckDB returns date).
        df["date"] = pd.to_datetime(df["date"]).dt.date

        dates = sorted(df["date"].unique())
        print(
            f"  candidates={len(df):,}  "
            f"days={len(dates)}  "
            f"top-score={df['composite_score'].iloc[0]:.2f}"
        )
        for d in dates:
            csv_path, summary_path = _write_candidates_csv(df, bucket_min, str(d))
            n_day = int((df["date"] == d).sum())
            print(f"    {d}: {n_day:>5,} candidates → {csv_path.relative_to(ML_ROOT)}")

        overall[bucket_min] = {
            "n_candidates": int(len(df)),
            "n_days": len(dates),
            "top_score": float(df["composite_score"].iloc[0]),
        }

    # Visualize top-K per (symbol, day) for the chosen bucket size. Each
    # symbol gets its own subfolder under date=YYYY-MM-DD/ so navigation
    # stays organized even when one symbol dominates the absolute ranks.
    subsection(f"Render top-{args.top_k} plots per (symbol, day) ({VIZ_BUCKET_MIN}min)")
    viz = _rank_candidates(conn, VIZ_BUCKET_MIN, include_itm=args.include_itm)
    if viz.empty:
        print(f"  No {VIZ_BUCKET_MIN}min candidates — skipping plots.")
    else:
        viz["date"] = pd.to_datetime(viz["date"]).dt.date
        for d in sorted(viz["date"].unique()):
            day_df = viz[viz["date"] == d]
            if day_df.empty:
                continue
            spot_cache: dict[str, pd.DataFrame] = {}
            for sym in sorted(day_df["symbol"].unique()):
                sym_candidates = (
                    day_df[day_df["symbol"] == sym]
                    .sort_values("composite_score", ascending=False)
                    .head(args.top_k)
                )
                if sym_candidates.empty:
                    continue
                print(f"  {d} {sym}: rendering {len(sym_candidates)} plots...")
                if sym not in spot_cache:
                    spot_cache[sym] = _load_spot_trace(conn, sym, str(d))
                for i, (_, cand) in enumerate(sym_candidates.iterrows(), start=1):
                    cs = _load_contract_session(conn, cand["option_chain_id"], str(d))
                    time_tag = pd.to_datetime(cand["bucket_start"]).strftime("%H%M")
                    plot_name = (
                        f"top{i:02}_{int(cand['strike'])}"
                        f"{cand['option_type'][0].upper()}_{time_tag}.png"
                    )
                    out_path = (
                        PLOT_ROOT
                        / f"bucket={VIZ_BUCKET_MIN}min"
                        / f"date={d}"
                        / sym
                        / plot_name
                    )
                    _plot_candidate(cand, spot_cache[sym], cs, out_path)

    conn.close()
    elapsed = time.monotonic() - t0
    takeaway(
        f"Bursts analysis complete in {elapsed:.1f}s — "
        f"CSVs under {PLOT_ROOT.relative_to(ML_ROOT)}/bucket={{N}}min/date=*/"
    )

    save_section_findings("eod_flow_bursts", {"summary": overall})
    return 0


if __name__ == "__main__":
    sys.exit(main())
