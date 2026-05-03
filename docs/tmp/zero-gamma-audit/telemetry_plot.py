"""
1-2 week telemetry on zero_gamma_levels.netγ@spot per ticker.

Settles whether the methodology is structurally biased (sign never
flips ⇒ Concern 2 from AUDIT_FINDINGS.md is real) or healthy (sign
flips between regimes ⇒ Concern 2 is not a bug).

Usage:
    python docs/tmp/zero-gamma-audit/telemetry_plot.py

Requires DATABASE_URL in env. Uses ml/.venv (matplotlib + psycopg2)
plus python-dotenv from PIP. If psycopg2 isn't installed, swap to
the @neondatabase/serverless TS path — but for one-off telemetry
psycopg2 is the simplest tool.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone

import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import psycopg2

DB_URL = os.environ.get("DATABASE_URL")
if not DB_URL:
    print("DATABASE_URL missing", file=sys.stderr)
    sys.exit(1)

TICKERS = ["SPX", "SPY", "QQQ", "NDX"]


def fetch_series(conn, ticker: str):
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT ts, spot::numeric, zero_gamma::numeric,
                   confidence::numeric, net_gamma_at_spot::numeric
            FROM zero_gamma_levels
            WHERE ticker = %s
              AND ts > now() - interval '14 days'
            ORDER BY ts ASC
            """,
            (ticker,),
        )
        return cur.fetchall()


def main() -> None:
    conn = psycopg2.connect(DB_URL)

    fig, axes = plt.subplots(
        len(TICKERS), 1, figsize=(13, 11), sharex=True
    )
    plt.style.use("dark_background")

    summary_rows: list[dict] = []

    for ax, ticker in zip(axes, TICKERS):
        rows = fetch_series(conn, ticker)
        if not rows:
            ax.text(
                0.5, 0.5,
                f"{ticker}: no rows in last 14 days",
                ha="center", va="center",
                transform=ax.transAxes,
                color="#888",
            )
            continue

        ts = [r[0] for r in rows]
        netg = [float(r[4]) if r[4] is not None else None for r in rows]
        zg = [float(r[2]) if r[2] is not None else None for r in rows]
        spots = [float(r[1]) for r in rows]

        # Two‑axis: netγ@spot (left, log-ish) and Δ%-spot/zero (right)
        ax.set_facecolor("#0a0a0a")
        ax.axhline(0, color="#fbbf24", linewidth=0.7, linestyle="--", alpha=0.6)

        # Color points by sign
        for t, v in zip(ts, netg):
            if v is None:
                continue
            color = "#34d399" if v > 0 else "#f87171"
            ax.plot(
                t, v, marker="o", markersize=2.5, color=color,
            )

        # Plot trajectory line in light grey
        ax.plot(ts, netg, color="#94a3b8", linewidth=0.8, alpha=0.5)

        ax.set_ylabel(f"{ticker}\nnetγ@spot", fontsize=10)
        ax.grid(True, alpha=0.15)
        ax.tick_params(axis="x", labelrotation=0)

        # Compute the audit numbers: sign-flip count, % positive
        n = sum(1 for v in netg if v is not None)
        pos = sum(1 for v in netg if v is not None and v > 0)
        neg = sum(1 for v in netg if v is not None and v < 0)
        zero = sum(1 for v in netg if v is not None and v == 0)
        flips = 0
        prev = None
        for v in netg:
            if v is None:
                continue
            if prev is not None and (prev > 0) != (v > 0) and prev != 0 and v != 0:
                flips += 1
            prev = v

        # Compute zero-gamma distance distribution
        zg_distances = [
            (z - s) / s * 100
            for z, s in zip(zg, spots)
            if z is not None and s
        ]

        summary_rows.append({
            "ticker": ticker,
            "rows": n,
            "positive": pos,
            "negative": neg,
            "zero": zero,
            "sign_flips": flips,
            "first_ts": ts[0].isoformat(),
            "last_ts": ts[-1].isoformat(),
            "zg_dist_min_pct": min(zg_distances) if zg_distances else None,
            "zg_dist_max_pct": max(zg_distances) if zg_distances else None,
            "zg_dist_avg_pct": (
                sum(zg_distances) / len(zg_distances)
                if zg_distances else None
            ),
        })

        ax.set_title(
            f"{ticker} — {n} rows, {pos} positive ({100 * pos / n:.0f}%), "
            f"{neg} negative ({100 * neg / n:.0f}%), {flips} sign-flips",
            fontsize=10, loc="left",
        )

    axes[-1].xaxis.set_major_formatter(
        mdates.DateFormatter("%m-%d %H:%M", tz=timezone.utc)
    )
    fig.suptitle(
        "zero_gamma_levels.net_gamma_at_spot trajectory — last 14 days",
        fontsize=13,
    )
    plt.tight_layout()

    out_path = (
        "/Users/charlesobrien/Documents/Workspace/strike-calculator/"
        "docs/tmp/zero-gamma-audit/netgamma_trajectory.png"
    )
    plt.savefig(out_path, dpi=140, facecolor="#0a0a0a")
    print(f"\nSaved plot: {out_path}\n")

    print("=== Summary ===")
    print(f"{'ticker':6} {'rows':>5} {'pos':>5} {'neg':>5} "
          f"{'zero':>5} {'flips':>6} "
          f"{'zg_dist_min%':>12} {'zg_dist_avg%':>12} {'zg_dist_max%':>12}")
    for r in summary_rows:
        print(
            f"{r['ticker']:6} "
            f"{r['rows']:>5} {r['positive']:>5} {r['negative']:>5} "
            f"{r['zero']:>5} {r['sign_flips']:>6} "
            f"{r['zg_dist_min_pct']:>11.2f}% "
            f"{r['zg_dist_avg_pct']:>11.2f}% "
            f"{r['zg_dist_max_pct']:>11.2f}%"
        )

    print("\n=== Window ===")
    if summary_rows:
        print(f"  first: {summary_rows[0]['first_ts']}")
        print(f"  last:  {summary_rows[0]['last_ts']}")

    conn.close()


if __name__ == "__main__":
    main()
