"""
Phase A of the IV-anomaly signal-vs-price study (spec
docs/superpowers/specs/iv-anomaly-ml-signal-vs-price-2026-04-25.md).

Joins each backfill iv_anomalies row with strike_iv_snapshots forward in
time, computing per-alert outcome features that Phase B (backtest) and
Phase C (stratified characterization) consume.

Two separate joins are used because:
  - SPOT trajectory is needed for ITM crossing / finished-ITM
    detection. Spot is the same across all strikes of a ticker at a
    given minute, so we pull the per-ticker-per-minute spot from ANY
    strike's snapshot. This is COMPLETE coverage.
  - PREMIUM trajectory is needed for entry/peak/close pricing. This
    requires the ALERT'S specific strike, which exits the snapshot
    table once it goes ITM (the cron only ingests OTM strikes per
    OTM_RANGE_PCT_*). Premium is therefore SPARSE post-ITM. We use the
    last available premium pre-ITM as a lower-bound for first_itm
    pricing, and intrinsic-at-close for 0DTE hold-to-EOD outcomes.

For 0DTE specifically (the user's primary trading horizon), the
intrinsic-at-close calculation gives an exact settlement value:
  - call: max(spot_close - strike, 0)
  - put: max(strike - spot_close, 0)
This is what 0DTE finishes at, regardless of intraday premium path.

Output:
    ml/data/iv-anomaly-outcomes.parquet — one row per backfill anomaly
    with entry / peak / first-ITM / close / finished-ITM features.

Usage:
    ml/.venv/bin/python ml/extract-iv-anomaly-outcomes.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pandas as pd
import psycopg2

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_LOCAL = REPO_ROOT / ".env.local"
OUT_PATH = REPO_ROOT / "ml" / "data" / "iv-anomaly-outcomes.parquet"


def load_env() -> None:
    if not ENV_LOCAL.exists():
        return
    for line in ENV_LOCAL.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k, v.strip().strip('"'))


def fetch_spot_outcomes(conn) -> pd.DataFrame:
    """Compute per-anomaly spot-trajectory outcomes (ITM crossing, finished-ITM)."""
    sql = """
    WITH anomaly AS (
        SELECT id, ticker, strike, side, expiry, ts AS alert_ts
        FROM iv_anomalies
        WHERE 'backfill' = ANY(flag_reasons)
    ),
    ticker_minute_spot AS (
        -- One spot value per (ticker, ts), independent of which strike
        -- generated the snapshot. spot is the underlying — identical
        -- across strikes for any given minute.
        SELECT ticker, ts, MAX(spot) AS spot
        FROM strike_iv_snapshots
        GROUP BY ticker, ts
    ),
    joined AS (
        SELECT
            a.id AS anomaly_id,
            a.strike, a.side, a.alert_ts,
            s.ts, s.spot,
            CASE
                WHEN a.side = 'call' AND s.spot >= a.strike THEN 1
                WHEN a.side = 'put' AND s.spot <= a.strike THEN 1
                ELSE 0
            END AS is_itm
        FROM anomaly a
        JOIN ticker_minute_spot s ON s.ticker = a.ticker
        WHERE s.ts >= a.alert_ts
          AND s.ts <= (a.expiry::timestamptz + interval '21 hours')
    ),
    itm_first AS (
        SELECT anomaly_id, ts AS first_itm_ts, spot AS first_itm_spot
        FROM (
            SELECT
                anomaly_id, ts, spot,
                ROW_NUMBER() OVER (PARTITION BY anomaly_id ORDER BY ts ASC) AS rn
            FROM joined WHERE is_itm = 1
        ) t WHERE rn = 1
    ),
    last_snap AS (
        SELECT anomaly_id, ts AS close_ts, spot AS close_spot, is_itm AS finished_itm
        FROM (
            SELECT
                anomaly_id, ts, spot, is_itm,
                ROW_NUMBER() OVER (PARTITION BY anomaly_id ORDER BY ts DESC) AS rn
            FROM joined
        ) t WHERE rn = 1
    ),
    sample_counts AS (
        SELECT
            anomaly_id,
            COUNT(*) AS spot_sample_count,
            SUM(is_itm) AS itm_minute_count
        FROM joined GROUP BY anomaly_id
    )
    SELECT
        sc.anomaly_id,
        sc.spot_sample_count,
        sc.itm_minute_count,
        ifit.first_itm_ts,
        ifit.first_itm_spot,
        ls.close_ts,
        ls.close_spot,
        ls.finished_itm
    FROM sample_counts sc
    LEFT JOIN itm_first ifit ON ifit.anomaly_id = sc.anomaly_id
    LEFT JOIN last_snap ls ON ls.anomaly_id = sc.anomaly_id
    """
    print("[query 1/2] spot trajectory + ITM detection...", file=sys.stderr)
    return pd.read_sql_query(sql, conn)


def fetch_premium_outcomes(conn) -> pd.DataFrame:
    """Per-anomaly premium-trajectory outcomes from the ALERT'S strike."""
    sql = """
    WITH anomaly AS (
        SELECT id, ticker, strike, side, expiry, ts AS alert_ts
        FROM iv_anomalies
        WHERE 'backfill' = ANY(flag_reasons)
    ),
    joined AS (
        SELECT
            a.id AS anomaly_id,
            s.ts, s.mid_price, s.iv_mid, s.spot,
            ROW_NUMBER() OVER (PARTITION BY a.id ORDER BY s.ts ASC) AS rn_asc,
            ROW_NUMBER() OVER (PARTITION BY a.id ORDER BY s.ts DESC) AS rn_desc
        FROM anomaly a
        JOIN strike_iv_snapshots s
          ON s.ticker = a.ticker
          AND s.strike = a.strike
          AND s.side = a.side
          AND s.expiry = a.expiry
          AND s.ts >= a.alert_ts
          AND s.ts <= (a.expiry::timestamptz + interval '21 hours')
    )
    SELECT
        anomaly_id,
        COUNT(*) AS premium_sample_count,
        MAX(CASE WHEN rn_asc = 1 THEN mid_price END) AS entry_premium,
        MAX(CASE WHEN rn_asc = 1 THEN iv_mid END) AS entry_iv,
        MAX(CASE WHEN rn_asc = 1 THEN ts END) AS entry_premium_ts,
        MAX(mid_price) AS peak_premium,
        MAX(CASE WHEN rn_desc = 1 THEN mid_price END) AS last_strike_premium,
        MAX(CASE WHEN rn_desc = 1 THEN ts END) AS last_strike_ts
    FROM joined
    GROUP BY anomaly_id
    """
    print("[query 2/2] premium trajectory (alert's specific strike)...", file=sys.stderr)
    return pd.read_sql_query(sql, conn)


