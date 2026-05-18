"""SB 93-day Pass B re-run with PEAK metric.

The original Pass B (sb-93d-hypothesis-pass-b-2026-05-17.py) ran H1,
H2, H4, H5, H6 against the trail-30/10 exit-policy win definition.
H1 (local-window silence) has already been peak-revisited and morphed
into Phase A's pre_trade_count feature. This script re-runs H2/H4/H5/
H6 with peak_ceiling_pct ≥ 50% (the project's existing high-peak
convention, baseline ~16.2% on the 93-day dataset) to surface
whether any of them flip under the peak metric the way TOD/DOW did.

  H2  Block arrival cadence — within the 5-min spike bucket, what
      fraction of size landed in the first 60 seconds vs spread.
  H4  First-trade-of-session flag — was this the chain's first
      print of the day?
  H5  NBBO spread evolution — mean spread within the spike bucket
      AND in the 5-min pre-window. Did MMs widen at the moment of
      the fire?
  H6  Underlying drift confirmation — for each alert, did the
      underlying move in the predicted direction (calls=up, puts=
      down) within 15 min of the fire?

Reads Eod-Full-Tape-parquet/ for 93 days. Slow — expect 30-60 min
total wall-clock. Output saved alongside the script.

Run:
    ml/.venv/bin/python docs/tmp/sb-93d-pass-b-peak-2026-05-17.py \
        2>&1 | tee docs/tmp/sb-93d-pass-b-peak-output.txt
"""

from __future__ import annotations

import sys
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import psycopg2

REPO_ROOT = Path(__file__).resolve().parents[2]
PARQUET_DIR = Path.home() / "Desktop" / "Eod-Full-Tape-parquet"


def load_env() -> str:
    env = REPO_ROOT / ".env.local"
    for line in env.read_text().splitlines():
        line = line.strip()
        if line.startswith("DATABASE_URL="):
            return line.split("=", 1)[1].strip('"').strip("'")
    sys.exit("DATABASE_URL not in .env.local")


def fetch_enriched_sb(conn) -> pd.DataFrame:
    return pd.read_sql(
        """
        SELECT id, date::text AS date, bucket_ct,
               option_chain_id, underlying_symbol,
               option_type, strike, dte, entry_price,
               peak_ceiling_pct
          FROM silent_boom_alerts
         WHERE peak_ceiling_pct IS NOT NULL
        """,
        conn,
    )


