"""
Bot EOD options flow — baseline distributions (Phase 0 EDA, 0DTE focus).

Consumes the partitioned Parquet written by `eod_flow_ingest.py`
(`ml/data/eod-flow/date=*/data.parquet`, already filtered to 0 DTE by
default) and answers: "what does normal options flow look like on
these symbols, and where does the long tail start?"

Outputs under `ml/plots/eod-flow-baselines/`:

  Q1  Premium + size percentile table per symbol  → CSV + console
  Q2  Premium log-histogram, one panel per symbol
  Q3  Size log-histogram, one panel per symbol
  Q4  Per-contract option price log-histogram, one panel per symbol
  Q5  Prints-per-minute by time-of-day CT, per symbol
  Q6  Aggression breakdown (buy/mid/sell) per symbol  → stacked bar

Plus a summary in `ml/findings.json` under `eod_flow_baselines`.

All heavy aggregation runs in DuckDB directly against the Parquet
files (no pandas load of the full dataset). Only the small aggregate
result sets come into pandas for plotting.

Usage:
  ml/.venv/bin/python src/eod_flow_baselines.py
"""

from __future__ import annotations

import sys

try:
    import duckdb
    import matplotlib.pyplot as plt
    import numpy as np
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

DATA_GLOB = str(ML_ROOT / "data" / "eod-flow" / "date=*" / "data.parquet")
PLOT_DIR = ML_ROOT / "plots" / "eod-flow-baselines"
PLOT_DIR.mkdir(parents=True, exist_ok=True)

SYMBOL_ORDER = ["SPXW", "SPY", "QQQ", "NDXP"]

# Dark theme — mirrors flow_eda.py so everything matches in ml/plots/.
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
        "font.size": 10,
    }
)

COLORS = {
    "blue": "#3498db",
    "orange": "#f39c12",
    "purple": "#9b59b6",
    "gray": "#95a5a6",
    "buy": "#2ecc71",
    "sell": "#e74c3c",
    "mid": "#95a5a6",
}


# ── DuckDB connection + virtual table ─────────────────────


def _connect() -> duckdb.DuckDBPyConnection:
    """Connect and register the partitioned Parquet as view `flow`."""
    conn = duckdb.connect()
    conn.execute("PRAGMA threads=4")
    conn.execute(
        f"""
        CREATE VIEW flow AS
        SELECT * FROM read_parquet(
            '{DATA_GLOB}',
            hive_partitioning = true
        )
        """
    )
    return conn


# ── Q1: Premium + size percentile table ───────────────────