def fetch_anomaly_metadata(conn) -> pd.DataFrame:
    sql = """
    SELECT
        id AS anomaly_id, ticker, strike, side, expiry, ts AS alert_ts,
        spot_at_detect, iv_at_detect, skew_delta, z_score, ask_mid_div,
        vol_oi_ratio, side_skew, side_dominant, flag_reasons, flow_phase
    FROM iv_anomalies
    WHERE 'backfill' = ANY(flag_reasons)
    """
    print("[query 0/2] anomaly metadata...", file=sys.stderr)
    return pd.read_sql_query(sql, conn)


def derive_features(df: pd.DataFrame) -> pd.DataFrame:
    """Compute derived features that are easier in pandas than SQL."""
    decimal_cols = [
        "strike", "spot_at_detect", "iv_at_detect",
        "skew_delta", "z_score", "ask_mid_div", "vol_oi_ratio", "side_skew",
        "entry_premium", "entry_iv", "peak_premium", "last_strike_premium",
        "first_itm_spot", "close_spot",
    ]
    for c in decimal_cols:
        df[c] = pd.to_numeric(df[c], errors="coerce")

    df["finished_itm"] = df["finished_itm"].astype("Int64")
    df["spot_sample_count"] = df["spot_sample_count"].astype("Int64")
    df["itm_minute_count"] = df["itm_minute_count"].astype("Int64")
    df["premium_sample_count"] = df["premium_sample_count"].fillna(0).astype("Int64")

    # Time deltas (minutes)
    for ts_col, out_col in [
        ("close_ts", "minutes_to_close"),
        ("first_itm_ts", "minutes_to_first_itm"),
        ("last_strike_ts", "minutes_to_last_strike_snap"),
    ]:
        if ts_col in df.columns:
            df[out_col] = (
                pd.to_datetime(df[ts_col], utc=True)
                - pd.to_datetime(df["alert_ts"], utc=True)
            ).dt.total_seconds() / 60.0

    # 0DTE intrinsic-at-close (settlement value)
    is_call = df["side"] == "call"
    df["intrinsic_at_close"] = 0.0
    df.loc[is_call, "intrinsic_at_close"] = (
        df.loc[is_call, "close_spot"] - df.loc[is_call, "strike"]
    ).clip(lower=0)
    df.loc[~is_call, "intrinsic_at_close"] = (
        df.loc[~is_call, "strike"] - df.loc[~is_call, "close_spot"]
    ).clip(lower=0)

    # Returns based on premium trajectory (sparse for ITM strikes)
    df["peak_premium_pct"] = (df["peak_premium"] - df["entry_premium"]) / df[
        "entry_premium"
    ]
    df["last_premium_pct"] = (df["last_strike_premium"] - df["entry_premium"]) / df[
        "entry_premium"
    ]

    # DTE bucket based on alert_ts vs expiry close (~21:00 UTC)
    df["expiry_close_dt"] = pd.to_datetime(df["expiry"], utc=True) + pd.Timedelta(
        hours=21
    )
    df["alert_dt"] = pd.to_datetime(df["alert_ts"], utc=True)
    df["dte_hours"] = (
        df["expiry_close_dt"] - df["alert_dt"]
    ).dt.total_seconds() / 3600.0
    df["dte_bucket"] = pd.cut(
        df["dte_hours"],
        bins=[-0.01, 12, 7 * 24, 14 * 24, 365 * 24],
        labels=["0DTE", "1-7DTE", "8-14DTE", "15+DTE"],
    )

    # OTM distance
    df["otm_distance_pct"] = (df["strike"] - df["spot_at_detect"]) / df[
        "spot_at_detect"
    ]
    df["otm_abs_pct"] = df["otm_distance_pct"].abs()

    # CT minute-of-day
    df["ct_minute"] = (
        df["alert_dt"].dt.tz_convert("US/Central").dt.hour * 60
        + df["alert_dt"].dt.tz_convert("US/Central").dt.minute
    )
    df["session_phase"] = pd.cut(
        df["ct_minute"],
        bins=[0, 540, 720, 900, 1440],
        labels=["pre_open", "morning", "midday", "afternoon"],
    )

    # Signal stack count (subtract 'backfill' tag)
    df["signal_count"] = df["flag_reasons"].apply(
        lambda r: max(0, len([x for x in r if x != "backfill"]))
        if isinstance(r, list)
        else 0
    )

    # Touched ITM at any point (spot trajectory is complete)
    df["touched_itm"] = (df["itm_minute_count"].fillna(0) > 0).astype(int)

    return df