def compute_day_features(
    duck: duckdb.DuckDBPyConnection, date_str: str, day_alerts: pd.DataFrame,
) -> pd.DataFrame:
    """For one date, compute all per-alert features from the parquet
    in a single set of joins. Returns a frame keyed by alert id.
    Mirrors the original Pass B feature query but skips H1's
    silence_min and chain_first_trade (covered elsewhere now).
    """
    path = PARQUET_DIR / f"{date_str}-fulltape.parquet"
    if not path.exists():
        return pd.DataFrame()

    duck.register("alerts", day_alerts)
    sql = f"""
        WITH t AS (
          SELECT
            option_chain_id,
            underlying_symbol,
            executed_at,
            size,
            price,
            nbbo_bid,
            nbbo_ask,
            underlying_price
          FROM read_parquet('{path}')
          WHERE canceled = false AND price > 0
        ),
        per_alert AS (
          SELECT
            a.id AS alert_id,
            a.bucket_ct AS bucket_ts,
            a.option_type AS opt_type,
            a.underlying_symbol AS ticker,
            a.option_chain_id AS chain,
            -- H4: chain's earliest trade today
            MIN(t.executed_at) AS chain_first_trade,
            -- H2: in-bucket cadence — first-60s share of size
            SUM(t.size) FILTER (
              WHERE t.executed_at >= a.bucket_ct
                AND t.executed_at < a.bucket_ct + INTERVAL '1 minute'
            )::DOUBLE
            / NULLIF(SUM(t.size) FILTER (
              WHERE t.executed_at >= a.bucket_ct
                AND t.executed_at < a.bucket_ct + INTERVAL '5 minutes'
            ), 0) AS first_min_share,
            -- H5: NBBO spread inside vs before bucket
            AVG(
              (t.nbbo_ask - t.nbbo_bid)
              / NULLIF((t.nbbo_ask + t.nbbo_bid) / 2, 0)
            ) FILTER (
              WHERE t.executed_at >= a.bucket_ct - INTERVAL '5 minutes'
                AND t.executed_at < a.bucket_ct
                AND t.nbbo_ask IS NOT NULL AND t.nbbo_bid IS NOT NULL
            ) AS spread_pre,
            AVG(
              (t.nbbo_ask - t.nbbo_bid)
              / NULLIF((t.nbbo_ask + t.nbbo_bid) / 2, 0)
            ) FILTER (
              WHERE t.executed_at >= a.bucket_ct
                AND t.executed_at < a.bucket_ct + INTERVAL '5 minutes'
                AND t.nbbo_ask IS NOT NULL AND t.nbbo_bid IS NOT NULL
            ) AS spread_in,
            -- H6: underlying at bucket vs +15min
            (ARRAY_AGG(t.underlying_price ORDER BY t.executed_at DESC)
              FILTER (
                WHERE t.executed_at >= a.bucket_ct - INTERVAL '2 minutes'
                  AND t.executed_at < a.bucket_ct + INTERVAL '2 minutes'
                  AND t.underlying_price IS NOT NULL
              ))[1] AS underlying_at_fire
          FROM alerts a
          LEFT JOIN t
            ON t.option_chain_id = a.option_chain_id
           AND t.executed_at >= a.bucket_ct - INTERVAL '5 minutes'
           AND t.executed_at <= a.bucket_ct + INTERVAL '5 minutes'
          GROUP BY a.id, a.bucket_ct, a.option_type,
                   a.underlying_symbol, a.option_chain_id
        ),
        chain_underlying AS (
          -- H6: pull underlying at T+15 via ANY trade on the same
          -- ticker (not just the alert's chain) for higher density.
          SELECT
            a.id AS alert_id,
            (ARRAY_AGG(t.underlying_price ORDER BY t.executed_at DESC)
              FILTER (
                WHERE t.executed_at >= a.bucket_ct + INTERVAL '13 minutes'
                  AND t.executed_at < a.bucket_ct + INTERVAL '17 minutes'
                  AND t.underlying_price IS NOT NULL
              ))[1] AS ticker_underlying_at_fire_plus_15
          FROM alerts a
          LEFT JOIN t
            ON t.underlying_symbol = a.underlying_symbol
           AND t.executed_at >= a.bucket_ct + INTERVAL '13 minutes'
           AND t.executed_at < a.bucket_ct + INTERVAL '17 minutes'
          GROUP BY a.id
        )
        SELECT
          p.*,
          cu.ticker_underlying_at_fire_plus_15
        FROM per_alert p
        LEFT JOIN chain_underlying cu ON cu.alert_id = p.alert_id
    """
    out = duck.execute(sql).df()
    duck.unregister("alerts")
    return out


def report_by_bucket(df: pd.DataFrame, bucket_col: str, label: str) -> None:
    """Report peak-based win rates at 3 thresholds per bucket."""
    base25 = df["peak_ge_25"].mean() * 100
    base50 = df["peak_ge_50"].mean() * 100
    base100 = df["peak_ge_100"].mean() * 100
    print(
        f"\n[{label}]  baselines: ≥25%={base25:.1f}%  "
        f"≥50%={base50:.1f}%  ≥100%={base100:.1f}%  "
        f"(n={len(df):,})"
    )
    grp = df.groupby(bucket_col, observed=True).agg(
        n=("peak_ge_50", "size"),
        peak_ge_25_pct=("peak_ge_25", lambda s: round(s.mean() * 100, 1)),
        peak_ge_50_pct=("peak_ge_50", lambda s: round(s.mean() * 100, 1)),
        peak_ge_100_pct=("peak_ge_100", lambda s: round(s.mean() * 100, 1)),
        median_peak=("peak_ceiling_pct", lambda s: round(s.median(), 1)),
    ).reset_index()
    grp["lift50_pp"] = (grp["peak_ge_50_pct"] - base50).round(1)
    print(grp.to_string(index=False))