def q1_percentile_table(conn: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    subsection("Q1: Percentile table per symbol (0DTE)")
    df = conn.execute(
        """
        SELECT
            underlying_symbol AS symbol,
            COUNT(*)::BIGINT  AS n,
            quantile_cont(premium, 0.50)  AS prem_p50,
            quantile_cont(premium, 0.90)  AS prem_p90,
            quantile_cont(premium, 0.99)  AS prem_p99,
            quantile_cont(premium, 0.999) AS prem_p999,
            MAX(premium)                  AS prem_max,
            quantile_cont(size, 0.50)     AS size_p50,
            quantile_cont(size, 0.90)     AS size_p90,
            quantile_cont(size, 0.99)     AS size_p99,
            quantile_cont(size, 0.999)    AS size_p999,
            MAX(size)                     AS size_max,
            quantile_cont(vol_oi_ratio, 0.99)  AS voi_p99,
            quantile_cont(vol_oi_ratio, 0.999) AS voi_p999,
            SUM(CASE WHEN aggression_side = 'buy_aggressive'
                     THEN 1 ELSE 0 END)::BIGINT AS n_buy,
            SUM(CASE WHEN aggression_side = 'sell_aggressive'
                     THEN 1 ELSE 0 END)::BIGINT AS n_sell,
            SUM(CASE WHEN aggression_side = 'mid'
                     THEN 1 ELSE 0 END)::BIGINT AS n_mid
        FROM flow
        WHERE premium > 0
        GROUP BY 1
        ORDER BY 1
        """
    ).fetchdf()

    csv_path = PLOT_DIR / "q1_percentiles.csv"
    df.to_csv(csv_path, index=False)
    print(f"  wrote {csv_path.relative_to(ML_ROOT)}  ({len(df)} rows)")

    prem = df[
        ["symbol", "n", "prem_p50", "prem_p90", "prem_p99", "prem_p999", "prem_max"]
    ].copy()
    for c in ("prem_p50", "prem_p90", "prem_p99", "prem_p999", "prem_max"):
        prem[c] = prem[c].map(lambda v: f"${v:>12,.0f}")
    prem["n"] = prem["n"].map(lambda v: f"{v:>10,}")
    print()
    print(prem.to_string(index=False))

    sz = df[
        ["symbol", "size_p50", "size_p90", "size_p99", "size_p999", "size_max"]
    ].copy()
    for c in ("size_p50", "size_p90", "size_p99", "size_p999", "size_max"):
        sz[c] = sz[c].map(lambda v: f"{v:>10,.0f}")
    print()
    print("  Size (contracts):")
    print(sz.to_string(index=False))
    return df


# ── Q2/Q3/Q4: Log-scale distribution plots ────────────────


def _log_hist_bins(
    conn: duckdb.DuckDBPyConnection,
    column: str,
    *,
    bins_per_decade: int = 4,
) -> pd.DataFrame:
    """Precompute log10(column) bin counts per symbol.

    Running this in DuckDB avoids materializing the full 0DTE dataset
    into pandas. `bins_per_decade=4` gives 0.25-decade resolution
    (a bin every ~1.78× in linear space) which is dense enough to
    see distribution shape, sparse enough to keep the chart legible.
    """
    return conn.execute(
        f"""
        SELECT
            underlying_symbol AS symbol,
            CAST(floor(log10({column}) * {bins_per_decade}) AS INTEGER)
                              AS log_bin,
            COUNT(*)::BIGINT  AS n
        FROM flow
        WHERE {column} IS NOT NULL AND {column} > 0
        GROUP BY 1, 2
        ORDER BY 1, 2
        """
    ).fetchdf()


def _plot_log_hist(
    df: pd.DataFrame,
    *,
    title: str,
    xlabel: str,
    filename: str,
    bins_per_decade: int = 4,
) -> None:
    """Single-row facet plot — one panel per symbol."""
    symbols = [s for s in SYMBOL_ORDER if s in df["symbol"].unique()]
    if not symbols:
        return

    fig, axes = plt.subplots(
        1,
        len(symbols),
        figsize=(3.6 * len(symbols), 3.8),
        sharex=True,
        squeeze=False,
        constrained_layout=True,
    )

    x_min = df["log_bin"].min() / bins_per_decade
    x_max = (df["log_bin"].max() + 1) / bins_per_decade

    for j, sym in enumerate(symbols):
        ax = axes[0][j]
        sub = df[df["symbol"] == sym]
        if not sub.empty:
            xs = sub["log_bin"] / bins_per_decade
            ys = sub["n"].astype(float)
            ax.bar(
                xs,
                ys,
                width=1.0 / bins_per_decade,
                color=COLORS["blue"],
                edgecolor="#222",
                linewidth=0.3,
            )
            ax.set_yscale("log")
        ax.set_xlim(x_min, x_max)
        ax.set_title(sym, color="#fff", fontsize=11)
        ax.set_xlabel(xlabel, fontsize=9)
        if j == 0:
            ax.set_ylabel("count (log scale)", fontsize=9)

    fig.suptitle(title, color="#fff", fontsize=13)
    plt.savefig(PLOT_DIR / filename, dpi=130)
    plt.close(fig)
    print(f"  wrote {(PLOT_DIR / filename).relative_to(ML_ROOT)}")


def q2_premium_distribution(conn: duckdb.DuckDBPyConnection) -> dict:
    subsection("Q2: Premium log-distribution per symbol")
    df = _log_hist_bins(conn, "premium")
    _plot_log_hist(
        df,
        title="Premium distribution — 0DTE, log10($) bins",
        xlabel="log10(premium $)",
        filename="q2_premium_distribution.png",
    )
    return {"n_bins": int(len(df)), "status": "ok"}


def q3_size_distribution(conn: duckdb.DuckDBPyConnection) -> dict:
    subsection("Q3: Size (contract count) log-distribution per symbol")
    df = _log_hist_bins(conn, "size")
    _plot_log_hist(
        df,
        title="Trade size distribution — 0DTE, log10(contracts)",
        xlabel="log10(contracts)",
        filename="q3_size_distribution.png",
    )
    return {"n_bins": int(len(df)), "status": "ok"}


def q4_price_distribution(conn: duckdb.DuckDBPyConnection) -> dict:
    """Per-contract fill price (price × 100 = $ per contract)."""
    subsection("Q4: Per-contract option price log-distribution per symbol")
    df = _log_hist_bins(conn, "price")
    _plot_log_hist(
        df,
        title="Per-contract option price distribution — 0DTE",
        xlabel="log10(price $/share — ×100 for $/contract)",
        filename="q4_price_distribution.png",
    )
    return {"n_bins": int(len(df)), "status": "ok"}


# ── Q5: Prints per minute-of-day ─────────────────────────


def q5_time_of_day(conn: duckdb.DuckDBPyConnection) -> dict:
    subsection("Q5: Prints per minute-of-day (CT) per symbol")
    # executed_at is UTC; CT = UTC - 5 during DST (all rows in the
    # 2026-04 dataset are post-DST start). Regular session: 08:30-15:00 CT
    # = 13:30-20:00 UTC.
    df = conn.execute(
        """
        SELECT
            underlying_symbol AS symbol,
            CAST(
              extract('hour'   FROM executed_at) * 60
            + extract('minute' FROM executed_at)
              AS INTEGER
            ) AS minute_utc,
            COUNT(*)::BIGINT AS n
        FROM flow
        GROUP BY 1, 2
        ORDER BY 1, 2
        """
    ).fetchdf()

    df["minute_ct"] = df["minute_utc"] - 300  # UTC → CT for DST

    symbols = [s for s in SYMBOL_ORDER if s in df["symbol"].unique()]
    fig, axes = plt.subplots(
        len(symbols),
        1,
        figsize=(11, 2.2 * len(symbols)),
        sharex=True,
        constrained_layout=True,
    )
    if len(symbols) == 1:
        axes = [axes]

    for ax, sym in zip(axes, symbols, strict=True):
        sub = df[df["symbol"] == sym].sort_values("minute_ct")
        ax.plot(
            sub["minute_ct"],
            sub["n"],
            color=COLORS["blue"],
            linewidth=1.0,
        )
        ax.axvspan(510, 900, alpha=0.08, color=COLORS["orange"])  # 08:30-15:00 CT
        ax.set_ylabel(f"{sym}\nprints", fontsize=9)
        ax.set_xlim(-120, 1000)

    axes[-1].set_xlabel("minute of day (CT)", fontsize=9)
    fig.suptitle(
        "Prints-per-minute by time of day (CT) — 0DTE. "
        "Orange band = 08:30-15:00 regular session.",
        color="#fff",
        fontsize=12,
    )
    plt.savefig(PLOT_DIR / "q5_time_of_day.png", dpi=130)
    plt.close(fig)
    print(f"  wrote {(PLOT_DIR / 'q5_time_of_day.png').relative_to(ML_ROOT)}")
    return {"n_symbols": len(symbols), "status": "ok"}


# ── Q6: Aggression breakdown ─────────────────────────────


def q6_aggression(conn: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    subsection("Q6: Buy/Mid/Sell aggression breakdown per symbol")
    df = conn.execute(
        """
        SELECT
            underlying_symbol AS symbol,
            aggression_side,
            COUNT(*)::BIGINT  AS n
        FROM flow
        GROUP BY 1, 2
        ORDER BY 1, 2
        """
    ).fetchdf()

    pivot = df.pivot_table(
        index="symbol",
        columns="aggression_side",
        values="n",
        fill_value=0,
    )
    for col in ("buy_aggressive", "mid", "sell_aggressive"):
        if col not in pivot.columns:
            pivot[col] = 0
    totals = pivot.sum(axis=1).replace(0, np.nan)
    pct = pivot.div(totals, axis=0) * 100

    csv_path = PLOT_DIR / "q6_aggression.csv"
    pct.round(2).to_csv(csv_path)
    print(f"  wrote {csv_path.relative_to(ML_ROOT)}")

    symbols = [s for s in SYMBOL_ORDER if s in pct.index]
    if not symbols:
        return pct

    buy = [pct.loc[s, "buy_aggressive"] for s in symbols]
    mid = [pct.loc[s, "mid"] for s in symbols]
    sel = [pct.loc[s, "sell_aggressive"] for s in symbols]

    fig, ax = plt.subplots(figsize=(7.5, 4.5), constrained_layout=True)
    ax.bar(symbols, buy, color=COLORS["buy"], label="buy@ask", edgecolor="#222")
    ax.bar(symbols, mid, bottom=buy, color=COLORS["mid"], label="mid", edgecolor="#222")
    ax.bar(
        symbols,
        sel,
        bottom=np.array(buy) + np.array(mid),
        color=COLORS["sell"],
        label="sell@bid",
        edgecolor="#222",
    )
    for i in range(len(symbols)):
        ax.text(
            i,
            50,
            f"buy={buy[i]:.1f}%\nsell={sel[i]:.1f}%",
            ha="center",
            va="center",
            color="#fff",
            fontsize=9,
        )
    ax.set_ylim(0, 100)
    ax.set_ylabel("% of prints")
    ax.legend(loc="lower right", fontsize=9, facecolor="#1a1a2e", edgecolor="#555")
    ax.set_title("Aggression breakdown — 0DTE, % of prints", color="#fff")
    plt.savefig(PLOT_DIR / "q6_aggression.png", dpi=130)
    plt.close(fig)
    print(f"  wrote {(PLOT_DIR / 'q6_aggression.png').relative_to(ML_ROOT)}")
    return pct


# ── Main ─────────────────────────────────────────────────


def main() -> int:
    section(f"EOD Flow Baselines (0DTE) — reading {DATA_GLOB}")

    conn = _connect()
    n_total = conn.execute("SELECT COUNT(*) FROM flow").fetchone()[0]
    n_days = conn.execute(
        "SELECT COUNT(DISTINCT CAST(executed_at AS DATE)) FROM flow"
    ).fetchone()[0]
    # Sanity-check that the ingest actually filtered to 0DTE.
    dte_range = conn.execute(
        "SELECT MIN(dte), MAX(dte) FROM flow WHERE dte IS NOT NULL"
    ).fetchone()
    print(
        f"  rows = {n_total:,}   days = {n_days}   "
        f"dte range = [{dte_range[0]}, {dte_range[1]}]"
    )

    q1 = q1_percentile_table(conn)
    q2 = q2_premium_distribution(conn)
    q3 = q3_size_distribution(conn)
    q4 = q4_price_distribution(conn)
    q5 = q5_time_of_day(conn)
    q6_pct = q6_aggression(conn)
    conn.close()

    spxw = q1[q1["symbol"] == "SPXW"]
    if not spxw.empty:
        row = spxw.iloc[0]
        takeaway(
            "SPXW 0DTE — "
            f"n={row['n']:,}, "
            f"median ${row['prem_p50']:,.0f}, "
            f"p99 ${row['prem_p99']:,.0f}, "
            f"p99.9 ${row['prem_p999']:,.0f}, "
            f"max ${row['prem_max']:,.0f}"
        )

    findings = {
        "n_rows_total": int(n_total),
        "n_days": int(n_days),
        "dte_range": {"min": int(dte_range[0]), "max": int(dte_range[1])},
        "percentiles": q1.to_dict(orient="records"),
        "q2_premium_hist": q2,
        "q3_size_hist": q3,
        "q4_price_hist": q4,
        "q5_time_of_day": q5,
        "aggression_pct": q6_pct.round(2).reset_index().to_dict(orient="records"),
    }
    save_section_findings("eod_flow_baselines", findings)
    print(
        f"\nDone. Plots + CSVs in {PLOT_DIR.relative_to(ML_ROOT)}; "
        "summary in ml/findings.json."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