def main() -> None:
    load_env()
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        raise RuntimeError("DATABASE_URL not set; check .env.local")

    with psycopg2.connect(db_url) as conn:
        meta = fetch_anomaly_metadata(conn)
        spot = fetch_spot_outcomes(conn)
        premium = fetch_premium_outcomes(conn)

    print(
        f"[merge] meta={len(meta)}  spot={len(spot)}  premium={len(premium)}",
        file=sys.stderr,
    )
    df = meta.merge(spot, on="anomaly_id", how="left").merge(
        premium, on="anomaly_id", how="left"
    )

    print("[derive] computing per-alert features...", file=sys.stderr)
    df = derive_features(df)

    # Summary
    print("\n=== Coverage by ticker ===", file=sys.stderr)
    print(
        df.groupby("ticker")
        .agg(
            n=("anomaly_id", "count"),
            mean_spot_samples=("spot_sample_count", "mean"),
            mean_prem_samples=("premium_sample_count", "mean"),
            touched_itm_pct=("touched_itm", lambda s: 100 * s.mean()),
            finished_itm_pct=("finished_itm", lambda s: 100 * s.mean()),
        )
        .round(1),
        file=sys.stderr,
    )

    print("\n=== DTE distribution ===", file=sys.stderr)
    print(df["dte_bucket"].value_counts(), file=sys.stderr)

    print("\n=== Touched ITM by ticker (raw counts) ===", file=sys.stderr)
    print(df.groupby("ticker")["touched_itm"].agg(["sum", "count"]), file=sys.stderr)

    df.to_parquet(OUT_PATH, index=False)
    print(
        f"\n[done] wrote {len(df)} rows to {OUT_PATH} "
        f"({OUT_PATH.stat().st_size / 1024:.1f} KB)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