def main() -> None:
    print("Loading SB alerts with peak data...")
    with psycopg2.connect(load_env()) as conn:
        sb = fetch_enriched_sb(conn)
    sb["bucket_ct"] = pd.to_datetime(sb["bucket_ct"], utc=True)
    sb["peak_ge_25"] = (sb["peak_ceiling_pct"] >= 25).astype(int)
    sb["peak_ge_50"] = (sb["peak_ceiling_pct"] >= 50).astype(int)
    sb["peak_ge_100"] = (sb["peak_ceiling_pct"] >= 100).astype(int)
    print(f"  {len(sb):,} alerts across {sb['date'].nunique()} dates")
    print(f"  Baseline peak ≥ 25%: {sb['peak_ge_25'].mean() * 100:.1f}%")
    print(f"  Baseline peak ≥ 50%: {sb['peak_ge_50'].mean() * 100:.1f}%")
    print(f"  Baseline peak ≥ 100%: {sb['peak_ge_100'].mean() * 100:.1f}%")

    duck = duckdb.connect(":memory:")
    all_features = []
    dates = sorted(sb["date"].unique())
    print(f"\nScanning {len(dates)} parquet days...")
    for i, date_str in enumerate(dates, 1):
        day_alerts = sb[sb["date"] == date_str][
            ["id", "bucket_ct", "option_chain_id",
             "underlying_symbol", "option_type"]
        ].copy()
        feats = compute_day_features(duck, date_str, day_alerts)
        if not feats.empty:
            all_features.append(feats)
        if i % 5 == 0 or i == len(dates):
            print(f"  [{i}/{len(dates)}] {date_str}  "
                  f"cumulative={sum(len(f) for f in all_features):,}")

    feats = pd.concat(all_features, ignore_index=True)
    merged = sb.merge(
        feats.rename(columns={"alert_id": "id"}),
        on="id", how="inner",
    )
    print(f"\nMerged: {len(merged):,} rows with features + peak outcomes")

    # ====================================================
    # H2 — Block arrival cadence
    # ====================================================
    print("\n" + "=" * 64)
    print("H2 — Block arrival cadence (first-60s share of bucket size)")
    print("=" * 64)
    sub = merged.dropna(subset=["first_min_share"]).copy()
    sub["cadence_bucket"] = pd.cut(
        sub["first_min_share"],
        bins=[-0.01, 0.25, 0.5, 0.75, 1.01],
        labels=["distributed (<25% in min1)",
                "moderate (25-50%)",
                "concentrated (50-75%)",
                "single-block (>75%)"],
    )
    report_by_bucket(sub, "cadence_bucket", "block_cadence")

    # ====================================================
    # H4 — First-trade-of-session
    # ====================================================
    print("\n" + "=" * 64)
    print("H4 — Was this the chain's first trade of the day?")
    print("=" * 64)
    sub = merged.dropna(subset=["chain_first_trade"]).copy()
    sub["chain_first_trade"] = pd.to_datetime(
        sub["chain_first_trade"], utc=True
    )
    delta_min = (
        sub["chain_first_trade"] - sub["bucket_ct"]
    ).dt.total_seconds() / 60
    sub["is_first_trade"] = (delta_min >= -1) & (delta_min <= 5)
    report_by_bucket(sub, "is_first_trade", "first_trade_of_session")

    # ====================================================
    # H5 — NBBO spread evolution
    # ====================================================
    print("\n" + "=" * 64)
    print("H5 — NBBO spread evolution (pre vs in-bucket)")
    print("=" * 64)
    sub = merged.dropna(subset=["spread_pre", "spread_in"]).copy()
    sub["spread_widened"] = sub["spread_in"] > sub["spread_pre"] * 1.2
    report_by_bucket(sub, "spread_widened", "spread_widened (>+20%)")
    # Also break out by absolute spread tightness in-bucket
    sub["spread_quartile"] = pd.qcut(
        sub["spread_in"], q=4, duplicates="drop", labels=False
    )
    print("\nBy in-bucket spread quartile (peak ≥50%):")
    print(sub.groupby("spread_quartile", observed=True).agg(
        n=("peak_ge_50", "size"),
        peak_ge_50_pct=("peak_ge_50", lambda s: round(s.mean() * 100, 1)),
        spread_lo=("spread_in", lambda s: round(s.min(), 4)),
        spread_hi=("spread_in", lambda s: round(s.max(), 4)),
    ).to_string())

    # ====================================================
    # H6 — Underlying drift confirmation
    # ====================================================
    print("\n" + "=" * 64)
    print("H6 — Underlying drift confirmation (T+15min in predicted dir)")
    print("=" * 64)
    sub = merged.dropna(
        subset=["underlying_at_fire", "ticker_underlying_at_fire_plus_15"]
    ).copy()
    sub["pct_move"] = (
        (sub["ticker_underlying_at_fire_plus_15"] - sub["underlying_at_fire"])
        / sub["underlying_at_fire"]
    ) * 100
    sub["confirmed"] = np.where(
        sub["opt_type"] == "C", sub["pct_move"] > 0, sub["pct_move"] < 0
    )
    report_by_bucket(sub, "confirmed", "underlying_15m_confirm")
    print("\nBy pct_move magnitude (signed, in predicted direction):")
    sub["signed_move"] = np.where(
        sub["opt_type"] == "C", sub["pct_move"], -sub["pct_move"]
    )
    sub["move_bucket"] = pd.cut(
        sub["signed_move"],
        bins=[-100, -0.5, -0.1, 0.1, 0.5, 100],
        labels=["<-0.5%", "-0.5 to -0.1%", "flat", "+0.1 to +0.5%", ">+0.5%"],
    )
    report_by_bucket(sub, "move_bucket", "signed_move_bucket")


if __name__ == "__main__":
    main()
